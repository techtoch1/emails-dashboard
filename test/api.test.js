'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dbm = require('../src/db');
const auth = require('../src/auth');
const { createApp } = require('../server');

async function start() {
  const db = dbm.open(':memory:');
  for (const role of ['admin', 'accountant', 'viewer']) auth.createUser(db, { username: role, role, password: `${role}-password-1` });
  const server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async role => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: role, password: `${role}-password-1` }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return (path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie, 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  };
  return { db, server, base, as };
}

test('roles: viewers read, accountants price, only admins manage tenants', async t => {
  const { db, server, base, as } = await start();
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);

  const viewer = await as('viewer'), accountant = await as('accountant'), admin = await as('admin');
  assert.equal((await viewer('/api/overview')).status, 200);
  const price = { domain: 'client.example', price: 7.5 };
  assert.equal((await viewer('/api/prices', { method: 'PUT', body: price })).status, 403);
  assert.equal((await accountant('/api/prices', { method: 'PUT', body: price })).status, 200);
  assert.equal(db.prepare("SELECT price FROM prices WHERE domain = 'client.example'").get().price, 7.5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM price_log').get().n, 1);
  assert.equal((await accountant('/api/prices', { method: 'PUT', body: { domain: 'client.example', price: -1 } })).status, 400);

  const tenant = { label: 'T', admin_email: 'admin@t.example' };
  assert.equal((await accountant('/api/tenants', { method: 'POST', body: tenant })).status, 403);
  assert.equal((await admin('/api/tenants', { method: 'POST', body: tenant })).status, 200);
  assert.equal((await admin('/api/tenants', { method: 'POST', body: { label: 'X', admin_email: 'nope' } })).status, 400);
});

test('login is refused with a wrong password', async t => {
  const { server, base } = await start();
  t.after(() => server.close());
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
  assert.equal(r.status, 401);
});
