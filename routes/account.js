const router = require('express').Router();
const jwt = require('jsonwebtoken');

const {
  getUserByEmail,
  verifyUser,
  updateUserProfileByEmail,
  updateUserPasswordByEmail
} = require('../database/table/user');

const { cleanEmail, issueAuthCookie, getReqDb } = require('../lib/shared');

router.post('/profile', async (req, res) => {
  const db = getReqDb(req);
  if (!db) return res.status(500).json({ ok: false, error: 'Database not ready' });

  const email = cleanEmail(req.user && req.user.email);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  const firstName = String(req.body && req.body.firstName ? req.body.firstName : '').trim();
  const lastName = String(req.body && req.body.lastName ? req.body.lastName : '').trim();
  const companyName = String(req.body && req.body.companyName ? req.body.companyName : '').trim();
  const marketingOptIn = !!(req.body && req.body.marketingOptIn);

  const passwordCurrent = String(req.body && req.body.passwordCurrent ? req.body.passwordCurrent : '');
  const passwordNew = String(req.body && req.body.passwordNew ? req.body.passwordNew : '');

  if (!firstName) return res.status(400).json({ ok: false, error: 'First name is required' });
  if (!lastName) return res.status(400).json({ ok: false, error: 'Last name is required' });
  if (!companyName) return res.status(400).json({ ok: false, error: 'Company name is required' });

  try {
    if (passwordNew) {
      if (passwordNew.length < 8) {
        return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
      }
      if (!passwordCurrent) {
        return res.status(400).json({ ok: false, error: 'Current password is required' });
      }
      await verifyUser(db, email, passwordCurrent);
      await updateUserPasswordByEmail(db, email, passwordNew);
    }

    await updateUserProfileByEmail(db, email, { firstName, lastName, companyName, marketingOptIn });

    const user = await getUserByEmail(db, email);
    const token = jwt.sign(
      { email: user && user.email ? user.email : email, name: user && user.first_name ? user.first_name : null, company: user && user.company ? user.company : null },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    issueAuthCookie(res, token);

    if (user) {
      const safe = { ...(user || {}) };
      delete safe.password_hash;
      delete safe.passwordHash;
      delete safe.password;
      return res.json({ ok: true, user: safe });
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err && err.message ? err.message : 'Update failed' });
  }
});

module.exports = router;
