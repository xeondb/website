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

async function listPolarOrdersByCustomerIds(customerIds) {
  const ids = Array.isArray(customerIds)
    ? [...new Set(customerIds.map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  if (!ids.length) return [];

  const polar = getPolarClient();
  const orders = [];

  for (const customerId of ids) {
    const pages = await polar.orders.list({ customerId, limit: 100, sorting: ['-created_at'] });
    for await (const page of pages) {
      const items = page && page.result && Array.isArray(page.result.items) ? page.result.items : [];
      for (const item of items) {
        orders.push(item);
      }
    }
  }

  const unique = new Map();
  for (const order of orders) {
    const id = String(order && order.id ? order.id : '').trim();
    if (!id || unique.has(id)) continue;
    unique.set(id, order);
  }

  return Array.from(unique.values()).sort((a, b) => {
    const aTime = new Date(a && a.createdAt ? a.createdAt : 0).getTime();
    const bTime = new Date(b && b.createdAt ? b.createdAt : 0).getTime();
    return bTime - aTime;
  });
}

async function getPolarInvoiceUrl(orderId) {
  const id = String(orderId || '').trim();
  if (!id) return '';

  const polar = getPolarClient();
  try {
    const invoice = await polar.orders.invoice({ id });
    return String(invoice && invoice.url ? invoice.url : '').trim();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err || '').toLowerCase();
    if (msg.includes('not found') || msg.includes('invoice')) {
      return '';
    }
    throw err;
  }
}

module.exports = {
  getPolarClient,
  revokePolarSubscription,
  listPolarOrdersByCustomerIds,
  getPolarInvoiceUrl
};
