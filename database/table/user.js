const bcrypt = require('bcryptjs');

const { cleanSQL } = require('../../lib/shared');

async function ensureUsersTable(db) {
  const cmd =
    'CREATE TABLE IF NOT EXISTS users (email varchar, password_hash varchar, first_name varchar, last_name varchar, company varchar, marketing_opt_in boolean, created_at int64, PRIMARY KEY (email));';
  const res = await db.query(cmd);
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || 'Failed to ensure users table');
  }
}

async function getUserByEmail(db, email) {
  const cmd = `SELECT * FROM users WHERE email=${cleanSQL(email)};`;
  const res = await db.query(cmd);
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'Failed to fetch user');

  if (Object.prototype.hasOwnProperty.call(res, 'found')) return res.found ? (res.row || null) : null;
  if (Array.isArray(res.rows)) return res.rows[0] || null;
  if (res.row) return res.row;
  return null;
}

async function createUser(db, data) {
  const email = String(data.email || '').trim().toLowerCase();
  const password = String(data.password || '');
  const firstName = String(data.firstName || '').trim();
  const lastName = String(data.lastName || '').trim();
  const companyName = String(data.companyName || '').trim();
  const marketingOptIn = !!data.marketingOptIn;

  const passwordHash = bcrypt.hashSync(password, 10);
  const createdAt = Date.now();

  const cmd = `INSERT INTO users (email, password_hash, first_name, last_name, company, marketing_opt_in, created_at) VALUES (${cleanSQL(
    email
  )}, ${cleanSQL(passwordHash)}, ${cleanSQL(firstName)}, ${cleanSQL(lastName)}, ${cleanSQL(
    companyName
  )}, ${marketingOptIn ? 'true' : 'false'}, ${createdAt});`;
  const res = await db.query(cmd);
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'Failed to create user');

  return {
    email,
    firstName,
    lastName,
    companyName,
    marketingOptIn,
    createdAt
  };
}

async function verifyUser(db, email, password) {
  const user = await getUserByEmail(db, email);
  if (!user) throw new Error('User not found');

  const hash = user.password_hash || user.passwordHash || user.password;
  const isPasswordValid = bcrypt.compareSync(String(password || ''), String(hash || ''));
  if (!isPasswordValid) throw new Error('Invalid password');

  return user;
}

async function listUsers(db) {
  const res = await db.query('SELECT * FROM users ORDER BY email ASC;');
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'Failed to list users');
  const rows = Array.isArray(res.rows) ? res.rows : (res.row ? [res.row] : []);
  return rows.map((u) => {
    const out = { ...(u || {}) };
    delete out.password_hash;
    delete out.passwordHash;
    delete out.password;
    return out;
  });
}

async function deleteUserByEmail(db, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new Error('email is required');
  const cmd = `DELETE FROM users WHERE email=${cleanSQL(e)};`;
  const res = await db.query(cmd);
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'Failed to delete user');
  return true;
}

async function updateUserProfileByEmail(db, email, data) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new Error('email is required');

  const current = await getUserByEmail(db, e);
  if (!current) throw new Error('User not found');

  const firstName = String(data && data.firstName ? data.firstName : '').trim();
  const lastName = String(data && data.lastName ? data.lastName : '').trim();
  const companyName = String(data && data.companyName ? data.companyName : '').trim();
  const marketingOptIn = !!(data && data.marketingOptIn);

  const createdAt = current.created_at ? Number(current.created_at) : Date.now();
  const passwordHash = String(current.password_hash || current.passwordHash || '');
  if (!passwordHash) throw new Error('Missing password hash');

  const cmd = `INSERT INTO users (email, password_hash, first_name, last_name, company, marketing_opt_in, created_at) VALUES (${cleanSQL(
    e
  )}, ${cleanSQL(passwordHash)}, ${cleanSQL(firstName)}, ${cleanSQL(lastName)}, ${cleanSQL(companyName)}, ${marketingOptIn ? 'true' : 'false'}, ${createdAt});`;
  const res = await db.query(cmd);
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'Failed to update user');
  return true;
}

async function updateUserPasswordByEmail(db, email, newPassword) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new Error('email is required');

  const current = await getUserByEmail(db, e);
  if (!current) throw new Error('User not found');

  const password = String(newPassword || '');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');

  const passwordHash = bcrypt.hashSync(password, 10);
  const createdAt = current.created_at ? Number(current.created_at) : Date.now();

  const firstName = String(current.first_name || '').trim();
  const lastName = String(current.last_name || '').trim();
  const companyName = String(current.company || '').trim();
  const marketingOptIn = !!(current.marketing_opt_in === true || current.marketingOptIn === true);

  const cmd = `INSERT INTO users (email, password_hash, first_name, last_name, company, marketing_opt_in, created_at) VALUES (${cleanSQL(
    e
  )}, ${cleanSQL(passwordHash)}, ${cleanSQL(firstName)}, ${cleanSQL(lastName)}, ${cleanSQL(companyName)}, ${marketingOptIn ? 'true' : 'false'}, ${createdAt});`;
  const res = await db.query(cmd);
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'Failed to update password');
  return true;
}

module.exports = {
  ensureUsersTable,
  getUserByEmail,
  createUser,
  verifyUser,
  listUsers,
  deleteUserByEmail,
  updateUserProfileByEmail,
  updateUserPasswordByEmail
};
