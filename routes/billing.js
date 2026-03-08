const router = require('express').Router();

const { getInstanceById } = require('../database/table/instances');
const { cleanEmail, getReqDb } = require('../lib/shared');
const {
  getLatestInstanceSubscriptionByInstance,
  isSubscriptionActiveLike
} = require('../database/table/instanceSubscriptions');

function encodeMetadata(obj) {
  const json = JSON.stringify(obj || {});
  return encodeURIComponent(json);
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

module.exports = router;
