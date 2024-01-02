import { Telegraf, session, Context } from 'telegraf';
import { I18n, I18nContext } from '@grammyjs/i18n';
import { Message } from 'typegram'
import { UserDocument } from '../models/user'
import { FilterQuery } from 'mongoose';

const { limit } = require('@grammyjs/ratelimiter');
const schedule = require('node-schedule');
const {
  Order,
  User,
  PendingPayment,
  Community,
  Dispute,
  Config,
} = require('../models');
const { getCurrenciesWithPrice, deleteOrderFromChannel } = require('../util');
const {
  commandArgsMiddleware,
  stageMiddleware,
  userMiddleware,
  adminMiddleware,
  superAdminMiddleware,
} = require('./middleware');
const ordersActions = require('./ordersActions');
const CommunityModule = require('./modules/community');
const LanguageModule = require('./modules/language');
const NostrModule = require('./modules/nostr');
const OrdersModule = require('./modules/orders');
const UserModule = require('./modules/user');
const DisputeModule = require('./modules/dispute');
const {
  rateUser,
  cancelAddInvoice,
  addInvoice,
  cancelShowHoldInvoice,
  showHoldInvoice,
  waitPayment,
  addInvoicePHI,
  cancelOrder,
  fiatSent,
  release,
} = require('./commands');
const {
  settleHoldInvoice,
  cancelHoldInvoice,
  payToBuyer,
  isPendingPayment,
  subscribeInvoice,
  getInvoice,
} = require('../ln');
const {
  validateUser,
  validateParams,
  validateObjectId,
  validateInvoice,
  validateLightningAddress,
} = require('./validations');
const messages = require('./messages');
const {
  attemptPendingPayments,
  cancelOrders,
  deleteOrders,
  calculateEarnings,
  attemptCommunitiesPendingPayments,
  deleteCommunity,
  nodeInfo,
} = require('../jobs');
const logger = require('../logger');

export interface MainContext extends Context {
  match: Array<string> | null;
  i18n: I18nContext;
  user: UserDocument;
  admin: UserDocument;
}

interface OrderQuery {
  status?: string;
  buyer_id?: string;
  seller_id?: string;
}

const askForConfirmation = async (user: UserDocument, command: string) => {
  try {
    if (command === '/cancel') {
      const where: FilterQuery<OrderQuery> = {
        $and: [
          { $or: [{ buyer_id: user._id }, { seller_id: user._id }] },
          {
            $or: [
              { status: 'ACTIVE' },
              { status: 'PENDING' },
              { status: 'FIAT_SENT' },
              { status: 'DISPUTE' },
            ],
          },
        ]
      };
      const orders = await Order.find(where);
      return orders;
    } else if (command === '/fiatsent') {
      const where: FilterQuery<OrderQuery> = {
        $and: [{ buyer_id: user._id }, { status: 'ACTIVE' }]
      };
      const orders = await Order.find(where);
      return orders;
    } else if (command === '/release') {
      const where: FilterQuery<OrderQuery> = {
        $and: [
          { seller_id: user._id },
          {
            $or: [
              { status: 'ACTIVE' },
              { status: 'FIAT_SENT' },
              { status: 'DISPUTE' },
            ],
          },
        ]
      };
      const orders = await Order.find(where);
      return orders;
    }

    return [];
  } catch (error) {
    logger.error(error);
  }
};

/*
ctx.update doesn't initially contain message field and it might be
added to the ctx.update in specific conditions. Therefore we need
to check the existence of message in ctx.update. ctx.update.message.text
has the same condition.

The problem mentioned above is similar to this issue:
https://github.com/telegraf/telegraf/issues/1319#issuecomment-766360594
*/
const ctxUpdateAssertMsg = "ctx.update.message.text is not available.";

const initialize = (botToken: string, options: Partial<Telegraf.Options<MainContext>>): Telegraf<MainContext> => {
  const i18n = new I18n({
    defaultLanguageOnMissing: true, // implies allowMissing = true
    directory: 'locales',
    useSession: true,
  });

  const bot = new Telegraf<MainContext>(botToken, options);
  bot.catch(err => {
    logger.error(err);
  });

  bot.use(session());
  bot.use(limit());
  bot.use(i18n.middleware());
  bot.use(stageMiddleware());
  bot.use(commandArgsMiddleware());

  // We schedule pending payments job
  schedule.scheduleJob(
    `*/${process.env.PENDING_PAYMENT_WINDOW} * * * *`,
    async (): Promise<void> => {
      await attemptPendingPayments(bot);
    }
  );

  schedule.scheduleJob(`30 * * * * *`, async () => {
    await cancelOrders(bot);
  });

  schedule.scheduleJob(`25 * * * *`, async () => {
    await deleteOrders(bot);
  });

  schedule.scheduleJob(`*/10 * * * *`, async () => {
    await calculateEarnings();
  });

  schedule.scheduleJob(`*/5 * * * *`, async (): Promise<void> => {
    await attemptCommunitiesPendingPayments(bot);
  });

  schedule.scheduleJob(`33 0 * * *`, async () => {
    await deleteCommunity(bot);
  });

  schedule.scheduleJob(`* * * * *`, async () => {
    await nodeInfo(bot);
  });

  bot.start(async (ctx: MainContext) => {
    try {
      if (!('message' in ctx.update) || !('text' in ctx.update.message)){
        throw new Error(ctxUpdateAssertMsg);
      }
      const tgUser = ctx.update.message.from;
      if (!tgUser.username) return await messages.nonHandleErrorMessage(ctx);

      messages.startMessage(ctx);
      await validateUser(ctx, true);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('maintenance', superAdminMiddleware, async (ctx: MainContext): Promise<void> => {
    try {
      const [val] = await validateParams(ctx, 2, '\\<_on/off_\\>');
      if (!val) return;
      let config = await Config.findOne();
      if (!config) {
        config = new Config();
      }
      config.maintenance = false;
      if (val == 'on') {
        config.maintenance = true;
      }
      await config.save();
      await ctx.reply(ctx.i18n.t('operation_successful'));
    } catch (error) {
      logger.error(error);
    }
  });

  bot.on('text', userMiddleware, async (ctx: MainContext, next: () => void) => {
    try {
      const config = await Config.findOne({ maintenance: true });
      if (config) {
        await ctx.reply(ctx.i18n.t('maintenance'));
      } else {
        next();
      }
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('version', async (ctx: MainContext) => {
    try {
      const pckg = require('../package.json');
      await ctx.reply(pckg.version);
    } catch (err) {
      logger.error(err);
    }
  });

  UserModule.configure(bot);
  NostrModule.configure(bot);
  CommunityModule.configure(bot);
  LanguageModule.configure(bot);

  bot.command('release', userMiddleware, async ctx => {
    try {
      if (!('message' in ctx.update) || !('text' in ctx.update.message)){
        throw new Error(ctxUpdateAssertMsg);
      }
      const params = ctx.update.message.text.split(' ');
      const [command, orderId] = params.filter((el) => el);

      if (!orderId) {
        const orders = await askForConfirmation(ctx.user, command);
        if (!orders.length) return await ctx.reply(`${command} <order Id>`);

        return await messages.showConfirmationButtons(ctx, orders, command);
      } else if (!(await validateObjectId(ctx, orderId))) {
        return;
      } else {
        await release(ctx, orderId, ctx.user);
      }
    } catch (error) {
      logger.error(error);
    }
  });

  DisputeModule.configure(bot);

  bot.command('freezeorder', adminMiddleware, async (ctx: MainContext) => {
    try {
      const [orderId] = await validateParams(ctx, 2, '\\<_order id_\\>');

      if (!orderId) return;
      if (!(await validateObjectId(ctx, orderId))) return;

      const order = await Order.findOne({ _id: orderId });

      if (!order) return;

      // We check if this is a solver, the order must be from the same community
      if (!ctx.admin.admin) {
        if (!order.community_id) {
          return await messages.notAuthorized(ctx);
        }

        if (order.community_id != ctx.admin.default_community_id) {
          return await messages.notAuthorized(ctx);
        }
      }

      order.is_frozen = true;
      order.status = 'FROZEN';
      order.action_by = ctx.admin._id;
      await order.save();

      if (order.secret) await settleHoldInvoice({ secret: order.secret });

      await ctx.reply(ctx.i18n.t('order_frozen'));
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('cancelorder', adminMiddleware, async (ctx: MainContext) => {
    try {
      const [orderId] = await validateParams(ctx, 2, '\\<_order id_\\>');

      if (!orderId) return;
      if (!(await validateObjectId(ctx, orderId))) return;
      const order = await Order.findOne({ _id: orderId });

      if (!order) return;

      // We look for a dispute for this order
      const dispute = await Dispute.findOne({ order_id: order._id });

      // We check if this is a solver, the order must be from the same community
      if (!ctx.admin.admin) {
        if (!order.community_id) {
          logger.debug(
            `cancelorder ${order._id}: The order is not in a community`
          );
          return await messages.notAuthorized(ctx);
        }

        if (order.community_id != ctx.admin.default_community_id) {
          logger.debug(
            `cancelorder ${order._id}: The community and the default user community are not the same`
          );
          return await messages.notAuthorized(ctx);
        }

        // We check if this dispute is from a community we validate that
        // the solver is running this command
        if (dispute && dispute.solver_id != ctx.admin._id) {
          logger.debug(
            `cancelorder ${order._id}: @${ctx.admin.username} is not the solver of this dispute`
          );
          return await messages.notAuthorized(ctx);
        }
      }

      if (order.hash) await cancelHoldInvoice({ hash: order.hash });

      if (dispute) {
        dispute.status = 'SELLER_REFUNDED';
        await dispute.save();
      }

      logger.info(`order ${order._id}: cancelled by admin`);

      order.status = 'CANCELED_BY_ADMIN';
      order.canceled_by = ctx.admin._id;
      const buyer = await User.findOne({ _id: order.buyer_id });
      const seller = await User.findOne({ _id: order.seller_id });
      await order.save();
      // we sent a private message to the admin
      await messages.successCancelOrderMessage(ctx, ctx.admin, order, ctx.i18n);
      // we sent a private message to the seller
      await messages.successCancelOrderByAdminMessage(ctx, bot, seller, order);
      // we sent a private message to the buyer
      await messages.successCancelOrderByAdminMessage(ctx, bot, buyer, order);
    } catch (error) {
      logger.error(error);
    }
  });

  // We allow users cancel pending orders,
  // pending orders are the ones that are not taken by another user
  bot.command('cancel', userMiddleware, async (ctx: MainContext) => {
    try {
      if (!('message' in ctx.update) || !('text' in ctx.update.message)){
        throw new Error(ctxUpdateAssertMsg);
      }
      const params = ctx.update.message.text.split(' ');
      const [command, orderId] = params.filter((el) => el);

      if (!orderId) {
        const orders = await askForConfirmation(ctx.user, command);
        if (!orders.length) return await ctx.reply(`${command}  <order Id>`);

        return await messages.showConfirmationButtons(ctx, orders, command);
      } else if (!(await validateObjectId(ctx, orderId))) {
        return;
      } else {
        await cancelOrder(ctx, orderId, ctx.user);
      }
    } catch (error) {
      logger.error(error);
    }
  });

  // We allow users cancel all pending orders,
  // pending orders are the ones that are not taken by another user
  bot.command('cancelall', userMiddleware, async (ctx: MainContext) => {
    try {
      const orders = await ordersActions.getOrders(ctx, ctx.user, 'PENDING');

      if (!orders) return;

      for (const order of orders) {
        order.status = 'CANCELED';
        order.canceled_by = ctx.user.id;
        await order.save();
        // We delete the messages related to that order from the channel
        await deleteOrderFromChannel(order, bot.telegram);
      }
      // we sent a private message to the user
      await messages.successCancelAllOrdersMessage(ctx);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('settleorder', adminMiddleware, async (ctx: MainContext) => {
    try {
      const [orderId] = await validateParams(ctx, 2, '\\<_order id_\\>');

      if (!orderId) return;
      if (!(await validateObjectId(ctx, orderId))) return;

      const order = await Order.findOne({ _id: orderId });
      if (!order) return;

      // We look for a dispute for this order
      const dispute = await Dispute.findOne({ order_id: order._id });

      // We check if this is a solver, the order must be from the same community
      if (!ctx.admin.admin) {
        if (!order.community_id) {
          return await messages.notAuthorized(ctx);
        }

        if (order.community_id != ctx.admin.default_community_id) {
          return await messages.notAuthorized(ctx);
        }

        // We check if this dispute is from a community we validate that
        // the solver is running this command
        if (dispute && dispute.solver_id != ctx.admin.id) {
          return await messages.notAuthorized(ctx);
        }
      }

      if (order.secret) await settleHoldInvoice({ secret: order.secret });

      if (dispute) {
        dispute.status = 'SETTLED';
        await dispute.save();
      }

      order.status = 'COMPLETED_BY_ADMIN';
      const buyer = await User.findOne({ _id: order.buyer_id });
      const seller = await User.findOne({ _id: order.seller_id });
      await order.save();
      // we sent a private message to the admin
      await messages.successCompleteOrderMessage(ctx, order);
      // we sent a private message to the seller
      await messages.successCompleteOrderByAdminMessage(
        ctx,
        bot,
        seller,
        order
      );
      // we sent a private message to the buyer
      await messages.successCompleteOrderByAdminMessage(ctx, bot, buyer, order);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('checkorder', superAdminMiddleware, async (ctx: MainContext) => {
    try {
      const [orderId] = await validateParams(ctx, 2, '\\<_order id_\\>');
      if (!orderId) return;
      if (!(await validateObjectId(ctx, orderId))) return;
      const order = await Order.findOne({ _id: orderId });

      if (!order) return;

      const buyer = await User.findOne({ _id: order.buyer_id });
      const seller = await User.findOne({ _id: order.seller_id });

      await messages.checkOrderMessage(ctx, order, buyer, seller);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('checkinvoice', superAdminMiddleware, async (ctx: MainContext) => {
    try {
      const [orderId] = await validateParams(ctx, 2, '\\<_order id_\\>');
      if (!orderId) return;
      if (!(await validateObjectId(ctx, orderId))) return;
      const order = await Order.findOne({ _id: orderId });

      if (!order) return;
      if (!order.hash) return;

      const invoice = await getInvoice({ hash: order.hash });

      await messages.checkInvoiceMessage(
        ctx,
        invoice.is_confirmed,
        invoice.is_canceled,
        invoice.is_held
      );
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('resubscribe', superAdminMiddleware, async (ctx: MainContext) => {
    try {
      const [hash] = await validateParams(ctx, 2, '\\<_hash_\\>');

      if (!hash) return;

      const order = await Order.findOne({ hash });

      if (!order) return;
      await subscribeInvoice(bot, hash, true);
      ctx.reply(`hash resubscribed`);
    } catch (error: any) {
      logger.error(`/resubscribe command error: ${error.toString()}`);
    }
  });

  bot.command('help', userMiddleware, async (ctx: MainContext) => {
    try {
      await messages.helpMessage(ctx);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('disclaimer', userMiddleware, async (ctx: MainContext) => {
    try {
      await messages.disclaimerMessage(ctx);
    } catch (error) {
      logger.error(error);
    }
  });

  // Only buyers can use this command
  bot.command('fiatsent', userMiddleware, async (ctx: MainContext) => {
    try {
      if (!('message' in ctx.update) || !('text' in ctx.update.message)){
        throw new Error(ctxUpdateAssertMsg);
      }
      const params = ctx.update.message.text.split(' ');
      const [command, orderId] = params.filter((el) => el);

      if (!orderId) {
        const orders = await askForConfirmation(ctx.user, command);
        if (!orders.length) return await ctx.reply(`${command} <order Id>`);

        return await messages.showConfirmationButtons(ctx, orders, command);
      } else if (!(await validateObjectId(ctx, orderId))) {
        return;
      } else {
        await fiatSent(ctx, orderId, ctx.user);
      }
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('ban', adminMiddleware, async (ctx: MainContext) => {
    try {
      let [username] = await validateParams(
        ctx,
        2,
        '\\<_username or telegram ID_\\>'
      );

      if (!username) return;

      username = username[0] == '@' ? username.slice(1) : username;
      const user = await User.findOne({
        $or: [{ username }, { tg_id: username }],
      });
      if (!user) {
        await messages.notFoundUserMessage(ctx);
        return;
      }

      // We check if this is a solver, we ban the user only in the default community of the solver
      if (!ctx.admin.admin) {
        if (ctx.admin.default_community_id) {
          const community = await Community.findById(
            ctx.admin.default_community_id
          );
          community.banned_users.push({
            id: user._id,
            username: user.username,
          });
          await community.save();
        } else {
          return await ctx.reply(ctx.i18n.t('need_default_community'));
        }
      } else {
        user.banned = true;
        await user.save();
      }
      await messages.userBannedMessage(ctx);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('unban', adminMiddleware, async (ctx: MainContext) => {
    try {
      let [username] = await validateParams(
        ctx,
        2,
        '\\<_username or telegram ID_\\>'
      );

      if (!username) return;

      username = username[0] == '@' ? username.slice(1) : username;
      const user = await User.findOne({
        $or: [{ username }, { tg_id: username }],
      });
      if (!user) {
        await messages.notFoundUserMessage(ctx);
        return;
      }

      // We check if this is a solver, we unban the user only in the default community of the solver
      if (!ctx.admin.admin) {
        if (ctx.admin.default_community_id) {
          const community = await Community.findById(
            ctx.admin.default_community_id
          );
          community.banned_users = community.banned_users.filter(
            (el: any) => el.id !== user.id
          );
          await community.save();
        } else {
          return await ctx.reply(ctx.i18n.t('need_default_community'));
        }
      } else {
        user.banned = false;
        await user.save();
      }
      await messages.userUnBannedMessage(ctx);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('setaddress', userMiddleware, async (ctx: MainContext) => {
    try {
      const [lightningAddress] = await validateParams(
        ctx,
        2,
        '\\<_lightningAddress / off_\\>'
      );
      if (!lightningAddress) return;

      if (lightningAddress === 'off') {
        ctx.user.lightning_address = null;
        await ctx.user.save();
        return await messages.disableLightningAddress(ctx);
      }

      if (!(await validateLightningAddress(lightningAddress)))
        return await messages.invalidLightningAddress(ctx);

      ctx.user.lightning_address = lightningAddress;
      await ctx.user.save();
      await messages.successSetAddress(ctx);
    } catch (error) {
      logger.error(error);
    }
  });

  // Only buyers can use this command
  bot.command('setinvoice', userMiddleware, async (ctx: MainContext) => {
    try {
      const [orderId, lnInvoice] = await validateParams(
        ctx,
        3,
        '\\<_order id_\\> \\<_lightning invoice_\\>'
      );

      if (!orderId) return;
      if (!(await validateObjectId(ctx, orderId))) return;
      const invoice = await validateInvoice(ctx, lnInvoice);
      if (!invoice) return;
      const order = await Order.findOne({
        _id: orderId,
        buyer_id: ctx.user.id,
      });
      if (!order) return await messages.notActiveOrderMessage(ctx);
      // We check if the old payment is on flight
      const isPendingOldPayment = await isPendingPayment(order.buyer_invoice);

      // We check if this new payment is on flight
      const isPending = await isPendingPayment(lnInvoice);

      // If one of the payments is on flight we don't do anything
      if (isPending || isPendingOldPayment) {
        logger.info(
          `Buyer Id: ${order.buyer_id} is trying to add a new invoice when have a pending payment on Order id: ${order._id}`
        );
        return await messages.invoiceAlreadyUpdatedMessage(ctx);
      }
      if (order.status === 'SUCCESS')
        return await messages.successCompleteOrderMessage(ctx, order);

      if (invoice.tokens && invoice.tokens !== order.amount)
        return await messages.incorrectAmountInvoiceMessage(ctx);

      order.buyer_invoice = lnInvoice;
      // When a seller release funds but the buyer didn't get the invoice paid
      if (order.status === 'PAID_HOLD_INVOICE') {
        const isScheduled = await PendingPayment.findOne({
          order_id: order._id,
          attempts: { $lt: process.env.PAYMENT_ATTEMPTS },
          is_invoice_expired: false,
        });

        if (isScheduled)
          return await messages.invoiceAlreadyUpdatedMessage(ctx);

        if (!order.paid_hold_buyer_invoice_updated) {
          order.paid_hold_buyer_invoice_updated = true;
          const pp = new PendingPayment({
            amount: order.amount,
            payment_request: lnInvoice,
            user_id: ctx.user.id,
            description: order.description,
            hash: order.hash,
            order_id: order._id,
          });
          await pp.save();
          await messages.invoiceUpdatedPaymentWillBeSendMessage(ctx);
        } else {
          await messages.invoiceAlreadyUpdatedMessage(ctx);
        }
      } else if (order.status === 'WAITING_BUYER_INVOICE') {
        const seller = await User.findOne({ _id: order.seller_id });
        await waitPayment(ctx, bot, ctx.user, seller, order, lnInvoice);
      } else {
        await messages.invoiceUpdatedMessage(ctx);
      }

      await order.save();
    } catch (error) {
      logger.error(error);
    }
  });

  OrdersModule.configure(bot);

  bot.action('addInvoiceBtn', userMiddleware, async (ctx: MainContext) => {
    await addInvoice(ctx, bot);
  });

  bot.action('cancelAddInvoiceBtn', userMiddleware, async (ctx: MainContext) => {
    await cancelAddInvoice(ctx);
  });

  bot.action('showHoldInvoiceBtn', userMiddleware, async (ctx: MainContext) => {
    await showHoldInvoice(ctx, bot);
  });

  bot.action('cancelShowHoldInvoiceBtn', userMiddleware, async (ctx: MainContext) => {
    await cancelShowHoldInvoice(ctx);
  });

  bot.action(/^showStarBtn\(([1-5]),(\w{24})\)$/, userMiddleware, async (ctx: MainContext) => {
    if (ctx.match === null) {
      throw new Error("ctx.match should not be null");
    }
    await rateUser(ctx, bot, ctx.match[1], ctx.match[2]);
  });

  bot.action(/^addInvoicePHIBtn_([0-9a-f]{24})$/, userMiddleware, async (ctx: MainContext) => {
    if (ctx.match === null) {
      throw new Error("ctx.match should not be null");
    }
    await addInvoicePHI(ctx, bot, ctx.match[1]);
  });

  bot.action(/^cancel_([0-9a-f]{24})$/, userMiddleware, async (ctx: MainContext) => {
    if (ctx.match === null) {
      throw new Error("ctx.match should not be null");
    }
    ctx.deleteMessage();
    await cancelOrder(ctx, ctx.match[1]);
  });

  bot.action(/^fiatsent_([0-9a-f]{24})$/, userMiddleware, async (ctx: MainContext) => {
    if (ctx.match === null) {
      throw new Error("ctx.match should not be null");
    }
    ctx.deleteMessage();
    await fiatSent(ctx, ctx.match[1]);
  });

  bot.action(/^release_([0-9a-f]{24})$/, userMiddleware, async (ctx: MainContext) => {
    if (ctx.match === null) {
      throw new Error("ctx.match should not be null");
    }
    ctx.deleteMessage();
    await release(ctx, ctx.match[1]);
  });

  bot.command('paytobuyer', adminMiddleware, async (ctx: MainContext) => {
    try {
      const [orderId] = await validateParams(ctx, 2, '\\<_order id_\\>');
      if (!orderId) return;
      if (!(await validateObjectId(ctx, orderId))) return;
      const order = await Order.findOne({
        _id: orderId,
      });
      if (!order) return await messages.notActiveOrderMessage(ctx);
      
      // We check if this is a solver, the order must be from the same community
      if (!ctx.admin.admin) {
        if (!order.community_id) {
          return await messages.notAuthorized(ctx);
        }

        if (order.community_id != ctx.admin.default_community_id) {
          return await messages.notAuthorized(ctx);
        }
      }

      // We make sure the buyers invoice is not being paid
      const isPending = await PendingPayment.findOne({
        order_id: order._id,
        attempts: { $lt: process.env.PAYMENT_ATTEMPTS },
      });

      if (isPending) return;

      await payToBuyer(bot, order);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('listcurrencies', userMiddleware, async (ctx: MainContext) => {
    try {
      const currencies = getCurrenciesWithPrice();

      await messages.listCurrenciesResponse(ctx, currencies);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('info', userMiddleware, async (ctx: MainContext) => {
    try {
      const config = await Config.findOne({});
      await messages.showInfoMessage(ctx, ctx.user, config);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('showusername', userMiddleware, async (ctx: MainContext) => {
    try {
      let [show] = await validateParams(ctx, 2, '_yes/no_');
      if (!show) return;
      show = show === 'yes';
      ctx.user.show_username = show;
      await ctx.user.save();
      messages.updateUserSettingsMessage(ctx, 'showusername', show);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('showvolume', userMiddleware, async (ctx: MainContext) => {
    try {
      let [show] = await validateParams(ctx, 2, '_yes/no_');
      if (!show) return;
      show = show === 'yes';
      ctx.user.show_volume_traded = show;
      await ctx.user.save();
      messages.updateUserSettingsMessage(ctx, 'showvolume', show);
    } catch (error) {
      logger.error(error);
    }
  });

  bot.command('exit', userMiddleware, async (ctx: MainContext) => {
    try {
      if (ctx.message?.chat.type !== 'private') return;

      await ctx.reply(ctx.i18n.t('not_wizard'));
    } catch (error) {
      logger.error(error);
    }
  });

  bot.on('text', userMiddleware, async (ctx: MainContext) => {
    try {
      if (ctx.message?.chat.type !== 'private') return;

      const text = (ctx.message as Message.TextMessage).text;
      let message;
      // If the user is trying to enter a command with first letter uppercase
      if (text[0] === '/' && text[1] === text[1].toUpperCase()) {
        message = ctx.i18n.t('no_capital_letters');
      } else {
        message = ctx.i18n.t('unknown_command');
      }
      ctx.reply(message);
    } catch (error) {
      logger.error(error);
    }
  });

  return bot;
};

const start = (botToken: string, options: Partial<Telegraf.Options<MainContext>>): Telegraf<MainContext> => {
  const bot = initialize(botToken, options);

  bot.launch();

  logger.notice('Bot launched.');

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
};

export { initialize, start };
