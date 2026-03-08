const { cleanSQL } = require('../../lib/shared');

async function ensureInstanceSubscriptionsTable(db) {
  const ddl =
    'CREATE TABLE IF NOT EXISTS instance_subscriptions (subscription_id varchar, instance_id varchar, user_email varchar, customer_id varchar, checkout_id varchar, latest_order_id varchar, product_id varchar, status varchar, cancel_at_period_end bool, current_period_end varchar, canceled_at varchar, ended_at varchar, created_at int64, updated_at int64, PRIMARY KEY (subscription_id));';
  const res = await db.query(ddl);
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || 'Failed to ensure instance_subscriptions table');
  }
}

async function listInstanceSubscriptions(db) {
  const res = await db.query('SELECT * FROM instance_subscriptions ORDER BY updated_at DESC;');
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || 'Failed to list instance subscriptions');
  }
  return Array.isArray(res.rows) ? res.rows : [];
}

async function getInstanceSubscriptionBySubscriptionId(db, subscriptionId) {
  const needle = String(subscriptionId || '').trim();
  if (!needle) return null;
  const rows = await listInstanceSubscriptions(db);
  return rows.find((row) => String(row.subscription_id || '').trim() === needle) || null;
}

async function listInstanceSubscriptionsByInstance(db, instanceId) {
  const needle = String(instanceId || '').trim();
  if (!needle) return [];
  const rows = await listInstanceSubscriptions(db);
  return rows.filter((row) => String(row.instance_id || '').trim() === needle);
}

async function getLatestInstanceSubscriptionByInstance(db, instanceId) {
  const rows = await listInstanceSubscriptionsByInstance(db, instanceId);
  rows.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  return rows[0] || null;
}

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeBool(value) {
  return value === true;
}

async function upsertInstanceSubscription(db, data) {
  const subscriptionId = normalizeString(data.subscription_id || data.subscriptionId);
  const instanceId = normalizeString(data.instance_id || data.instanceId);
  if (!subscriptionId) throw new Error('subscription_id is required');
  if (!instanceId) throw new Error('instance_id is required');

  const now = Date.now();
  const existing = await getInstanceSubscriptionBySubscriptionId(db, subscriptionId);
  const createdAt = existing && Number(existing.created_at) > 0 ? Number(existing.created_at) : now;

  if (existing) {
    const q = `UPDATE instance_subscriptions SET instance_id=${cleanSQL(instanceId)}, user_email=${cleanSQL(normalizeString(data.user_email || data.userEmail || existing.user_email))}, customer_id=${cleanSQL(normalizeString(data.customer_id || data.customerId || existing.customer_id))}, checkout_id=${cleanSQL(normalizeString(data.checkout_id || data.checkoutId || existing.checkout_id))}, latest_order_id=${cleanSQL(normalizeString(data.latest_order_id || data.latestOrderId || existing.latest_order_id))}, product_id=${cleanSQL(normalizeString(data.product_id || data.productId || existing.product_id))}, status=${cleanSQL(normalizeString(data.status || existing.status))}, cancel_at_period_end=${normalizeBool(Object.prototype.hasOwnProperty.call(data, 'cancel_at_period_end') ? data.cancel_at_period_end : data.cancelAtPeriodEnd)}, current_period_end=${cleanSQL(normalizeString(data.current_period_end || data.currentPeriodEnd || existing.current_period_end))}, canceled_at=${cleanSQL(normalizeString(data.canceled_at || data.canceledAt || existing.canceled_at))}, ended_at=${cleanSQL(normalizeString(data.ended_at || data.endedAt || existing.ended_at))}, updated_at=${now} WHERE subscription_id=${cleanSQL(subscriptionId)};`;
    const res = await db.query(q);
    if (!res || res.ok !== true) {
      throw new Error((res && res.error) || 'Failed to update instance subscription');
    }
  } else {
    const q = `INSERT INTO instance_subscriptions (subscription_id, instance_id, user_email, customer_id, checkout_id, latest_order_id, product_id, status, cancel_at_period_end, current_period_end, canceled_at, ended_at, created_at, updated_at) VALUES (${cleanSQL(subscriptionId)}, ${cleanSQL(instanceId)}, ${cleanSQL(normalizeString(data.user_email || data.userEmail))}, ${cleanSQL(normalizeString(data.customer_id || data.customerId))}, ${cleanSQL(normalizeString(data.checkout_id || data.checkoutId))}, ${cleanSQL(normalizeString(data.latest_order_id || data.latestOrderId))}, ${cleanSQL(normalizeString(data.product_id || data.productId))}, ${cleanSQL(normalizeString(data.status))}, ${normalizeBool(data.cancel_at_period_end || data.cancelAtPeriodEnd)}, ${cleanSQL(normalizeString(data.current_period_end || data.currentPeriodEnd))}, ${cleanSQL(normalizeString(data.canceled_at || data.canceledAt))}, ${cleanSQL(normalizeString(data.ended_at || data.endedAt))}, ${createdAt}, ${now});`;
    const res = await db.query(q);
    if (!res || res.ok !== true) {
      throw new Error((res && res.error) || 'Failed to create instance subscription');
    }
  }

  return getInstanceSubscriptionBySubscriptionId(db, subscriptionId);
}

async function deleteInstanceSubscriptionBySubscriptionId(db, subscriptionId) {
  const needle = normalizeString(subscriptionId);
  if (!needle) throw new Error('subscription_id is required');
  const q = `DELETE FROM instance_subscriptions WHERE subscription_id=${cleanSQL(needle)};`;
  const res = await db.query(q);
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || 'Failed to delete instance subscription');
  }
  return true;
}

async function deleteInstanceSubscriptionsByInstance(db, instanceId) {
  const rows = await listInstanceSubscriptionsByInstance(db, instanceId);
  for (const row of rows) {
    try {
      await deleteInstanceSubscriptionBySubscriptionId(db, row.subscription_id);
    } catch {
      // ignore
    }
  }
}

function isSubscriptionActiveLike(row) {
  const status = normalizeString(row && row.status).toLowerCase();
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

module.exports = {
  ensureInstanceSubscriptionsTable,
  listInstanceSubscriptions,
  listInstanceSubscriptionsByInstance,
  getInstanceSubscriptionBySubscriptionId,
  getLatestInstanceSubscriptionByInstance,
  upsertInstanceSubscription,
  deleteInstanceSubscriptionBySubscriptionId,
  deleteInstanceSubscriptionsByInstance,
  isSubscriptionActiveLike
};
