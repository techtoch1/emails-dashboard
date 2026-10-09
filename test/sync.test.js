'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dbm = require('../src/db');
const { syncTenant } = require('../src/sync');
const reports = require('../src/reports');
const { FakeGoogle } = require('./fake-google');

function setup(users, extra = {}) {
  const db = dbm.open(':memory:');
  const id = db.prepare("INSERT INTO tenants (label, admin_email, created_at) VALUES ('T1', 'admin@t1.example', '2026-01-01')").run().lastInsertRowid;
  const spec = { domains: ['t1.example', 'client.example'], users, ...extra };
  const run = date => syncTenant(db, db.prepare('SELECT * FROM tenants WHERE id = ?').get(id), { date, clientFactory: () => new FakeGoogle(spec, date) });
  return { db, run, spec };
}

const U = (email, created, o = {}) => ({ email, name: email.split('@')[0], created, sku: 'Business Starter', gb: 1, ...o });

test('records created and deleted accounts per domain, with the audit-log dates', async () => {
  const { db, run } = setup([
    U('a@client.example', '2026-01-10'),
    U('b@client.example', '2026-03-05'),
    U('c@client.example', '2026-01-10', { deleted: '2026-03-12' }),
  ]);
  for (const d of ['2026-03-01', '2026-03-10', '2026-03-20']) assert.ok((await run(d)).ok);
  const ch = reports.changes(db, '2026-03-01', '2026-03-31');
  assert.deepEqual(ch.rows.map(r => [r.change, r.email, r.date]).sort(), [
    ['created', 'b@client.example', '2026-03-05'],
    ['deleted', 'c@client.example', '2026-03-12'],
  ]);
  assert.equal(ch.rows.find(r => r.change === 'deleted').source, 'audit log');
  const o = reports.overview(db);
  assert.equal(o.totals.accounts, 2);
  assert.deepEqual(o.domains.find(d => d.domain === 'client.example').tenants, ['T1']);
  assert.ok(o.domains.some(d => d.domain === 't1.example'), 'tenant domains are listed even with no accounts');
});

test('a missing licensing permission is a warning, not a failed sync', async () => {
  const { db, run } = setup([U('a@client.example', '2026-01-10')], { failLicenses: true });
  const r = await run('2026-03-01');
  assert.ok(r.ok);
  assert.match(r.warnings.join(' '), /Licenses/);
  assert.equal(reports.currentAccounts(db)[0].sku, 'Unknown');
});

test('prices: license-specific beats domain price; unlicensed is free unless priced', () => {
  const p = new Map([['d.example|*', 6], ['d.example|Business Plus', 18]]);
  assert.equal(reports.priceFor(p, 'd.example', 'Business Starter'), 6);
  assert.equal(reports.priceFor(p, 'd.example', 'Business Plus'), 18);
  assert.equal(reports.priceFor(p, 'd.example', 'Unlicensed'), 0);
  assert.equal(reports.priceFor(p, 'other.example', 'Business Starter'), null);
});

test('monthly billing prorates by the days an account existed', async () => {
  const { db, run } = setup([
    U('full@client.example', '2026-01-01'),
    U('half@client.example', '2026-04-16'),
    U('free@client.example', '2026-01-01', { sku: null }),
  ]);
  for (const d of ['2026-03-31', '2026-04-16']) await run(d);
  db.prepare("INSERT INTO prices (domain, sku, price, updated_at) VALUES ('client.example', '*', 30, 'x')").run();
  const m = reports.monthly(db, '2026-04', '2026-05-01');
  const cost = e => m.accounts.find(a => a.email === e).cost;
  assert.equal(cost('full@client.example'), 30);
  assert.equal(cost('half@client.example'), 15); // present 16th–30th = 15 of 30 days
  assert.equal(cost('free@client.example'), 0);
  assert.equal(m.total, 45);
  assert.equal(m.projected, false);
});

test('CSV export neutralises spreadsheet formulas', () => {
  const csv = reports.toCsv([{ key: 'a', label: 'A' }], [{ a: '=HYPERLINK("x")' }, { a: -5 }]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /\r\n-5$/);
});

test('a free Cloud Identity license never counts as the billed license', () => {
  const { splitLicenses } = require('../src/sync');
  const ci = { productId: '101001', sku: 'Cloud Identity Free' };
  const starter = { productId: 'Google-Apps', sku: 'Business Starter' };
  assert.deepEqual(splitLicenses([ci, starter]), { sku: 'Business Starter', extra: 'Cloud Identity Free' });
  assert.deepEqual(splitLicenses([ci]), { sku: 'Unlicensed', extra: 'Cloud Identity Free' });
  assert.deepEqual(splitLicenses([]), { sku: 'Unlicensed', extra: null });
});

test('a second tenant read through an admin of the first is refused, the first keeps syncing', async () => {
  const db = dbm.open(':memory:');
  const add = label => db.prepare("INSERT INTO tenants (label, admin_email, created_at) VALUES (?, 'admin@t1.example', 'x')").run(label).lastInsertRowid;
  const first = add('First'), second = add('Second by mistake');
  const spec = { domains: ['t1.example'], users: [U('a@t1.example', '2026-01-10')] };
  const sync = id => syncTenant(db, db.prepare('SELECT * FROM tenants WHERE id = ?').get(id), { date: '2026-03-01', clientFactory: () => new FakeGoogle(spec, '2026-03-01') });
  assert.ok((await sync(first)).ok);
  const r = await sync(second);
  assert.equal(r.ok, false);
  assert.match(r.error, /already added as "First"/);
  assert.ok((await sync(first)).ok);
  assert.equal(reports.overview(db).totals.accounts, 1);
});
