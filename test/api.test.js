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

test('changing a tenant\'s admin clears what was synced from the old one; removing deletes it', async t => {
  const { db, server, as } = await start();
  t.after(() => server.close());
  const admin = await as('admin');
  const { id } = await (await admin('/api/tenants', { method: 'POST', body: { label: 'T', admin_email: 'a@one.example' } })).json();
  db.prepare("INSERT INTO accounts (tenant_id, email, domain, first_seen, last_seen) VALUES (?, 'x@one.example', 'one.example', '2026-01-01', '2026-01-01')").run(id);
  db.prepare("UPDATE tenants SET primary_domain = 'one.example' WHERE id = ?").run(id);

  await admin(`/api/tenants/${id}`, { method: 'PUT', body: { label: 'T renamed', admin_email: 'a@one.example' } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 1, 'a rename keeps the data');

  const r = await (await admin(`/api/tenants/${id}`, { method: 'PUT', body: { label: 'T', admin_email: 'a@two.example' } })).json();
  assert.equal(r.cleared, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 0);
  assert.equal(db.prepare('SELECT primary_domain p FROM tenants WHERE id = ?').get(id).p, null);

  assert.equal((await admin(`/api/tenants/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenants').get().n, 0);
});

test('accountants can start a sync, viewers cannot, and a second one waits for the cooldown', async t => {
  const { server, as } = await start();
  t.after(() => server.close());
  const viewer = await as('viewer'), accountant = await as('accountant');
  assert.equal((await viewer('/api/sync', { method: 'POST' })).status, 403);
  const first = await (await accountant('/api/sync', { method: 'POST' })).json();
  assert.equal(first.started, true);
  await new Promise(r => setTimeout(r, 50)); // no tenants: the sync finishes at once
  const second = await (await accountant('/api/sync', { method: 'POST' })).json();
  assert.equal(second.started, false);
  assert.match(second.message, /try again in 10 min/);
});

test('price import: preview writes nothing, apply saves, viewers cannot import', async t => {
  const { db, server, base } = await start();
  t.after(() => server.close());
  const login = async u => (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: `${u}-password-1` }) })).headers.get('set-cookie').split(';')[0];
  const csv = 'Domain,Monthly price\nclient.example,9\n';
  const up = (cookie, q = '') => fetch(`${base}/api/prices/import${q}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/octet-stream' }, body: csv });
  const acc = await login('accountant'), viewer = await login('viewer');

  assert.equal((await up(viewer)).status, 403);
  const preview = await (await up(acc)).json();
  assert.equal(preview.changes.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM prices').get().n, 0);
  const done = await (await up(acc, '?apply=1')).json();
  assert.equal(done.applied, 1);
  assert.equal(db.prepare("SELECT price FROM prices WHERE domain = 'client.example'").get().price, 9);
});

test('notes on a domain: mentions known users, counts open ones per user, viewers read only', async t => {
  const { server, as } = await start();
  t.after(() => server.close());
  const admin = await as('admin'), accountant = await as('accountant'), viewer = await as('viewer');
  const add = await admin('/api/notes', { method: 'POST', body: { domain: 'client.example', body: '@accountant pays yearly; @nobody is not a user' } });
  const { note } = await add.json();
  assert.deepEqual(note.mentions, ['accountant']);
  assert.equal((await (await accountant('/api/notes')).json()).mine, 1);
  assert.equal((await (await admin('/api/notes')).json()).mine, 0);
  assert.equal((await viewer('/api/notes', { method: 'POST', body: { domain: 'client.example', body: 'hi' } })).status, 403);
  assert.equal((await viewer('/api/notes')).status, 200);
  await accountant(`/api/notes/${note.id}/resolve`, { method: 'POST', body: { resolved: true } });
  const after = await (await accountant('/api/notes')).json();
  assert.equal(after.mine, 0);
  assert.equal(after.notes[0].resolved_by, 'accountant');
});

test('a price of 0 means no price: saving 0 clears it', async t => {
  const { db, server, as } = await start();
  t.after(() => server.close());
  const acc = await as('accountant');
  await acc('/api/prices', { method: 'PUT', body: { domain: 'client.example', price: 6 } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM prices').get().n, 1);
  assert.equal((await acc('/api/prices', { method: 'PUT', body: { domain: 'client.example', price: 0 } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM prices').get().n, 0);
  assert.equal(db.prepare('SELECT new_price FROM price_log ORDER BY id DESC LIMIT 1').get().new_price, null);
});
