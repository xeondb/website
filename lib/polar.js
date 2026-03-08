const { Polar } = require('@polar-sh/sdk');

function getPolarClient() {
  const accessToken = String(process.env.POLAR_ACCESS_TOKEN || '').trim();
  if (!accessToken) throw new Error('Missing POLAR_ACCESS_TOKEN');

  const server = String(process.env.POLAR_SERVER || 'production').trim().toLowerCase() === 'sandbox'
    ? 'sandbox'
    : 'production';

  return new Polar({
    accessToken,
    server
  });
}

async function revokePolarSubscription(subscriptionId) {
  const id = String(subscriptionId || '').trim();
  if (!id) throw new Error('subscriptionId is required');

  const polar = getPolarClient();
  try {
    return await polar.subscriptions.revoke({ id });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err || '');
    const lower = msg.toLowerCase();
    if (lower.includes('already canceled') || lower.includes('already revoked') || lower.includes('not found')) {
      return null;
    }
    throw err;
  }
}

module.exports = {
  getPolarClient,
  revokePolarSubscription
};
