const express = require("express");
const app = express();
const log = require("./lib/log");
const jwt = require('jsonwebtoken');
app.set('trust proxy', true);
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, '.env') });
const { connectToDb } = require("./database/db");
const authApi = require("./routes/auth");
const requireAuth = require("./routes/verifyToken");
const instancesApi = require('./routes/instances');
const adminApi = require('./routes/adminApi');
const accountApi = require('./routes/account');
const { router: adminAuthApi, clearAdminCookie } = require('./routes/adminAuth');
const requireAdmin = require('./routes/requireAdmin');
const { getUserByEmail } = require('./database/table/user');
const { getInstancesByUser, getInstanceById, listInstances } = require('./database/table/instances');
const { listUsers } = require('./database/table/user');
const { getLatestInstanceSubscriptionsByInstances } = require('./database/table/instanceSubscriptions');
const { cleanEmail, clearAuthCookie, getReqDb } = require('./lib/shared');
const { listPolarOrdersByCustomerIds, getPolarInvoiceUrl } = require('./lib/polar');
const oauthRoutes = require('./routes/oauth');
const { Checkout } = require('@polar-sh/express');

function formatBillingTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function amountToMajorUnits(amount) {
  const num = Number(amount || 0);
  if (!Number.isFinite(num)) return '0.00';
  return (num / 100).toFixed(2);
}

function normalizeBillingState(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return 'none';
  if (value === 'revoked') return 'ended';
  return value;
}

app.use(cors());
app.use('/api/polar/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.engine(".ejs", require("ejs").__express);
app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "/public")));
app.set("views", __dirname + "/views");

app.use('/api/auth', authApi);
app.use('/auth', oauthRoutes);
app.use('/api/instances', requireAuth, instancesApi);
app.use('/api/account', requireAuth, accountApi);
app.use('/api/admin', adminAuthApi);
app.use('/api/admin', adminApi);

app.use('/api/billing', requireAuth, require('./routes/billing'));
app.use('/api/polar', require('./routes/polarWebhook'));

app.get(
  '/checkout',
  Checkout({
    accessToken: process.env.POLAR_ACCESS_TOKEN,
    successUrl: process.env.POLAR_SUCCESS_URL,
    cancelUrl: process.env.POLAR_CANCEL_URL,
    returnUrl: process.env.POLAR_RETURN_URL || 'http://localhost:4862/billing',
    server: process.env.POLAR_SERVER || 'production'
  })
);

app.get("/", (req, res) => {
  let isLoggedIn = false;
  try {
    const rawCookie = String((req.headers && req.headers.cookie) || '');
    const pairs = rawCookie ? rawCookie.split(';') : [];
    let token = '';
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const key = pair.slice(0, idx).trim();
      if (key !== 'auth-token') continue;
      token = decodeURIComponent(pair.slice(idx + 1).trim());
      break;
    }
    if (!token) {
      const authHeader = String(req.header('auth-token') || req.header('authorization') || '').trim();
      token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : authHeader;
    }
    if (token) {
      jwt.verify(token, process.env.JWT_SECRET);
      isLoggedIn = true;
    }
  } catch {
    isLoggedIn = false;
  }

  res.render("index", {
    isLoggedIn
  });
});

app.get("/login", (req, res) => {
  res.render("login", {
  });
});

app.get('/logout', (req, res) => {
  clearAuthCookie(res);
  res.redirect('/login');
});

app.get('/admin/login', (req, res) => {
  res.render('admin-login', {});
});

app.get('/admin/logout', (req, res) => {
  clearAdminCookie(res);
  res.redirect('/admin/login');
});

app.get('/docs', (req, res) => {
  res.redirect('https://docs.xeondb.com/');
});

function computeInitialsFromUser(email, user) {
  const e = cleanEmail(email);
  const first = user && user.first_name ? String(user.first_name).trim() : '';
  const last = user && user.last_name ? String(user.last_name).trim() : '';
  const initials = (first[0] || '') + (last[0] || '');
  return (initials || (e ? e.slice(0, 2) : '') || 'ME').toUpperCase();
}

app.get('/admin', requireAdmin, async (req, res) => {
  const db = getReqDb(req);
  if (!db) return res.status(500).send('Database not ready');

  try {
    const users = await listUsers(db);
    const instances = await listInstances(db);

    const safeInstances = (instances || []).map((inst) => {
      const out = { ...(inst || {}) };
      delete out.db_password;
      return out;
    });

    const knownEmails = new Set((users || []).map((u) => cleanEmail(u && u.email ? u.email : '')));
    const instancesByEmail = {};
    const orphanInstances = [];
    for (const inst of safeInstances) {
      const e = cleanEmail(inst && inst.user_email ? inst.user_email : '');
      if (!e) {
        orphanInstances.push(inst);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(instancesByEmail, e)) instancesByEmail[e] = [];
      instancesByEmail[e].push(inst);
      if (!knownEmails.has(e)) orphanInstances.push(inst);
    }

    const instanceCountByEmail = {};
    for (const [e, list] of Object.entries(instancesByEmail)) {
      instanceCountByEmail[e] = Array.isArray(list) ? list.length : 0;
    }

    res.render('admin', {
      adminName: req.admin && req.admin.username ? String(req.admin.username) : '',
      users,
      instancesByEmail,
      orphanInstances,
      instanceCountByEmail,
      totalInstances: safeInstances.length
    });
  } catch (err) {
    return res.status(500).send(err && err.message ? err.message : 'Failed to load admin');
  }
});

app.get("/dashboard", requireAuth, async (req, res) => {
  const db = getReqDb(req);
  const email = cleanEmail(req.user && req.user.email);

  let name = 'ME';
  let instances = [];

  try {
    if (db && email) {
      const user = await getUserByEmail(db, email);
      const first = user && user.first_name ? String(user.first_name).trim() : '';
      const last = user && user.last_name ? String(user.last_name).trim() : '';
      const initials = (first[0] || '') + (last[0] || '');
      name = (initials || email.slice(0, 2) || 'ME').toUpperCase();
      instances = await getInstancesByUser(db, email);
    }
  } catch {
    // ignore
  }

  res.render("dashboard", { name, instances });
});

app.get('/settings', requireAuth, async (req, res) => {
  const db = getReqDb(req);
  const email = cleanEmail(req.user && req.user.email);
  if (!db) return res.status(500).send('Database not ready');
  if (!email) return res.redirect('/login');

  let user = null;
  let instances = [];
  try {
    user = await getUserByEmail(db, email);
  } catch {
    user = null;
  }
  try {
    instances = await getInstancesByUser(db, email);
  } catch {
    instances = [];
  }

  const name = computeInitialsFromUser(email, user);
  res.render('settings', { name, email, user, instances });
});

app.get('/billing', requireAuth, async (req, res) => {
  const db = getReqDb(req);
  const email = cleanEmail(req.user && req.user.email);
  if (!db) return res.status(500).send('Database not ready');
  if (!email) return res.redirect('/login');

  let user = null;
  let instances = [];
  let subscriptions = [];
  let invoices = [];
  let billingError = '';
  try {
    user = await getUserByEmail(db, email);
  } catch {
    user = null;
  }
  try {
    instances = await getInstancesByUser(db, email);
  } catch {
    instances = [];
  }

  try {
    const instanceIds = instances.map((instance) => String(instance && instance.id ? instance.id : '').trim()).filter(Boolean);
    subscriptions = await getLatestInstanceSubscriptionsByInstances(db, instanceIds);
  } catch {
    subscriptions = [];
  }

  const subscriptionByInstanceId = new Map();
  for (const row of subscriptions) {
    const instanceId = String(row && row.instance_id ? row.instance_id : '').trim();
    if (!instanceId) continue;
    subscriptionByInstanceId.set(instanceId, row);
  }

  const billingInstances = instances.map((instance) => {
    const sub = subscriptionByInstanceId.get(String(instance && instance.id ? instance.id : '').trim()) || null;
    return {
      ...(instance || {}),
      billingStatus: normalizeBillingState(sub && sub.status),
      subscriptionId: sub && sub.subscription_id ? String(sub.subscription_id).trim() : '',
      customerId: sub && sub.customer_id ? String(sub.customer_id).trim() : '',
      cancelAtPeriodEnd: !!(sub && sub.cancel_at_period_end === true),
      currentPeriodEnd: formatBillingTimestamp(sub && sub.current_period_end),
      canceledAt: formatBillingTimestamp(sub && sub.canceled_at),
      endedAt: formatBillingTimestamp(sub && sub.ended_at)
    };
  });

  try {
    const customerIds = subscriptions
      .map((row) => String(row && row.customer_id ? row.customer_id : '').trim())
      .filter(Boolean);
    const orders = await listPolarOrdersByCustomerIds(customerIds);
    const paidOrders = orders.filter((order) => order && order.paid === true);

    invoices = await Promise.all(
      paidOrders.map(async (order) => {
        let invoiceUrl = '';
        try {
          if (order && order.isInvoiceGenerated === true) {
            invoiceUrl = await getPolarInvoiceUrl(order.id);
          }
        } catch {
          invoiceUrl = '';
        }

        return {
          id: String(order && order.id ? order.id : '').trim(),
          createdAt: formatBillingTimestamp(order && order.createdAt),
          status: normalizeBillingState(order && order.status),
          paid: !!(order && order.paid === true),
          amount: amountToMajorUnits(order && order.totalAmount),
          currency: String(order && order.currency ? order.currency : 'usd').trim().toUpperCase(),
          invoiceNumber: String(order && order.invoiceNumber ? order.invoiceNumber : '').trim(),
          description: String(order && order.description ? order.description : '').trim(),
          invoiceUrl,
          productName: order && order.product && order.product.name ? String(order.product.name).trim() : '',
          subscriptionId: String(order && order.subscriptionId ? order.subscriptionId : '').trim()
        };
      })
    );
  } catch (err) {
    invoices = [];
    billingError = err && err.message ? String(err.message) : 'Unable to load invoice history';
  }

  const name = computeInitialsFromUser(email, user);
  res.render('billing', { name, email, user, instances: billingInstances, invoices, billingError });
});

app.get('/billing/success', requireAuth, (req, res) => {
  res.redirect('/billing');
});

app.get('/billing/cancel', requireAuth, (req, res) => {
  res.redirect('/billing');
});

app.get("/dashboard/:id", requireAuth, async (req, res) => {
  const db = getReqDb(req);
  const email = cleanEmail(req.user && req.user.email);
  const id = String(req.params.id || '');

  if (!db) return res.status(500).send('Database not ready');

  try {
    const instance = await getInstanceById(db, id);
    if (!instance) return res.status(404).send('Instance not found');
    if (String(instance.user_email || '').trim().toLowerCase() !== email) {
      return res.status(403).send('Forbidden');
    }
    const safeInstance = { ...instance };
    delete safeInstance.db_password;
    res.render("manage", { name: (email.slice(0, 2) || 'ME').toUpperCase(), instance: safeInstance });
  } catch (err) {
    return res.status(500).send(err && err.message ? err.message : 'Failed to load instance');
  }
});

app.get("/privacy", (req, res) => {
  res.render("privacy", {
  });
});

app.get("/tos", (req, res) => {
  res.render("tos", {
  });
});

app.get("/install", async (req, res) => {
  const url = "https://raw.githubusercontent.com/xeondb/Xeondb/main/install.sh";
  const r = await fetch(url);
  if (!r.ok) return res.status(502).send("Failed to fetch installer");
  res.set("Content-Type", "text/x-shellscript; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300");
  res.send(await r.text());
});

app.get("/update", async (req, res) => {
  const url = "https://raw.githubusercontent.com/xeondb/Xeondb/main/update.sh";
  const r = await fetch(url);
  if (!r.ok) return res.status(502).send("Failed to fetch updater");
  res.set("Content-Type", "text/x-shellscript; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300");
  res.send(await r.text());
});

(async () => {
  const db = await connectToDb();
  app.locals.db = db;

  app.listen(process.env.PORT, () => {
    log.info(`Application running at http://localhost:${process.env.PORT}/`);
  });
})();
