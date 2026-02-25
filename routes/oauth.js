const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { getUserByEmail, createUser } = require('../database/table/user');
const { cleanEmail, getReqDb, isCookieSecure, issueAuthCookie } = require('../lib/shared');

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

function getBaseUrl(req) {
  const env = String(process.env.PUBLIC_URL || '').trim();
  if (env) return env.replace(/\/+$/g, '');
  const proto = req.protocol || 'http';
  const host = req.get('host');
  return `${proto}://${host}`;
}

function toAbsoluteRedirectUri(req, callbackPath) {
  let p = String(callbackPath || '').trim();
  if (!p.startsWith('/')) p = '/' + p;
  return getBaseUrl(req) + p;
}

function setStateCookie(res, name, value) {
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isCookieSecure(),
    maxAge: 10 * 60 * 1000,
    path: '/auth'
  });
}

function clearStateCookie(res, name) {
  res.cookie(name, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: isCookieSecure(),
    maxAge: 0,
    path: '/auth'
  });
}

function redirectWithError(res, msg) {
  const m = String(msg || 'OAuth login failed');
  return res.redirect('/login?error=' + encodeURIComponent(m));
}

async function ensureUserByEmail(db, profile) {
  const email = cleanEmail(profile && profile.email);
  if (!email) throw new Error('No email returned from provider');

  const existing = await getUserByEmail(db, email);
  if (existing) return { email, user: existing, created: false };

  const randomPassword = crypto.randomBytes(32).toString('hex');
  const firstName = String(profile && profile.firstName ? profile.firstName : '').trim();
  const lastName = String(profile && profile.lastName ? profile.lastName : '').trim();
  const companyName = String(profile && profile.companyName ? profile.companyName : '').trim();

  const createdUser = await createUser(db, {
    email,
    password: randomPassword,
    firstName,
    lastName,
    companyName,
    marketingOptIn: false
  });

  return { email, user: createdUser, created: true };
}

function issueJwtForUser(res, data) {
  const email = cleanEmail(data && data.email);
  const user = data && data.user ? data.user : null;
  const name = user && (user.first_name || user.firstName) ? (user.first_name || user.firstName) : null;
  const company = user && (user.company || user.companyName) ? (user.company || user.companyName) : null;
  const token = jwt.sign({ email, name, company }, process.env.JWT_SECRET, { expiresIn: '7d' });
  issueAuthCookie(res, token);
}

router.get('/google', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return redirectWithError(res, 'Google OAuth not configured');
    if (!process.env.GOOGLE_CALLBACK_URL) return redirectWithError(res, 'Google callback not configured');

    const state = crypto.randomBytes(16).toString('hex');
    setStateCookie(res, 'oauth_state_google', state);

    const redirectUri = toAbsoluteRedirectUri(req, process.env.GOOGLE_CALLBACK_URL);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');

    return res.redirect(url.toString());
  } catch (err) {
    return redirectWithError(res, err && err.message ? err.message : 'Google login failed');
  }
});

router.get('/google/callback', async (req, res) => {
  const db = getReqDb(req);
  if (!db) return redirectWithError(res, 'Database not ready');

  const code = String(req.query && req.query.code ? req.query.code : '');
  const state = String(req.query && req.query.state ? req.query.state : '');
  const cookies = parseCookies(req.headers && req.headers.cookie);
  const expectedState = String(cookies.oauth_state_google || '');
  clearStateCookie(res, 'oauth_state_google');

  if (!code) return redirectWithError(res, 'Missing code');
  if (!state || !expectedState || state !== expectedState) return redirectWithError(res, 'Invalid state');

  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_SECRET) {
      return redirectWithError(res, 'Google OAuth not configured');
    }
    const redirectUri = toAbsoluteRedirectUri(req, process.env.GOOGLE_CALLBACK_URL);

    const body = new URLSearchParams();
    body.set('client_id', process.env.GOOGLE_CLIENT_ID);
    body.set('client_secret', process.env.GOOGLE_SECRET);
    body.set('code', code);
    body.set('grant_type', 'authorization_code');
    body.set('redirect_uri', redirectUri);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const tokenJson = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokenJson || !tokenJson.access_token) {
      const msg = tokenJson && tokenJson.error_description ? tokenJson.error_description : 'Failed to exchange code';
      return redirectWithError(res, msg);
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenJson.access_token }
    });
    const userJson = await userRes.json().catch(() => null);
    if (!userRes.ok || !userJson) return redirectWithError(res, 'Failed to fetch Google profile');

    if (!userJson.email) return redirectWithError(res, 'Google account did not return email');
    if (userJson.email_verified !== true) return redirectWithError(res, 'Google email not verified');

    const { email, user } = await ensureUserByEmail(db, {
      email: userJson.email,
      firstName: userJson.given_name || '',
      lastName: userJson.family_name || ''
    });
    issueJwtForUser(res, { email, user });
    return res.redirect('/dashboard');
  } catch (err) {
    return redirectWithError(res, err && err.message ? err.message : 'Google login failed');
  }
});

router.get('/github', async (req, res) => {
  try {
    if (!process.env.GITHUB_CLIENT_ID) return redirectWithError(res, 'GitHub OAuth not configured');
    if (!process.env.GITHUB_CALLBACK_URL) return redirectWithError(res, 'GitHub callback not configured');

    const state = crypto.randomBytes(16).toString('hex');
    setStateCookie(res, 'oauth_state_github', state);

    const redirectUri = toAbsoluteRedirectUri(req, process.env.GITHUB_CALLBACK_URL);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'user:email');
    url.searchParams.set('state', state);

    return res.redirect(url.toString());
  } catch (err) {
    return redirectWithError(res, err && err.message ? err.message : 'GitHub login failed');
  }
});

router.get('/github/callback', async (req, res) => {
  const db = getReqDb(req);
  if (!db) return redirectWithError(res, 'Database not ready');

  const code = String(req.query && req.query.code ? req.query.code : '');
  const state = String(req.query && req.query.state ? req.query.state : '');
  const cookies = parseCookies(req.headers && req.headers.cookie);
  const expectedState = String(cookies.oauth_state_github || '');
  clearStateCookie(res, 'oauth_state_github');

  if (!code) return redirectWithError(res, 'Missing code');
  if (!state || !expectedState || state !== expectedState) return redirectWithError(res, 'Invalid state');

  try {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_SECRET) {
      return redirectWithError(res, 'GitHub OAuth not configured');
    }
    const redirectUri = toAbsoluteRedirectUri(req, process.env.GITHUB_CALLBACK_URL);

    const body = new URLSearchParams();
    body.set('client_id', process.env.GITHUB_CLIENT_ID);
    body.set('client_secret', process.env.GITHUB_SECRET);
    body.set('code', code);
    body.set('redirect_uri', redirectUri);

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    const tokenJson = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokenJson || !tokenJson.access_token) {
      const msg = tokenJson && tokenJson.error_description ? tokenJson.error_description : 'Failed to exchange code';
      return redirectWithError(res, msg);
    }

    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + tokenJson.access_token,
        'User-Agent': 'xeondb.com'
      }
    });
    const emailsJson = await emailsRes.json().catch(() => null);
    if (!emailsRes.ok || !Array.isArray(emailsJson)) {
      return redirectWithError(res, 'Failed to fetch GitHub emails');
    }

    const verified = emailsJson.filter((e) => e && e.verified === true && typeof e.email === 'string');
    const primaryVerified = verified.find((e) => e.primary === true) || verified[0];
    if (!primaryVerified || !primaryVerified.email) {
      return redirectWithError(res, 'GitHub account has no verified email');
    }

    const profileRes = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + tokenJson.access_token,
        'User-Agent': 'xeondb.com'
      }
    });
    const profileJson = await profileRes.json().catch(() => null);
    const fullName = profileJson && typeof profileJson.name === 'string' ? profileJson.name : '';
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    const firstName = parts.length ? parts[0] : '';
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';

    const { email, user } = await ensureUserByEmail(db, {
      email: primaryVerified.email,
      firstName,
      lastName,
      companyName: profileJson && typeof profileJson.company === 'string' ? profileJson.company : ''
    });
    issueJwtForUser(res, { email, user });
    return res.redirect('/dashboard');
  } catch (err) {
    return redirectWithError(res, err && err.message ? err.message : 'GitHub login failed');
  }
});

module.exports = router;
