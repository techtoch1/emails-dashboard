'use strict';
// Fills a database with invented tenants, domains and accounts — every name
// here is fictional — by replaying 100 days of daily syncs through the real
// sync code. For trying the dashboard before any tenant is connected:
//   DB_FILE=data/demo.db npm run demo && DB_FILE=data/demo.db npm start
const path = require('path');
const dbm = require('../src/db');
const auth = require('../src/auth');
const { syncTenant } = require('../src/sync');
const { FakeGoogle } = require('../test/fake-google');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'demo.db');
if (/dashboard\.db$/.test(file)) { console.error('Refusing to seed demo data into the real database'); process.exit(1); }
require('fs').rmSync(file, { force: true });
const db = dbm.open(file);

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)];
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const FIRST = ['Rami', 'Nour', 'Karim', 'Lea', 'Hadi', 'Maya', 'Omar', 'Rita', 'Ziad', 'Yara', 'Sami', 'Dana', 'Fadi', 'Hala', 'Tarek', 'Joelle'];
const LAST = ['Haddad', 'Khoury', 'Saleh', 'Nassar', 'Aoun', 'Frem', 'Daher', 'Karam', 'Rizk', 'Mansour'];

const TENANTS = [
  { label: 'Partner tenant A', domains: ['tenant-a.example', 'cedarlogistics.example', 'bluewave.example', 'harbor-legal.example', 'olivegrove.example'], size: [60, 30, 12, 8, 5], sku: ['Business Starter', 'Business Standard'], seats: 140 },
  { label: 'Partner tenant B', domains: ['tenant-b.example', 'northstar-media.example', 'pinecrest.example'], size: [4, 45, 18], sku: ['Business Standard', 'Business Plus'], seats: 70 },
  { label: 'Partner tenant C', domains: ['tenant-c.example', 'summit-eng.example', 'riverbank.example'], size: [3, 22, 14], sku: ['Business Starter'], seats: null },
  { label: 'Partner tenant D', domains: ['tenant-d.example', 'atlas-clinics.example'], size: [2, 28], sku: ['Business Standard'], seats: 32 },
  { label: 'Partner tenant E', domains: ['tenant-e.example', 'lumen-studio.example'], size: [2, 9], sku: ['Business Starter', 'Business Standard'], seats: null },
];

const specs = TENANTS.map(t => {
  const users = [];
  t.domains.forEach((d, i) => {
    for (let n = 0; n < t.size[i]; n++) {
      const f = pick(FIRST), l = pick(LAST);
      const created = rnd() < 0.85 ? day(120 + Math.floor(rnd() * 400)) : day(Math.floor(rnd() * 100));
      const deleted = rnd() < 0.08 ? day(Math.floor(rnd() * 90)) : null;
      users.push({
        email: `${f}.${l}${n}@${d}`.toLowerCase(), name: `${f} ${l}`, created,
        deleted: deleted && deleted > created ? deleted : null,
        sku: rnd() < 0.9 ? pick(t.sku) : null, suspended: rnd() < 0.04,
        gb: Math.round(rnd() ** 2 * 28 * 100) / 100,
        lastLogin: rnd() < 0.93 ? `${day(Math.floor(rnd() ** 3 * 120))}T08:00:00.000Z` : null,
      });
    }
  });
  return { ...t, users, actor: `admin@${t.domains[0]}` };
});

(async () => {
  for (const s of specs) {
    const id = db.prepare('INSERT INTO tenants (label, admin_email, primary_domain, created_at) VALUES (?, ?, ?, ?)')
      .run(s.label, s.actor, s.domains[0], new Date().toISOString()).lastInsertRowid;
    s.id = id;
    if (s.seats) db.prepare('INSERT INTO seat_overrides (tenant_id, sku, seats) VALUES (?, ?, ?)').run(id, s.sku[0], s.seats);
  }
  for (let back = 100; back >= 0; back--) {
    const date = day(back);
    for (const s of specs) {
      const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(s.id);
      const r = await syncTenant(db, t, { date, clientFactory: () => new FakeGoogle(s, date) });
      if (!r.ok) throw new Error(r.error);
    }
  }
  const now = new Date().toISOString();
  specs.forEach((s, i) => s.domains.slice(1).forEach((d, j) => {
    if ((i + j) % 4 === 3) return; // leave a few unpriced, as in real life
    db.prepare('INSERT INTO prices (domain, sku, price, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)').run(d, '*', [6, 7.2, 8, 12, 14.4][(i + j) % 5], 'demo', now);
  }));
  db.prepare("INSERT INTO prices (domain, sku, price, updated_by, updated_at) VALUES ('northstar-media.example', 'Business Plus', 22, 'demo', ?)").run(now);
  auth.createUser(db, { username: 'demo', role: 'admin', name: 'Demo admin', password: 'demo-password-1' });
  console.log(`Demo database written to ${file} — sign in as demo / demo-password-1`);
})();
