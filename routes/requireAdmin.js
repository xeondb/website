const jwt = require('jsonwebtoken');

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
  const cookiePairs = cookieHeader.split(';');
  for (const pair of cookiePairs) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function getToken(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  const raw = cookies['admin-token'] || req.header('admin-token') || req.header('authorization');
  if (!raw) return null;
  const s = String(raw);
  if (s.toLowerCase().startsWith('bearer ')) return s.slice(7).trim();
  return s;
}

module.exports = function requireAdmin(req, res, next) {
  const token = getToken(req);
  const url = String(req.originalUrl || req.url || '');
  if (!token) {
    if (url.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Admin access denied' });
    return res.redirect('/admin/login');
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    if (!verified || verified.admin !== true) {
      if (url.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Admin access denied' });
      return res.redirect('/admin/login');
    }
    req.admin = verified;
    return next();
  } catch {
    if (url.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Invalid admin token' });
    return res.redirect('/admin/login');
  }
};
