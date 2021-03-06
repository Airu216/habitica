import moment from 'moment';
import common from '../../../common';
import Bluebird from 'bluebird';
import {
  chatDefaults,
  TAVERN_ID,
} from '../group';
import { defaults, map, flatten, flow, compact, uniq, partialRight } from 'lodash';
import { model as UserNotification } from '../userNotification';
import schema from './schema';
import payments from '../../libs/payments';
import amazonPayments from '../../libs/amazonPayments';
import stripePayments from '../../libs/stripePayments';
import paypalPayments from '../../libs/paypalPayments';

schema.methods.isSubscribed = function isSubscribed () {
  let now = new Date();
  let plan = this.purchased.plan;

  return plan && plan.customerId && (!plan.dateTerminated || moment(plan.dateTerminated).isAfter(now));
};

schema.methods.hasNotCancelled = function hasNotCancelled () {
  let plan = this.purchased.plan;
  return this.isSubscribed() && !plan.dateTerminated;
};

// Get an array of groups ids the user is member of
schema.methods.getGroups = function getUserGroups () {
  let userGroups = this.guilds.slice(0); // clone user.guilds so we don't modify the original
  if (this.party._id) userGroups.push(this.party._id);
  userGroups.push(TAVERN_ID);
  return userGroups;
};

/* eslint-disable no-unused-vars */ // The checks below all get access to sndr and rcvr, but not all use both
const INTERACTION_CHECKS = Object.freeze({
  always: [
    // Revoked chat privileges block all interactions to prevent the evading of harassment protections
    // See issue #7971 for some discussion
    (sndr, rcvr) => sndr.flags.chatRevoked && 'chatPrivilegesRevoked',

    // Direct user blocks prevent all interactions
    (sndr, rcvr) => rcvr.inbox.blocks.includes(sndr._id) && 'notAuthorizedToSendMessageToThisUser',
    (sndr, rcvr) => sndr.inbox.blocks.includes(rcvr._id) && 'notAuthorizedToSendMessageToThisUser',
  ],

  'send-private-message': [
    // Private messaging has an opt-out, which does not affect other interactions
    (sndr, rcvr) => rcvr.inbox.optOut && 'notAuthorizedToSendMessageToThisUser',

    // We allow a player to message themselves so they can test how PMs work or send their own notes to themselves
  ],

  'transfer-gems': [
    // Unlike private messages, gems can't be sent to oneself
    (sndr, rcvr) => rcvr._id === sndr._id && 'cannotSendGemsToYourself',
  ],
});
/* eslint-enable no-unused-vars */

export const KNOWN_INTERACTIONS = Object.freeze(Object.keys(INTERACTION_CHECKS).filter(key => key !== 'always'));

// Get an array of error message keys that would be thrown if the given interaction was attempted
schema.methods.getObjectionsToInteraction = function getObjectionsToInteraction (interaction, receiver) {
  if (!KNOWN_INTERACTIONS.includes(interaction)) {
    throw new Error(`Unknown kind of interaction: "${interaction}", expected one of ${KNOWN_INTERACTIONS.join(', ')}`);
  }

  let sender = this;
  let checks = [
    INTERACTION_CHECKS.always,
    INTERACTION_CHECKS[interaction],
  ];

  let executeChecks = partialRight(map, (check) => check(sender, receiver));

  return flow(
    flatten,
    executeChecks,
    compact, // Remove passed checks (passed checks return falsy; failed checks return message keys)
    uniq
  )(checks);
};


/**
 * Sends a message to a user. Archives a copy in sender's inbox.
 *
 * @param  userToReceiveMessage  The receiver
 * @param  options
 * @param  options.receiverMsg   The message to send to the receiver
 * @param  options.senderMsg     The message to archive instead of receiverMsg
 * @return N/A
 */
schema.methods.sendMessage = async function sendMessage (userToReceiveMessage, options) {
  let sender = this;
  let senderMsg = options.senderMsg || options.receiverMsg;

  common.refPush(userToReceiveMessage.inbox.messages, chatDefaults(options.receiverMsg, sender));
  userToReceiveMessage.inbox.newMessages++;
  userToReceiveMessage._v++;
  userToReceiveMessage.markModified('inbox.messages');

  common.refPush(sender.inbox.messages, defaults({sent: true}, chatDefaults(senderMsg, userToReceiveMessage)));
  sender.markModified('inbox.messages');

  let promises = [userToReceiveMessage.save(), sender.save()];
  await Bluebird.all(promises);
};

/**
 * Creates a notification based on the input parameters and adds it to the local user notifications array.
 * This does not save the notification to the database or interact with the database in any way.
 *
 * @param  type  The type of notification to add to the user. Possible values are defined in the UserNotificaiton Schema
 * @param  data  The data to add to the notification
 */
schema.methods.addNotification = function addUserNotification (type, data = {}) {
  this.notifications.push({
    type,
    data,
  });
};

/**
 * Creates a notification based on the type and data input parameters and saves that new notification
 * to the database directly using an update statement. The local copy of these users are not updated by
 * this operation. Use this function when you want to add a notification to a user(s), but do not have
 * the user document(s) opened.
 *
 * @param  query A Mongoose query defining the users to add the notification to.
 * @param  type  The type of notification to add to the user. Possible values are defined in the UserNotificaiton Schema
 * @param  data  The data to add to the notification
 */
schema.statics.pushNotification = async function pushNotification (query, type, data = {}) {
  let newNotification = new UserNotification({type, data});
  let validationResult = newNotification.validateSync();
  if (validationResult) {
    throw validationResult;
  }
  await this.update(query, {$push: {notifications: newNotification}}, {multi: true}).exec();
};

// Add stats.toNextLevel, stats.maxMP and stats.maxHealth
// to a JSONified User stats object
schema.methods.addComputedStatsToJSONObj = function addComputedStatsToUserJSONObj (statsObject) {
  // NOTE: if an item is manually added to user.stats then
  // common/fns/predictableRandom must be tweaked so the new item is not considered.
  // Otherwise the client will have it while the server won't and the results will be different.
  statsObject.toNextLevel = common.tnl(this.stats.lvl);
  statsObject.maxHealth = common.maxHealth;
  statsObject.maxMP = common.statsComputed(this).maxMP;

  return statsObject;
};

// @TODO: There is currently a three way relation between the user, payment methods and the payment helper
// This creates some odd Dependency Injection issues. To counter that, we use the user as the third layer
// To negotiate between the payment providers and the payment helper (which probably has too many responsiblities)
// In summary, currently is is best practice to use this method to cancel a user subscription, rather than calling the
// payment helper.
schema.methods.cancelSubscription = async function cancelSubscription () {
  let plan = this.purchased.plan;

  if (plan.paymentMethod === amazonPayments.constants.PAYMENT_METHOD) {
    return await amazonPayments.cancelSubscription({user: this});
  } else if (plan.paymentMethod === stripePayments.constants.PAYMENT_METHOD) {
    return await stripePayments.cancelSubscription({user: this});
  } else if (plan.paymentMethod === paypalPayments.constants.PAYMENT_METHOD) {
    return await paypalPayments.subscribeCancel({user: this});
  }

  return await payments.cancelSubscription({user: this});
};
