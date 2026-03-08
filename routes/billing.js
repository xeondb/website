const router = require('express').Router();
const crypto = require('crypto');

const { getInstanceById, getInstancesByUser } = require('../database/table/instances');
const { cleanEmail, getReqDb } = require('../lib/shared');
const {
  getLatestInstanceSubscriptionByInstance,
  isSubscriptionActiveLike
} = require('../database/table/instanceSubscriptions');
const { createPendingInstancePurchase } = require('../database/table/pendingInstancePurchases');

function encodeMetadata(obj) {
  const json = JSON.stringify(obj || {});
  return encodeURIComponent(json);
}

function createStateToken() {
  return crypto.randomBytes(12).toString('hex');
}

router.post('/checkout', async (req, res) => {
  const db = getReqDb(req);
  if (!db) return res.status(500).json({ ok: false, error: 'Database not ready' });

  const email = cleanEmail(req.user && req.user.email);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  const instanceId = String(req.body && req.body.instanceId ? req.body.instanceId : '').trim();
  if (!instanceId) return res.status(400).json({ ok: false, error: 'Missing instanceId' });

  const productId = String(process.env.POLAR_PRO_PRODUCT_ID || '').trim();
  if (!productId) return res.status(500).json({ ok: false, error: 'Missing POLAR_PRO_PRODUCT_ID' });

  try {
    const instance = await getInstanceById(db, instanceId);
    if (!instance) return res.status(404).json({ ok: false, error: 'Instance not found' });
    if (cleanEmail(instance.user_email) !== email) return res.status(403).json({ ok: false, error: 'Forbidden' });

    const plan = String(instance.plan || 'free').trim().toLowerCase();
    if (plan === 'pro') return res.status(409).json({ ok: false, error: 'Instance already Pro' });

    const existingSub = await getLatestInstanceSubscriptionByInstance(db, instanceId);
    if (existingSub && isSubscriptionActiveLike(existingSub)) {
      return res.status(409).json({ ok: false, error: 'Instance already has an active subscription' });
    }

    const metadata = encodeMetadata({ instance_id: instanceId, user_email: email, plan: 'pro' });

    const url =
      `/checkout?products=${encodeURIComponent(productId)}` +
      `&customerEmail=${encodeURIComponent(email)}` +
      `&metadata=${metadata}`;

    return res.json({ ok: true, url });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Failed to create checkout' });
  }
});

router.post('/checkout/new-instance', async (req, res) => {
  const db = getReqDb(req);
  if (!db) return res.status(500).json({ ok: false, error: 'Database not ready' });

  const email = cleanEmail(req.user && req.user.email);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  const plan = String(req.body && req.body.plan ? req.body.plan : 'free').trim().toLowerCase();
  if (plan !== 'pro') return res.status(400).json({ ok: false, error: 'Only Pro checkout is supported here' });

  const productId = String(process.env.POLAR_PRO_PRODUCT_ID || '').trim();
  if (!productId) return res.status(500).json({ ok: false, error: 'Missing POLAR_PRO_PRODUCT_ID' });

  try {
    const maxPerUser = Number(process.env.MAX_DATABASES_PER_USER || 0);
    if (maxPerUser > 0) {
      const instances = await getInstancesByUser(db, email);
      if (instances.length >= maxPerUser) {
        return res.status(409).json({ ok: false, error: `You have reached the maximum allowed databases (${maxPerUser})` });
      }
    }

    const pending = await createPendingInstancePurchase(db, { userEmail: email, plan: 'pro' });
    const state = createStateToken();
    const metadata = encodeMetadata({
      mode: 'new_instance',
      purchase_id: pending && pending.id ? String(pending.id) : '',
      user_email: email,
      plan: 'pro',
      state
    });

    const url =
      `/checkout?products=${encodeURIComponent(productId)}` +
      `&customerEmail=${encodeURIComponent(email)}` +
      `&metadata=${metadata}`;

    return res.json({ ok: true, url, purchaseId: pending && pending.id ? String(pending.id) : '' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Failed to create checkout' });
  }
});

module.exports = router;
