'use strict';
// Creates the first admin login from WSD_ADMIN_USER / WSD_ADMIN_PASSWORD, but
// only while the dashboard has no users at all. Re-running a deploy never
// resets a password or adds a second account.
const path = require('path');
const dbm = require('../src/db');
const auth = require('../src/auth');

const username = process.env.WSD_ADMIN_USER;
const password = process.env.WSD_ADMIN_PASSWORD;
const db = dbm.open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'dashboard.db'));
const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
if (count) {
  console.log(`Dashboard already has ${count} user(s); leaving logins as they are.`);
} else if (!username || !password) {
  console.log('No dashboard users yet, and WSD_ADMIN_USER / WSD_ADMIN_PASSWORD are not set — create one with ops/add-user.js.');
} else {
  auth.createUser(db, { username, password, role: 'admin', name: username });
  console.log(`Created the first admin login "${username}".`);
}
