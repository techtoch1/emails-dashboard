'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const dbm = require('../src/db');
const { plan, apply } = require('../src/priceImport');
const { syncTenant } = require('../src/sync');
const { FakeGoogle } = require('./fake-google');

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Domain Prices');
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function dbWith(users) {
  const db = dbm.open(':memory:');
  db.prepare("INSERT INTO tenants (label, admin_email, created_at) VALUES ('T', 'admin@t.example', 'x')").run();
  const spec = { domains: ['t.example', 'two.example', 'one.example'], users };
  await syncTenant(db, db.prepare('SELECT * FROM tenants').get(), { date: '2026-10-01', clientFactory: () => new FakeGoogle(spec, '2026-10-01') });
  return db;
}
const U = (email, sku) => ({ email, name: email, created: '2026-01-01', sku, gb: 1 });

test('reads the monthly price column, one price per domain or per license', async () => {
  const db = await dbWith([
    U('a@one.example', 'Google Workspace Business Starter'),
    U('a@two.example', 'Google Workspace Business Starter'), U('b@two.example', 'Google Workspace Business Standard'),
  ]);
  const buf = await xlsx([
    ['Domain', 'Plan', 'Unit Price (USD)', 'Yearly Price per Seat (USD)', 'Monthly Price per Seat (USD)', 'Status', 'Note'],
    ['one.example', 'Business Starter', '96', 96, 8, 'Billed', null],
    ['two.example', 'Business Starter', '60', 60, 5, 'Billed', null],
    ['two.example', 'Business Standard', '144', 144, 12, 'Billed', null],
    ['new.example', 'Business Standard', '192', 192, 16, 'Billed', null],
    ['new.example', 'Business Starter', '81.6', 81.6, 6.8, 'Billed', null],
    ['free.example', 'Business Starter', null, null, null, 'NOT BILLED', 'No Odoo subscription'],
  ]);
  const p = await plan(db, buf);
  assert.equal(p.columns.price, 'Monthly Price per Seat (USD)');
  const got = Object.fromEntries(p.changes.map(c => [`${c.domain}|${c.sku}`, c.price]));
  assert.deepEqual(got, {
    'one.example|*': 8,
    'two.example|Google Workspace Business Starter': 5,
    'two.example|Google Workspace Business Standard': 12,
    'new.example|Google Workspace Business Standard': 16,
    'new.example|Google Workspace Business Starter': 6.8,
  });
  assert.deepEqual(p.skipped, [{ line: 7, domain: 'free.example', license: 'Business Starter', reason: 'NOT BILLED — No Odoo subscription' }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM prices').get().n, 0, 'planning writes nothing');

  apply(db, p.changes, 'acc');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM prices').get().n, 5);
  assert.equal(db.prepare("SELECT changed_by FROM price_log LIMIT 1").get().changed_by, 'acc (import)');
  const again = await plan(db, buf);
  assert.equal(again.changes.length, 0);
  assert.equal(again.unchanged, 5);
});

test('a CSV works too, and a sheet without a price column is refused clearly', async () => {
  const db = await dbWith([U('a@one.example', 'Google Workspace Business Starter')]);
  const p = await plan(db, Buffer.from('﻿Domain,Price\r\none.example,"7.50"\r\n'));
  assert.deepEqual(p.changes.map(c => [c.domain, c.sku, c.price]), [['one.example', '*', 7.5]]);
  await assert.rejects(plan(db, Buffer.from('Domain,Users\none.example,3\n')), /No price column/);
});

test('0 is no price: zeros saved earlier are cleared on open, and a 0 in a file is skipped', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-')), 'z.db');
  let db = dbm.open(file);
  db.prepare("INSERT INTO prices (domain, sku, price, updated_at) VALUES ('free.example', '*', 0, 'x'), ('paid.example', '*', 6, 'x')").run();
  db.close();
  db = dbm.open(file);
  assert.deepEqual(db.prepare('SELECT domain FROM prices').all().map(r => r.domain), ['paid.example']);
  assert.equal(db.prepare("SELECT changed_by FROM price_log WHERE domain = 'free.example'").get().changed_by, 'system (0 = no price)');

  const p = await plan(db, Buffer.from('Domain,Price\nzero.example,0\n'));
  assert.equal(p.changes.length, 0);
  assert.equal(p.skipped[0].domain, 'zero.example');
});
