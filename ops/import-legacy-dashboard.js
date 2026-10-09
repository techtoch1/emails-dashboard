'use strict';
// One-off: loads the snapshots baked into the old static dashboard.html (the
// one generated before this app existed) so its history is not lost — the
// created/deleted report can then reach back to those dates.
// Usage: npm run import-legacy -- /path/to/dashboard.html
const fs = require('fs');
const path = require('path');
const dbm = require('../src/db');
const { updateLifecycle } = require('../src/sync');

const file = process.argv[2];
if (!file) { console.error('Usage: npm run import-legacy -- /path/to/dashboard.html'); process.exit(1); }
const html = fs.readFileSync(file, 'utf8');
const at = html.indexOf('const PAYLOAD = ');
if (at < 0) { console.error('No PAYLOAD found in that file'); process.exit(1); }
const start = at + 'const PAYLOAD = '.length;
// The payload is one line: `const PAYLOAD = {...};`
const line = html.slice(start, html.indexOf('\n', start)).trim().replace(/;$/, '');
const payload = JSON.parse(line);

const db = dbm.open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'dashboard.db'));
const domainOf = e => e.slice(e.lastIndexOf('@') + 1).toLowerCase();
const iso = s => (!s || s.startsWith('1970-')) ? null : s;

function tenantFor(label, primary) {
  let t = db.prepare('SELECT * FROM tenants WHERE primary_domain = ?').get(primary)
       || db.prepare('SELECT * FROM tenants WHERE label = ?').get(label);
  if (!t) {
    // Placeholder admin address: set the real one in Tenants before the first live sync.
    const id = db.prepare('INSERT INTO tenants (label, admin_email, primary_domain, created_at) VALUES (?, ?, ?, ?)')
      .run(label, `admin@${primary}`, primary, new Date().toISOString()).lastInsertRowid;
    t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    console.log(`Created tenant "${label}" (${primary}) — set its admin email in Tenants`);
  }
  return t;
}

function load(rows, date, syncedAt) {
  if (!rows?.length || !date) return;
  const byTenant = new Map();
  for (const r of rows) {
    if (r.status === 'removed') continue; // gone by then: the lifecycle marks it deleted
    const key = `${r.tenant_label}|${r.tenant_domain}`;
    if (!byTenant.has(key)) byTenant.set(key, []);
    byTenant.get(key).push(r);
  }
  dbm.tx(db, () => {
    for (const [key, list] of byTenant) {
      const [label, primary] = key.split('|');
      const t = tenantFor(label, primary);
      const accounts = list.map(r => ({
        email: r.email.toLowerCase(), domain: domainOf(r.email), full_name: r.full_name || null,
        status: r.status === 'suspended' ? 'suspended' : r.status === 'archived' ? 'archived' : 'active',
        sku: r.license_sku || 'Unlicensed', gmail_gb: r.gmail_gb, drive_gb: r.drive_gb, photos_gb: r.photos_gb, total_gb: r.total_gb,
        last_login: iso(r.last_login), created_on: iso(r.created_on), org_unit: r.org_unit || null,
      }));
      const domains = [...new Set(accounts.map(a => a.domain))].sort()
        .map(d => ({ domain: d, primary: d === primary, verified: null, alias_of: null }));
      db.prepare(`INSERT OR REPLACE INTO tenant_snapshots (tenant_id, date, synced_at, domains, seats) VALUES (?, ?, ?, ?, '{}')`)
        .run(t.id, date, syncedAt || `${date}T00:00:00Z`, JSON.stringify(domains));
      db.prepare('DELETE FROM account_snapshots WHERE tenant_id = ? AND date = ?').run(t.id, date);
      const ins = db.prepare(`INSERT INTO account_snapshots (tenant_id, date, email, domain, full_name, status, sku, gmail_gb, drive_gb, photos_gb, total_gb, last_login, created_on, org_unit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const a of accounts) ins.run(t.id, date, a.email, a.domain, a.full_name, a.status, a.sku, a.gmail_gb, a.drive_gb, a.photos_gb, a.total_gb, a.last_login, a.created_on, a.org_unit);
      updateLifecycle(db, t.id, accounts, date);
      console.log(`${date}  ${label}: ${accounts.length} accounts`);
    }
  });
}

load(payload.prev, payload.prev_date, null);
load(payload.today, payload.today_date, payload.synced_at);

let prices = 0;
for (const [domain, skus] of Object.entries(payload.pricing?.domains || {})) {
  for (const [sku, price] of Object.entries(skus)) {
    if (price == null) continue;
    db.prepare('INSERT OR IGNORE INTO prices (domain, sku, price, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(domain, sku, price, 'legacy import', new Date().toISOString());
    prices++;
  }
}
console.log(`Imported ${prices} price(s).`);
