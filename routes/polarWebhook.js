const router = require('express').Router();

const { validateEvent, WebhookVerificationError } = require('@polar-sh/sdk/webhooks');
const { getReqDb, cleanEmail } = require('../lib/shared');
const { createInstance, getInstanceById, setInstancePlan } = require('../database/table/instances');
const {
  getInstanceSubscriptionBySubscriptionId,
  upsertInstanceSubscription
} = require('../database/table/instanceSubscriptions');
const {
  getPendingInstancePurchaseById,
  updatePendingInstancePurchase
} = require('../database/table/pendingInstancePurchases');
const { addWhitelistEntry } = require('../database/table/whitelist');

function extractMetadata(payload) {
  const data = payload && payload.data ? payload.data : null;
  if (!data || typeof data !== 'object') return null;
  if (data.metadata && typeof data.metadata === 'object') return data.metadata;
  if (data.subscription && data.subscription.metadata && typeof data.subscription.metadata === 'object') return data.subscription.metadata;
  if (data.order && data.order.metadata && typeof data.order.metadata === 'object') return data.order.metadata;
  return null;
}

function extractSubject(payload) {
  const data = payload && payload.data ? payload.data : null;
  if (!data || typeof data !== 'object') return null;
  if (data.subscription && typeof data.subscription === 'object') return data.subscription;
  if (data.order && data.order.subscription && typeof data.order.subscription === 'object') return data.order.subscription;
  if (typeof data.id === 'string') return data;
  return null;
}

function extractOrder(payload) {
  const data = payload && payload.data ? payload.data : null;
  if (!data || typeof data !== 'object') return null;
  if (data.order && typeof data.order === 'object') return data.order;
  if (data.subscription && data.subscription.order && typeof data.subscription.order === 'object') return data.subscription.order;
  return null;
}

function subscriptionStatusForType(type, subject) {
  const raw = String(subject && subject.status ? subject.status : '').trim().toLowerCase();
  if (raw) return raw;
  if (type === 'subscription.revoked') return 'revoked';
  if (type === 'subscription.canceled') return 'canceled';
  if (type === 'subscription.active' || type === 'subscription.created' || type === 'order.paid') return 'active';
  return '';
}

async function upgradeFromPayload(req, payload, plan) {
  const db = getReqDb(req);
  if (!db) throw new Error('Database not ready');

  const meta = extractMetadata(payload) || {};
  const type = String(payload && payload.type ? payload.type : '').trim();
  const subject = extractSubject(payload);
  const order = extractOrder(payload);
  const subscriptionId = subject && subject.id ? String(subject.id).trim() : '';

  let instanceId = meta.instance_id ? String(meta.instance_id).trim() : '';
  let userEmail = meta.user_email ? cleanEmail(meta.user_email) : '';

  if (!instanceId && subscriptionId) {
    const existingSub = await getInstanceSubscriptionBySubscriptionId(db, subscriptionId);
    if (existingSub) {
      instanceId = String(existingSub.instance_id || '').trim();
      if (!userEmail) userEmail = cleanEmail(existingSub.user_email);
    }
  }

  if (!instanceId) return;

  const inst = await getInstanceById(db, instanceId);
  if (!inst) return;
  if (userEmail && cleanEmail(inst.user_email) !== userEmail) return;

  if (subscriptionId) {
    await upsertInstanceSubscription(db, {
      subscription_id: subscriptionId,
      instance_id: instanceId,
      user_email: cleanEmail(inst.user_email),
      customer_id: subject && subject.customer_id ? String(subject.customer_id).trim() : '',
      checkout_id: subject && subject.checkout_id ? String(subject.checkout_id).trim() : '',
      latest_order_id: order && order.id ? String(order.id).trim() : '',
      product_id: subject && subject.product_id ? String(subject.product_id).trim() : '',
      status: subscriptionStatusForType(type, subject),
      cancel_at_period_end: !!(subject && subject.cancel_at_period_end === true),
      current_period_end: subject && subject.current_period_end ? String(subject.current_period_end).trim() : '',
      canceled_at: subject && subject.canceled_at ? String(subject.canceled_at).trim() : '',
      ended_at: subject && subject.ended_at ? String(subject.ended_at).trim() : ''
    });
  }

  await setInstancePlan(db, instanceId, plan);
}

async function resolveInstanceForPurchase(req, payload, createIfMissing) {
  const db = getReqDb(req);
  if (!db) throw new Error('Database not ready');

  const meta = extractMetadata(payload) || {};
  const purchaseId = meta.purchase_id ? String(meta.purchase_id).trim() : '';
  if (!purchaseId) return '';

  const pending = await getPendingInstancePurchaseById(db, purchaseId);
  if (!pending) return '';

  const pendingEmail = cleanEmail(pending.user_email);
  const metaEmail = meta.user_email ? cleanEmail(meta.user_email) : '';
  if (metaEmail && pendingEmail && metaEmail !== pendingEmail) return '';

  const subject = extractSubject(payload);
  const checkoutId = subject && subject.checkout_id ? String(subject.checkout_id).trim() : '';
  const subscriptionId = subject && subject.id ? String(subject.id).trim() : '';
  const existingInstanceId = pending.instance_id ? String(pending.instance_id).trim() : '';

  if (existingInstanceId) {
    await updatePendingInstancePurchase(db, purchaseId, {
      status: 'completed',
      checkoutId,
      subscriptionId
    });
    return existingInstanceId;
  }

  if (!createIfMissing) return '';

  const plan = String(pending.plan || '').trim().toLowerCase() === 'pro' ? 'pro' : 'free';
  const instance = await createInstance(db, { userEmail: pendingEmail, plan });

  try {
    await addWhitelistEntry(db, { instanceId: instance.id, cidr: '0.0.0.0/0', kind: 'default' });
  } catch {
    // ignore
  }

  await updatePendingInstancePurchase(db, purchaseId, {
    status: 'completed',
    instanceId: instance.id,
    checkoutId,
    subscriptionId
  });

  return instance.id;
}

async function syncNewPurchaseFromPayload(req, payload, plan, createIfMissing) {
  const db = getReqDb(req);
  if (!db) throw new Error('Database not ready');

  const instanceId = await resolveInstanceForPurchase(req, payload, createIfMissing);
  if (!instanceId) return;

  const inst = await getInstanceById(db, instanceId);
  if (!inst) return;

  const type = String(payload && payload.type ? payload.type : '').trim();
  const subject = extractSubject(payload);
  const order = extractOrder(payload);
  const subscriptionId = subject && subject.id ? String(subject.id).trim() : '';

  if (subscriptionId) {
    await upsertInstanceSubscription(db, {
      subscription_id: subscriptionId,
      instance_id: instanceId,
      user_email: cleanEmail(inst.user_email),
      customer_id: subject && subject.customer_id ? String(subject.customer_id).trim() : '',
      checkout_id: subject && subject.checkout_id ? String(subject.checkout_id).trim() : '',
      latest_order_id: order && order.id ? String(order.id).trim() : '',
      product_id: subject && subject.product_id ? String(subject.product_id).trim() : '',
      status: subscriptionStatusForType(type, subject),
      cancel_at_period_end: !!(subject && subject.cancel_at_period_end === true),
      current_period_end: subject && subject.current_period_end ? String(subject.current_period_end).trim() : '',
      canceled_at: subject && subject.canceled_at ? String(subject.canceled_at).trim() : '',
      ended_at: subject && subject.ended_at ? String(subject.ended_at).trim() : ''
    });
  }

  await setInstancePlan(db, instanceId, plan);
}

router.post('/webhook', async (req, res) => {
  try {
    const secret = String(process.env.POLAR_WEBHOOK_SECRET || '').trim();
    if (!secret) return res.status(500).send('');

    const event = validateEvent(req.body, req.headers, secret);

    const type = String(event && event.type ? event.type : '').trim();
    const payload = event;

    if (type === 'subscription.active' || type === 'subscription.created' || type === 'subscription.updated' || type === 'order.paid') {
      await syncNewPurchaseFromPayload(req, payload, 'pro', true);
      await upgradeFromPayload(req, payload, 'pro');
    }

    if (type === 'subscription.canceled') {
      await syncNewPurchaseFromPayload(req, payload, 'free', false);
      await upgradeFromPayload(req, payload, 'free');
    }

    if (type === 'subscription.revoked') {
      await syncNewPurchaseFromPayload(req, payload, 'free', false);
      await upgradeFromPayload(req, payload, 'free');
    }

    return res.status(202).send('');
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return res.status(403).send('');
    }
    return res.status(500).send('');
  }
});

module.exports = router;
