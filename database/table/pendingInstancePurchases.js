const crypto = require('crypto');

const { cleanSQL } = require('../../lib/shared');

async function ensurePendingInstancePurchasesTable(db) {
  const ddl =
    'CREATE TABLE IF NOT EXISTS pending_instance_purchases (id varchar, user_email varchar, plan varchar, status varchar, instance_id varchar, checkout_id varchar, subscription_id varchar, created_at int64, updated_at int64, PRIMARY KEY (id));';
  const res = await db.query(ddl);
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || 'Failed to ensure pending_instance_purchases table');
  }
}

async function listPendingInstancePurchases(db) {
  const res = await db.query('SELECT * FROM pending_instance_purchases ORDER BY updated_at DESC;');
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || 'Failed to list pending instance purchases');
  }
  return Array.isArray(res.rows) ? res.rows : [];
}

async function getPendingInstancePurchaseById(db, id) {
  const needle = String(id || '').trim();
  if (!needle) return null;
  const rows = await listPendingInstancePurchases(db);
  return rows.find((row) => String(row.id || '').trim() === needle) || null;
}

async function createPendingInstancePurchase(db, data) {
  const userEmail = String(data && data.userEmail ? data.userEmail : '').trim().toLowerCase();
  const plan = String(data && data.plan ? data.plan : '').trim().toLowerCase() === 'pro' ? 'pro' : 'free';
  if (!userEmail) throw new Error('userEmail is required');

  const id = crypto.randomBytes(18).toString('hex');
  const now = Date.now();
  const q = `INSERT INTO pending_instance_purchases (id, user_email, plan, status, instance_id, checkout_id, subscription_id, created_at, updated_at) VALUES (${cleanSQL(
    id
  )}, ${cleanSQL(userEmail)}, ${cleanSQL(plan)}, ${cleanSQL('pending')}, ${cleanSQL('')}, ${cleanSQL('')}, ${cleanSQL('')}, ${now}, ${now});`;
  const res = await db.query(q);
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || 'Failed to create pending instance purchase');
  }
  return getPendingInstancePurchaseById(db, id);
}

async function updatePendingInstancePurchase(db, id, data) {
  const needle = String(id || '').trim();
  if (!needle) throw new Error('id is required');

  const existing = await getPendingInstancePurchaseById(db, needle);
  if (!existing) throw new Error('Pending instance purchase not found');

  const userEmail = Object.prototype.hasOwnProperty.call(data || {}, 'userEmail')
    ? String(data.userEmail || '').trim().toLowerCase()
    : String(existing.user_email || '').trim().toLowerCase();
  const plan = Object.prototype.hasOwnProperty.call(data || {}, 'plan')
    ? (String(data.plan || '').trim().toLowerCase() === 'pro' ? 'pro' : 'free')
    : (String(existing.plan || '').trim().toLowerCase() === 'pro' ? 'pro' : 'free');
  const status = Object.prototype.hasOwnProperty.call(data || {}, 'status')
    ? String(data.status || '').trim().toLowerCase()
    : String(existing.status || '').trim().toLowerCase();
  const instanceId = Object.prototype.hasOwnProperty.call(data || {}, 'instanceId')
    ? String(data.instanceId || '').trim()
    : String(existing.instance_id || '').trim();
  const checkoutId = Object.prototype.hasOwnProperty.call(data || {}, 'checkoutId')
    ? String(data.checkoutId || '').trim()
    : String(existing.checkout_id || '').trim();
  const subscriptionId = Object.prototype.hasOwnProperty.call(data || {}, 'subscriptionId')
    ? String(data.subscriptionId || '').trim()
    : String(existing.subscription_id || '').trim();
  const now = Date.now();

  const q = `UPDATE pending_instance_purchases SET user_email=${cleanSQL(userEmail)}, plan=${cleanSQL(plan)}, status=${cleanSQL(
    status
  )}, instance_id=${cleanSQL(instanceId)}, checkout_id=${cleanSQL(checkoutId)}, subscription_id=${cleanSQL(subscriptionId)}, updated_at=${now} WHERE id=${cleanSQL(
    needle
  )};`;
  const res = await db.query(q);
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || 'Failed to update pending instance purchase');
  }
  return getPendingInstancePurchaseById(db, needle);
}

module.exports = {
  ensurePendingInstancePurchasesTable,
  listPendingInstancePurchases,
  getPendingInstancePurchaseById,
  createPendingInstancePurchase,
  updatePendingInstancePurchase
};
