'use strict';
// Dashboard logins (separate from Google): scrypt-hashed passwords and
// server-side sessions in an HttpOnly cookie.
const crypto = require('crypto');

const ROLES = {
  admin: ['view', 'money', 'prices', 'tenants', 'users', 'sync'],
  accountant: ['view', 'money', 'prices', 'sync'],
  viewer: ['view'],
};
const SESSION_DAYS = 7;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function createUser(db, { username, name, role, password }) {
  if (!ROLES[role]) throw new Error(`role must be one of ${Object.keys(ROLES).join(', ')}`);
  if (!username || !password || password.length < 10) throw new Error('username and a password of at least 10 characters are required');
  return db.prepare('INSERT INTO users (username, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username.toLowerCase().trim(), name || null, role, hashPassword(password), new Date().toISOString()).lastInsertRowid;
}

function login(db, username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').toLowerCase().trim());
  if (!u || !verifyPassword(String(password || ''), u.password_hash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, u.id, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
  return token;
}

function middleware(db) {
  return (req, res, next) => {
    const token = req.cookies?.wsd_session;
    if (token) {
      const row = db.prepare(`SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
      if (row) req.user = { ...row, can: ROLES[row.role] || [] };
    }
    next();
  };
}

function requireCan(cap) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!req.user.can.includes(cap)) return res.status(403).json({ error: 'Your role cannot do this' });
    next();
  };
}

module.exports = { ROLES, hashPassword, verifyPassword, createUser, login, middleware, requireCan };
