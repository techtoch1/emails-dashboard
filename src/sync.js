'use strict';
// Pulls one tenant from Google and records today's snapshot. Read-only toward
// Google; every write here is to the local database.
const { GoogleClient, loadKey } = require('./google');
const { tx } = require('./db');

function today() { return new Date().toISOString().slice(0, 10); }
function emailDomain(email) { return email.slice(email.lastIndexOf('@') + 1).toLowerCase(); }

function defaultClientFactory(tenant) {
  const key = loadKey(tenant.key_file || process.env.GOOGLE_SA_KEY_FILE);
  return new GoogleClient({ key, subject: tenant.admin_email });
}

// Products every account can hold at no charge. Google lists a Cloud Identity
// Free license for each account, so it must never count as "the" license.
const FREE_PRODUCTS = new Set(['101001']);

// Picks the license an account is billed on: the Workspace edition when it
// has one, otherwise any other paid license. Free ones only show as extras;
// an account holding nothing paid is 'Unlicensed'.
function splitLicenses(list) {
  const all = list || [];
  const paid = all.filter(l => !FREE_PRODUCTS.has(l.productId));
  const main = paid.find(l => l.productId === 'Google-Apps') || paid[0];
  const extra = all.filter(l => l !== main).map(l => l.sku);
  return { sku: main ? main.sku : 'Unlicensed', extra: extra.length ? extra.join(', ') : null };
}

// Counts per license name, e.g. "Business Starter 241 · Business Standard 10".
function summarizeLicenses(list) {
  const by = {};
  for (const l of list) by[l.sku] = (by[l.sku] || 0) + 1;
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
}

async function collect(tenant, client, date) {
  const warnings = [];
  const warn = m => warnings.push(m);

  let domains = [];
  try {
    domains = await client.listDomains(tenant.customer_id);
  } catch (e) {
    warn(`Domains: ${e.message}`);
  }
  const primary = domains.find(d => d.primary)?.domain || tenant.primary_domain || emailDomain(tenant.admin_email);

  // Users are the one thing a sync cannot do without.
  const users = await client.listUsers(tenant.customer_id);

  let licenses = null;
  try {
    const customerId = tenant.customer_id && tenant.customer_id !== 'my_customer' ? tenant.customer_id : primary;
    licenses = await client.listLicenses(customerId, warn);
  } catch (e) {
    warn(`Licenses: ${e.message} — license column shows "Unknown" until this is fixed`);
  }

  let storage = { date: null, byEmail: new Map() };
  try { storage = await client.userStorage(warn); } catch (e) { warn(`Storage per user: ${e.message}`); }

  let customer = { date: null, seats: {}, storage_used_mb: null, storage_total_mb: null };
  try { customer = await client.customerUsage(warn); } catch (e) { warn(`Tenant usage: ${e.message}`); }

  let events = [];
  try {
    // Google keeps the admin audit log for about six months.
    const since = tenant.last_event_time || new Date(Date.parse(date) - 180 * 86400000).toISOString();
    events = await client.adminEvents(since);
  } catch (e) {
    warn(`Audit log: ${e.message}`);
  }

  return { domains, primary, users, licenses, storage, customer, events, warnings };
}

function record(db, tenant, data, date) {
  const syncedAt = new Date().toISOString();
  const licByEmail = new Map();
  if (data.licenses) for (const l of data.licenses) {
    if (!licByEmail.has(l.email)) licByEmail.set(l.email, []);
    licByEmail.get(l.email).push(l);
  }

  // Domains Google reports for this tenant, plus any domain an account uses
  // that the domain list missed (so "where is this domain hosted" never has a gap).
  const domains = [...data.domains];
  const known = new Set(domains.map(d => d.domain));
  for (const u of data.users) {
    const d = emailDomain(u.primaryEmail);
    if (!known.has(d)) { known.add(d); domains.push({ domain: d, primary: false, verified: null, alias_of: null }); }
  }

  const rows = data.users.map(u => {
    const email = u.primaryEmail.toLowerCase();
    const { sku, extra } = data.licenses ? splitLicenses(licByEmail.get(email)) : { sku: 'Unknown', extra: null };
    const st = data.storage.byEmail.get(email) || {};
    const login = u.lastLoginTime && !u.lastLoginTime.startsWith('1970-') ? u.lastLoginTime : null;
    return {
      email, domain: emailDomain(email), full_name: u.name?.fullName || null,
      status: u.archived ? 'archived' : u.suspended ? 'suspended' : 'active',
      sku, extra_skus: extra,
      gmail_gb: st.gmail_gb ?? null, drive_gb: st.drive_gb ?? null, photos_gb: st.photos_gb ?? null, total_gb: st.total_gb ?? null,
      last_login: login, created_on: u.creationTime || null, org_unit: u.orgUnitPath || null, is_admin: u.isAdmin ? 1 : 0,
    };
  });

  tx(db, () => {
    db.prepare('UPDATE tenants SET primary_domain = ? WHERE id = ?').run(data.primary, tenant.id);

    db.prepare(`INSERT OR REPLACE INTO tenant_snapshots
      (tenant_id, date, synced_at, domains, seats, storage_used_mb, storage_total_mb, usage_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tenant.id, date, syncedAt, JSON.stringify(domains), JSON.stringify(data.customer.seats),
        data.customer.storage_used_mb, data.customer.storage_total_mb, data.storage.date || data.customer.date);

    db.prepare('DELETE FROM account_snapshots WHERE tenant_id = ? AND date = ?').run(tenant.id, date);
    const ins = db.prepare(`INSERT INTO account_snapshots
      (tenant_id, date, email, domain, full_name, status, sku, extra_skus, gmail_gb, drive_gb, photos_gb, total_gb, last_login, created_on, org_unit, is_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      ins.run(tenant.id, date, r.email, r.domain, r.full_name, r.status, r.sku, r.extra_skus,
        r.gmail_gb, r.drive_gb, r.photos_gb, r.total_gb, r.last_login, r.created_on, r.org_unit, r.is_admin);
    }

    const insEv = db.prepare('INSERT OR IGNORE INTO events (tenant_id, time, name, email, actor, detail, uid) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const e of data.events) insEv.run(tenant.id, e.time, e.name, e.email, e.actor, e.detail, e.uid);

    updateLifecycle(db, tenant.id, rows, date);
  });
  return { accounts: rows.length, syncedAt };
}

// Moves the lifecycle registry forward to `date` given the accounts present
// on that date. Shared by the live sync and the legacy importer.
function updateLifecycle(db, tenantId, rows, date) {
  const present = new Set(rows.map(r => r.email));
  const auditFor = db.prepare(`SELECT time, actor FROM events
    WHERE tenant_id = ? AND email = ? AND name = ? ORDER BY time DESC LIMIT 1`);

  const upsert = db.prepare(`INSERT INTO accounts (tenant_id, email, domain, full_name, created_on, first_seen, last_seen, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, email) DO UPDATE SET
      full_name = excluded.full_name,
      created_on = COALESCE(excluded.created_on, accounts.created_on),
      last_seen = MAX(accounts.last_seen, excluded.last_seen),
      created_by = COALESCE(accounts.created_by, excluded.created_by),
      deleted_on = CASE WHEN excluded.last_seen >= COALESCE(accounts.deleted_on, '') THEN NULL ELSE accounts.deleted_on END,
      deleted_by = CASE WHEN excluded.last_seen >= COALESCE(accounts.deleted_on, '') THEN NULL ELSE accounts.deleted_by END`);
  for (const r of rows) {
    const created = auditFor.get(tenantId, r.email, 'CREATE_USER');
    upsert.run(tenantId, r.email, r.domain, r.full_name, r.created_on, date, date, created?.actor || null);
  }

  const gone = db.prepare('SELECT email FROM accounts WHERE tenant_id = ? AND deleted_on IS NULL AND last_seen < ?').all(tenantId, date);
  const mark = db.prepare('UPDATE accounts SET deleted_on = ?, deleted_by = ? WHERE tenant_id = ? AND email = ?');
  for (const { email } of gone) {
    if (present.has(email)) continue;
    const del = auditFor.get(tenantId, email, 'DELETE_USER');
    // Prefer Google's own timestamp; otherwise the first sync that no longer saw it.
    mark.run(del ? del.time.slice(0, 10) : date, del?.actor || null, tenantId, email);
  }
}

async function syncTenant(db, tenant, { clientFactory = defaultClientFactory, date = today() } = {}) {
  const runId = db.prepare('INSERT INTO sync_runs (tenant_id, started_at) VALUES (?, ?)')
    .run(tenant.id, new Date().toISOString()).lastInsertRowid;
  try {
    const last = db.prepare('SELECT MAX(time) t FROM events WHERE tenant_id = ?').get(tenant.id);
    const client = clientFactory(tenant);
    const data = await collect({ ...tenant, last_event_time: last?.t || null }, client, date);
    // The admin email decides which tenant Google answers for. If it belongs
    // to a tenant added earlier, recording it again would duplicate that
    // tenant's accounts and costs; the earlier one keeps syncing.
    const twin = db.prepare('SELECT label FROM tenants WHERE id < ? AND enabled = 1 AND primary_domain = ?').get(tenant.id, data.primary);
    if (twin) {
      throw new Error(`${tenant.admin_email} belongs to the ${data.primary} tenant, which is already added as "${twin.label}". Use an admin of the tenant you mean to add.`);
    }
    const { accounts } = record(db, tenant, data, date);
    db.prepare('UPDATE sync_runs SET finished_at = ?, ok = 1, accounts = ?, warnings = ? WHERE id = ?')
      .run(new Date().toISOString(), accounts, JSON.stringify(data.warnings), runId);
    return { ok: true, accounts, warnings: data.warnings };
  } catch (e) {
    db.prepare('UPDATE sync_runs SET finished_at = ?, ok = 0, error = ? WHERE id = ?')
      .run(new Date().toISOString(), e.message, runId);
    return { ok: false, error: e.message };
  }
}

let running = null;
async function syncAll(db, opts = {}) {
  if (running) return running;
  running = (async () => {
    const tenants = db.prepare('SELECT * FROM tenants WHERE enabled = 1 ORDER BY id').all();
    const results = [];
    for (const t of tenants) results.push({ tenant: t.label, ...(await syncTenant(db, t, opts)) });
    return results;
  })();
  try { return await running; } finally { running = null; }
}
function isSyncing() { return !!running; }

// Checks each API with the tenant's credentials and reports what works —
// the setup screen uses this so a missing scope is named, not guessed at.
async function testTenant(tenant, { clientFactory = defaultClientFactory, others = [] } = {}) {
  const checks = [];
  let client;
  try { client = clientFactory(tenant); } catch (e) { return [{ name: 'Service-account key', ok: false, detail: e.message }]; }
  const run = async (name, fn) => {
    try { checks.push({ name, ok: true, detail: await fn() }); } catch (e) { checks.push({ name, ok: false, detail: e.message }); }
  };
  await run('Sign in as admin (domain-wide delegation)', async () => { await client.accessToken(); return `acting as ${tenant.admin_email}`; });
  if (!checks[0].ok) return checks;
  let primary = tenant.primary_domain;
  await run('Domains', async () => {
    const d = await client.listDomains(tenant.customer_id);
    primary = d.find(x => x.primary)?.domain || primary;
    const twin = others.find(o => o.primary_domain === primary);
    if (twin) throw new Error(`primary domain ${primary} — that tenant is already added as "${twin.label}". This admin email belongs to the wrong tenant.`);
    return `primary domain ${primary}, ${d.length} domain(s)`;
  });
  await run('Users', async () => `${(await client.listUsers(tenant.customer_id)).length} account(s)`);
  await run('Licenses', async () => summarizeLicenses(await client.listLicenses(tenant.customer_id !== 'my_customer' ? tenant.customer_id : primary)));
  await run('Storage report', async () => { const s = await client.userStorage(); return s.date ? `data for ${s.date}` : 'no data yet'; });
  await run('Audit log', async () => `${(await client.adminEvents(new Date(Date.now() - 7 * 86400000).toISOString())).length} event(s) this week`);
  return checks;
}

module.exports = { syncTenant, syncAll, isSyncing, testTenant, updateLifecycle, splitLicenses, summarizeLicenses, today };
