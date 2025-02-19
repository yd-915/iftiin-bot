const { createHash, randomBytes } = require('crypto');
const lightning = require('lightning');
const lnd = require('./connect');
const logger = require('../logger');

const createHoldInvoice = async ({ description, amount }) => {
  try {
    const randomSecret = () => randomBytes(32);
    const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
    // We create a random secret
    const secret = randomSecret();
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + 3600);

    const hash = sha256(secret);
    const cltv_delta = parseInt(process.env.HOLD_INVOICE_CLTV_DELTA);
    const { request, id } = await lightning.createHodlInvoice({
      cltv_delta,
      lnd,
      description,
      id: hash,
      tokens: amount,
      expires_at: expiresAt,
    });

    // We sent back the response hash (id) to be used on testing
    return { request, hash: id, secret: secret.toString('hex') };
  } catch (error) {
    logger.error(error);
  }
};

const settleHoldInvoice = async ({ secret }) => {
  try {
    await lightning.settleHodlInvoice({ lnd, secret });
  } catch (error) {
    logger.error(error);
  }
};

const cancelHoldInvoice = async ({ hash }) => {
  try {
    await lightning.cancelHodlInvoice({ lnd, id: hash });
  } catch (error) {
    logger.error(error);
  }
};

const getInvoice = async ({ hash }) => {
  try {
    return await lightning.getInvoice({ lnd, id: hash });
  } catch (error) {
    logger.error(error);
  }
};

module.exports = {
  createHoldInvoice,
  settleHoldInvoice,
  cancelHoldInvoice,
  getInvoice,
};
