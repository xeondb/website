const router = require('express').Router();
const jwt = require('jsonwebtoken');

const { isCookieSecure } = require('../lib/shared');

function issueAdminCookie(res, token) {
  const secure = isCookieSecure();
  res.cookie('admin-token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearAdminCookie(res) {
  const secure = isCookieSecure();
  res.cookie('admin-token', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 0,
    path: '/'
  });
}

router.post('/login', async (req, res) => {
  const username = String(req.body && req.body.username ? req.body.username : '').trim();
  const password = String(req.body && req.body.password ? req.body.password : '');

  const expectedUser = String(process.env.ADMIN_USERNAME || '').trim();
  const expectedPass = String(process.env.ADMIN_PASSWORD || '');

  if (!expectedUser || !expectedPass) {
    return res.status(500).json({ ok: false, error: 'Admin credentials not configured' });
  }

  if (username !== expectedUser || password !== expectedPass) {
    return res.status(401).json({ ok: false, error: 'Invalid admin credentials' });
  }

  const token = jwt.sign({ admin: true, username }, process.env.JWT_SECRET, { expiresIn: '7d' });
  issueAdminCookie(res, token);
  return res.json({ ok: true });
});

router.post('/logout', async (req, res) => {
  clearAdminCookie(res);
  return res.json({ ok: true });
});

module.exports = { router, clearAdminCookie };
