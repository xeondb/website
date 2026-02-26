const express = require("express");
const app = express();

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
const { cleanEmail, clearAuthCookie, getReqDb } = require('./lib/shared');
const oauthRoutes = require('./routes/oauth');

app.use(cors());
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

app.get("/", (req, res) => {
  res.render("index", {
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
  res.render('billing', { name, email, user, instances });
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

(async () => {
  const db = await connectToDb();
  app.locals.db = db;

  app.listen(process.env.PORT, () => {
    console.log(`Application running at http://localhost:${process.env.PORT}/`);
  });
})();
