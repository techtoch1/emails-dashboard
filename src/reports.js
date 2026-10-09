'use strict';
// Everything the screens show is computed here from the snapshots.

const NOT_BILLED = new Set(['Unlicensed', 'Unknown', 'Cloud Identity Free']);
// Accounts with no paid Workspace license have no mailbox you provide, so
// they are left out of every count unless asked for. 'Unknown' (license not
// readable) stays visible so a permission problem cannot hide accounts.
const NO_WORKSPACE = new Set(['Unlicensed', 'Cloud Identity Free']);
const isHidden = r => NO_WORKSPACE.has(r.sku);

function loadPrices(db) {
  const m = new Map();
  for (const p of db.prepare('SELECT domain, sku, price FROM prices').all()) m.set(`${p.domain}|${p.sku}`, p.price);
  return m;
}

// Monthly price for one account: one price per domain, the same for every
// licensed email on it whatever the license. Unlicensed accounts cost nothing.
function priceFor(prices, domain, sku) {
  if (NOT_BILLED.has(sku)) return 0;
  const p = prices.get(`${domain}|*`);
  return p != null ? p : null; // null = no price entered yet
}

function tenantMap(db) {
  const m = new Map();
  for (const t of db.prepare('SELECT * FROM tenants').all()) m.set(t.id, t);
  return m;
}

function latestDates(db) {
  return db.prepare('SELECT tenant_id, MAX(date) date FROM tenant_snapshots GROUP BY tenant_id').all();
}

function currentAccounts(db, { all = false } = {}) {
  const tenants = tenantMap(db);
  const prices = loadPrices(db);
  const out = [];
  const stmt = db.prepare('SELECT * FROM account_snapshots WHERE tenant_id = ? AND date = ? ORDER BY email');
  for (const { tenant_id, date } of latestDates(db)) {
    const t = tenants.get(tenant_id);
    if (!t || !t.enabled) continue;
    for (const r of stmt.all(tenant_id, date)) {
      if (!all && isHidden(r)) continue;
      out.push({ ...r, tenant: t.label, snapshot_date: date, monthly_cost: priceFor(prices, r.domain, r.sku) });
    }
  }
  return out;
}

function sum(arr, f) { let s = 0; for (const x of arr) { const v = f(x); if (v != null) s += v; } return Math.round(s * 100) / 100; }
function countBy(arr, f) { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] || 0) + 1; } return m; }

function overview(db) {
  const everyone = currentAccounts(db, { all: true });
  const accounts = everyone.filter(a => !isHidden(a));
  const tenants = tenantMap(db);
  const snaps = new Map();
  for (const { tenant_id, date } of latestDates(db)) {
    snaps.set(tenant_id, db.prepare('SELECT * FROM tenant_snapshots WHERE tenant_id = ? AND date = ?').get(tenant_id, date));
  }
  const overrides = db.prepare('SELECT * FROM seat_overrides').all();
  const lastRun = db.prepare(`SELECT r.* FROM sync_runs r JOIN (SELECT tenant_id, MAX(id) id FROM sync_runs GROUP BY tenant_id) l ON l.id = r.id`).all();
  const runBy = new Map(lastRun.map(r => [r.tenant_id, r]));

  const tenantRows = [];
  for (const t of tenants.values()) {
    if (!t.enabled) continue;
    const mine = accounts.filter(a => a.tenant_id === t.id);
    const snap = snaps.get(t.id);
    const assigned = countBy(mine.filter(a => !NOT_BILLED.has(a.sku)), a => a.sku);
    // Seats: an admin-entered purchase count wins; otherwise what Google reports.
    const licenses = Object.entries(assigned).map(([sku, used]) => {
      const o = overrides.find(x => x.tenant_id === t.id && x.sku === sku);
      return { sku, assigned: used, purchased: o ? o.seats : null, remaining: o ? o.seats - used : null, source: o ? 'entered' : null };
    });
    for (const o of overrides.filter(x => x.tenant_id === t.id && !assigned[x.sku])) {
      licenses.push({ sku: o.sku, assigned: 0, purchased: o.seats, remaining: o.seats, source: 'entered' });
    }
    const googleSeats = snap ? JSON.parse(snap.seats) : {};
    const run = runBy.get(t.id);
    tenantRows.push({
      id: t.id, label: t.label, admin_email: t.admin_email, primary_domain: t.primary_domain,
      snapshot_date: snap?.date || null, usage_date: snap?.usage_date || null,
      accounts: mine.length,
      status: countBy(mine, a => a.status),
      licenses: licenses.sort((a, b) => b.assigned - a.assigned),
      google_seats: googleSeats,
      hidden: everyone.filter(a => a.tenant_id === t.id && isHidden(a)).length,
      storage_gb: sum(mine, a => a.total_gb),
      pooled_used_gb: snap?.storage_used_mb != null ? Math.round(snap.storage_used_mb / 1024 * 100) / 100 : null,
      pooled_total_gb: snap?.storage_total_mb != null ? Math.round(snap.storage_total_mb / 1024 * 100) / 100 : null,
      domains: snap ? JSON.parse(snap.domains) : [],
      monthly_cost: sum(mine, a => a.monthly_cost),
      unpriced: mine.filter(a => a.monthly_cost == null).length,
      last_sync: run ? { at: run.finished_at || run.started_at, ok: !!run.ok, error: run.error, warnings: run.warnings ? JSON.parse(run.warnings) : [] } : null,
    });
  }

  // Per domain. A domain normally lives in exactly one tenant; if it appears
  // in two (mid-migration), both are listed.
  const byDomain = new Map();
  for (const t of tenantRows) for (const d of t.domains) {
    if (!byDomain.has(d.domain)) byDomain.set(d.domain, { domain: d.domain, tenants: new Set(), alias_of: d.alias_of, verified: d.verified, accounts: [] });
    byDomain.get(d.domain).tenants.add(t.label);
  }
  for (const a of accounts) {
    if (!byDomain.has(a.domain)) byDomain.set(a.domain, { domain: a.domain, tenants: new Set(), accounts: [] });
    const d = byDomain.get(a.domain);
    d.tenants.add(a.tenant);
    d.accounts.push(a);
  }
  const prices = loadPrices(db);
  const domainRows = [...byDomain.values()].map(d => ({
    domain: d.domain,
    tenants: [...d.tenants].sort(),
    alias_of: d.alias_of || null,
    accounts: d.accounts.length,
    active: d.accounts.filter(a => a.status === 'active').length,
    suspended: d.accounts.filter(a => a.status === 'suspended').length,
    archived: d.accounts.filter(a => a.status === 'archived').length,
    licenses: countBy(d.accounts, a => a.sku),
    storage_gb: sum(d.accounts, a => a.total_gb),
    monthly_cost: sum(d.accounts, a => a.monthly_cost),
    unpriced: d.accounts.filter(a => a.monthly_cost == null).length,
    price: prices.get(`${d.domain}|*`) ?? null,
  })).sort((a, b) => b.accounts - a.accounts || a.domain.localeCompare(b.domain));

  return {
    currency: require('./db').getSetting(db, 'currency', 'USD'),
    totals: {
      accounts: accounts.length,
      active: accounts.filter(a => a.status === 'active').length,
      suspended: accounts.filter(a => a.status === 'suspended').length,
      archived: accounts.filter(a => a.status === 'archived').length,
      licensed: accounts.filter(a => !NOT_BILLED.has(a.sku)).length,
      hidden: everyone.length - accounts.length,
      domains: domainRows.filter(d => d.accounts > 0).length,
      tenants: tenantRows.length,
      storage_gb: sum(accounts, a => a.total_gb),
      monthly_cost: sum(accounts, a => a.monthly_cost),
      unpriced_accounts: accounts.filter(a => a.monthly_cost == null).length,
    },
    tenants: tenantRows,
    domains: domainRows,
  };
}

// Accounts created and deleted between two dates (inclusive). "Created" uses
// Google's own creation time; "deleted" uses the audit-log time when Google
// reported one, otherwise the first sync that no longer found the account.
function changes(db, from, to) {
  const tenants = tenantMap(db);
  const prices = loadPrices(db);
  const lastSku = db.prepare(`SELECT sku, status FROM account_snapshots WHERE tenant_id = ? AND email = ? ORDER BY date DESC LIMIT 1`);
  const rows = [];
  for (const a of db.prepare('SELECT * FROM accounts').all()) {
    const t = tenants.get(a.tenant_id);
    if (!t) continue;
    const createdDate = (a.created_on || a.first_seen).slice(0, 10);
    const snap = lastSku.get(a.tenant_id, a.email) || {};
    if (isHidden(snap)) continue;
    const base = { tenant: t.label, email: a.email, domain: a.domain, full_name: a.full_name, sku: snap.sku || null, monthly_cost: snap.sku ? priceFor(prices, a.domain, snap.sku) : null };
    if (createdDate >= from && createdDate <= to) rows.push({ ...base, change: 'created', date: createdDate, by: a.created_by, source: a.created_on ? 'Google' : 'first sync' });
    if (a.deleted_on && a.deleted_on >= from && a.deleted_on <= to) rows.push({ ...base, change: 'deleted', date: a.deleted_on, by: a.deleted_by, source: a.deleted_by ? 'audit log' : 'missing from sync' });
  }
  rows.sort((x, y) => y.date.localeCompare(x.date) || x.email.localeCompare(y.email));
  const events = db.prepare('SELECT e.*, t.label tenant FROM events e JOIN tenants t ON t.id = e.tenant_id WHERE substr(e.time,1,10) BETWEEN ? AND ? ORDER BY e.time DESC').all(from, to);
  return { from, to, rows, events };
}

function daysInMonth(month) { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

// Billing for one calendar month, prorated by day like Google's Flexible plan:
// each account costs price × (days it held its license that month ÷ days in month).
// Days with no sync carry the previous sync forward; days after the newest
// sync are projected from it.
function monthly(db, month, todayStr = new Date().toISOString().slice(0, 10)) {
  const tenants = tenantMap(db);
  const prices = loadPrices(db);
  const nDays = daysInMonth(month);
  const start = `${month}-01`;
  const end = `${month}-${String(nDays).padStart(2, '0')}`;
  const perAccount = new Map();
  let firstCovered = null;

  for (const t of tenants.values()) {
    if (!t.enabled) continue;
    const dates = db.prepare(`SELECT date FROM tenant_snapshots WHERE tenant_id = ? AND date <= ? AND date >= COALESCE(
        (SELECT MAX(date) FROM tenant_snapshots WHERE tenant_id = ? AND date <= ?), ?) ORDER BY date`)
      .all(t.id, end, t.id, start, start).map(r => r.date);
    if (!dates.length) continue;
    const cache = new Map();
    const rowsFor = d => {
      if (!cache.has(d)) cache.set(d, db.prepare('SELECT * FROM account_snapshots WHERE tenant_id = ? AND date = ?').all(t.id, d));
      return cache.get(d);
    };
    for (let day = 1; day <= nDays; day++) {
      const ds = `${month}-${String(day).padStart(2, '0')}`;
      let snapDate = null;
      for (const d of dates) if (d <= ds) snapDate = d;
      if (!snapDate) continue;
      if (!firstCovered || ds < firstCovered) firstCovered = ds;
      for (const r of rowsFor(snapDate)) {
        if (isHidden(r)) continue;
        const price = priceFor(prices, r.domain, r.sku);
        const key = `${t.id}|${r.email}|${r.sku}`;
        if (!perAccount.has(key)) perAccount.set(key, { tenant: t.label, email: r.email, domain: r.domain, full_name: r.full_name, sku: r.sku, status: r.status, price, days: 0 });
        const acc = perAccount.get(key);
        acc.days++;
        acc.status = r.status;
      }
    }
  }

  const accounts = [...perAccount.values()].map(a => ({
    ...a,
    cost: a.price == null ? null : Math.round(a.price * a.days / nDays * 100) / 100,
  })).sort((a, b) => a.domain.localeCompare(b.domain) || a.email.localeCompare(b.email));

  const ch = changes(db, start, end);
  const domains = new Map();
  const dom = d => {
    if (!domains.has(d)) domains.set(d, { domain: d, tenants: new Set(), accounts: 0, licensed: 0, license_days: 0, cost: 0, unpriced: 0, created: 0, deleted: 0 });
    return domains.get(d);
  };
  for (const a of accounts) {
    const d = dom(a.domain);
    d.tenants.add(a.tenant);
    d.accounts++;
    if (!NOT_BILLED.has(a.sku)) { d.licensed++; d.license_days += a.days; }
    if (a.cost == null) d.unpriced++; else d.cost += a.cost;
  }
  for (const r of ch.rows) dom(r.domain)[r.change]++;
  const domainRows = [...domains.values()].map(d => ({ ...d, tenants: [...d.tenants], cost: Math.round(d.cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost || a.domain.localeCompare(b.domain));

  return {
    month, start, end, days: nDays,
    projected: end > todayStr,
    covered_from: firstCovered,
    currency: require('./db').getSetting(db, 'currency', 'USD'),
    total: Math.round(accounts.reduce((s, a) => s + (a.cost || 0), 0) * 100) / 100,
    unpriced_accounts: accounts.filter(a => a.cost == null).length,
    domains: domainRows,
    accounts,
    changes: ch.rows,
  };
}

function toCsv(columns, rows) {
  const esc = v => {
    if (v == null) return '';
    const s = Array.isArray(v) ? v.join('; ') : String(v);
    // Leading = + - @ would be run as a formula by Excel.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + [columns.map(c => esc(c.label)).join(','), ...rows.map(r => columns.map(c => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','))].join('\r\n');
}

module.exports = { isHidden, overview, currentAccounts, changes, monthly, priceFor, loadPrices, toCsv, NOT_BILLED };
