'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');

const dbm = require('./src/db');
const auth = require('./src/auth');
const reports = require('./src/reports');
const sync = require('./src/sync');
const { SCOPES, loadKey } = require('./src/google');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createApp(db, { clientFactory } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // nginx in front: req.secure and req.ip come from it
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
    });
    next();
  });
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use(auth.middleware(db));
  app.use(express.static(path.join(__dirname, 'public')));

  const can = auth.requireCan;
  const syncOpts = clientFactory ? { clientFactory } : {};

  // ---- session -----------------------------------------------------------
  const attempts = new Map();
  app.post('/api/login', (req, res) => {
    const key = req.ip;
    const a = attempts.get(key) || { n: 0, until: 0 };
    if (a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts — wait a minute' });
    const token = auth.login(db, req.body?.username, req.body?.password);
    if (!token) {
      a.n++;
      if (a.n >= 5) { a.until = Date.now() + 60_000; a.n = 0; }
      attempts.set(key, a);
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    attempts.delete(key);
    res.cookie('wsd_session', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 7 * 86400000 });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    if (req.cookies?.wsd_session) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.wsd_session);
    res.clearCookie('wsd_session');
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    res.json({ user: req.user, syncing: sync.isSyncing() });
  });

  // ---- reports -----------------------------------------------------------
  app.get('/api/overview', can('view'), (req, res) => res.json(reports.overview(db)));

  const ACCOUNT_COLS = [
    { key: 'email', label: 'Email' }, { key: 'full_name', label: 'Name' }, { key: 'domain', label: 'Domain' },
    { key: 'tenant', label: 'Tenant' }, { key: 'status', label: 'Status' }, { key: 'sku', label: 'License' },
    { key: 'extra_skus', label: 'Other licenses' },
    { key: 'gmail_gb', label: 'Gmail GB' }, { key: 'drive_gb', label: 'Drive GB' }, { key: 'photos_gb', label: 'Photos GB' }, { key: 'total_gb', label: 'Total GB' },
    { get: r => r.last_login ? r.last_login.slice(0, 10) : 'Never', label: 'Last login' },
    { get: r => r.created_on ? r.created_on.slice(0, 10) : '', label: 'Created' },
    { key: 'org_unit', label: 'Org unit' }, { key: 'monthly_cost', label: 'Monthly cost' },
  ];
  app.get('/api/accounts', can('view'), (req, res) => res.json({ accounts: reports.currentAccounts(db, { all: req.query.all === '1' }) }));
  app.get('/api/accounts.csv', can('view'), (req, res) => {
    sendCsv(res, `accounts-${sync.today()}.csv`, reports.toCsv(ACCOUNT_COLS, reports.currentAccounts(db, { all: req.query.all === '1' })));
  });

  function range(req) {
    const t = new Date();
    const from = DATE_RE.test(req.query.from) ? req.query.from : `${t.toISOString().slice(0, 7)}-01`;
    const to = DATE_RE.test(req.query.to) ? req.query.to : t.toISOString().slice(0, 10);
    return [from, to];
  }
  const CHANGE_COLS = [
    { key: 'date', label: 'Date' }, { key: 'change', label: 'Change' }, { key: 'email', label: 'Email' }, { key: 'full_name', label: 'Name' },
    { key: 'domain', label: 'Domain' }, { key: 'tenant', label: 'Tenant' }, { key: 'sku', label: 'License' },
    { key: 'monthly_cost', label: 'Monthly cost' }, { key: 'by', label: 'By' }, { key: 'source', label: 'Source' },
  ];
  app.get('/api/changes', can('view'), (req, res) => res.json(reports.changes(db, ...range(req))));
  app.get('/api/changes.csv', can('view'), (req, res) => {
    const [from, to] = range(req);
    sendCsv(res, `created-deleted-${from}-to-${to}.csv`, reports.toCsv(CHANGE_COLS, reports.changes(db, from, to).rows));
  });

  function month(req) { return /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7); }
  app.get('/api/monthly', can('view'), (req, res) => res.json(reports.monthly(db, month(req))));
  app.get('/api/monthly.csv', can('view'), (req, res) => {
    const m = month(req);
    const cols = [
      { key: 'domain', label: 'Domain' }, { key: 'tenant', label: 'Tenant' }, { key: 'email', label: 'Email' }, { key: 'full_name', label: 'Name' },
      { key: 'sku', label: 'License' }, { key: 'status', label: 'Status at month end' }, { key: 'price', label: 'Monthly price' },
      { key: 'days', label: 'Days in month' }, { key: 'cost', label: 'Cost (prorated)' },
    ];
    sendCsv(res, `billing-${m}.csv`, reports.toCsv(cols, reports.monthly(db, m).accounts));
  });

  // ---- prices (accountant) ----------------------------------------------
  app.get('/api/prices', can('view'), (req, res) => {
    const ov = reports.overview(db);
    const prices = db.prepare('SELECT * FROM prices ORDER BY domain, sku').all();
    res.json({ currency: ov.currency, domains: ov.domains, prices });
  });
  app.put('/api/prices', can('prices'), (req, res) => {
    const domain = String(req.body?.domain || '').toLowerCase().trim();
    // '*' = the domain's single price; a license name = that license on the domain.
    const sku = String(req.body?.sku || '*').trim() || '*';
    if (sku.length > 80) return res.status(400).json({ error: 'Invalid license' });
    const raw = req.body?.price;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return res.status(400).json({ error: 'Invalid domain' });
    const price = raw === null || raw === '' ? null : Number(raw);
    if (price !== null && (!Number.isFinite(price) || price < 0)) return res.status(400).json({ error: 'Price must be a number ≥ 0' });
    const now = new Date().toISOString();
    dbm.tx(db, () => {
      const old = db.prepare('SELECT price FROM prices WHERE domain = ? AND sku = ?').get(domain, sku);
      if ((old?.price ?? null) === price) return;
      if (price === null) db.prepare('DELETE FROM prices WHERE domain = ? AND sku = ?').run(domain, sku);
      else db.prepare(`INSERT INTO prices (domain, sku, price, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, sku) DO UPDATE SET price = excluded.price, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(domain, sku, price, req.body?.note || null, req.user.username, now);
      db.prepare('INSERT INTO price_log (domain, sku, old_price, new_price, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(domain, sku, old?.price ?? null, price, req.user.username, now);
    });
    res.json({ ok: true });
  });
  app.get('/api/prices/log', can('view'), (req, res) => {
    res.json({ log: db.prepare('SELECT * FROM price_log ORDER BY id DESC LIMIT 200').all() });
  });
  app.put('/api/settings/currency', can('prices'), (req, res) => {
    const c = String(req.body?.currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) return res.status(400).json({ error: 'Use a 3-letter currency code' });
    dbm.setSetting(db, 'currency', c);
    res.json({ ok: true });
  });

  // ---- tenants & sync (admin) --------------------------------------------
  app.get('/api/setup', can('tenants'), (req, res) => {
    let serviceAccount = null;
    try {
      const k = loadKey(process.env.GOOGLE_SA_KEY_FILE);
      serviceAccount = { client_email: k.client_email, client_id: k.client_id };
    } catch (e) {
      serviceAccount = { error: e.message };
    }
    res.json({ serviceAccount, scopes: SCOPES, syncHourUtc: syncHour() });
  });
  app.get('/api/tenants', can('tenants'), (req, res) => {
    const tenants = db.prepare('SELECT * FROM tenants ORDER BY id').all();
    const seats = db.prepare('SELECT * FROM seat_overrides').all();
    const runs = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all()
      .map(r => ({ ...r, warnings: r.warnings ? JSON.parse(r.warnings) : [] }));
    res.json({ tenants: tenants.map(t => ({ ...t, seats: seats.filter(s => s.tenant_id === t.id) })), runs });
  });
  function tenantInput(body) {
    const label = String(body?.label || '').trim();
    const admin_email = String(body?.admin_email || '').trim().toLowerCase();
    const customer_id = String(body?.customer_id || 'my_customer').trim() || 'my_customer';
    const key_file = body?.key_file ? String(body.key_file).trim() : null;
    if (!label) throw new Error('Label is required');
    if (!EMAIL_RE.test(admin_email)) throw new Error('Admin email is not a valid email');
    if (!/^[A-Za-z0-9_]+$/.test(customer_id)) throw new Error('Customer ID looks wrong');
    if (key_file && !fs.existsSync(key_file)) throw new Error(`Key file ${key_file} does not exist on the server`);
    return { label, admin_email, customer_id, key_file, enabled: body?.enabled === false ? 0 : 1 };
  }
  app.post('/api/tenants', can('tenants'), (req, res) => {
    try {
      const t = tenantInput(req.body);
      const id = db.prepare('INSERT INTO tenants (label, admin_email, customer_id, key_file, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(t.label, t.admin_email, t.customer_id, t.key_file, t.enabled, new Date().toISOString()).lastInsertRowid;
      res.json({ id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/tenants/:id', can('tenants'), (req, res) => {
    try {
      const t = tenantInput(req.body);
      const id = Number(req.params.id);
      const before = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
      if (!before) return res.status(404).json({ error: 'No such tenant' });
      // A different admin or customer can mean a different tenant entirely.
      // Keeping the old snapshots would make every old account look deleted.
      const moved = before.admin_email !== t.admin_email || before.customer_id !== t.customer_id;
      dbm.tx(db, () => {
        db.prepare('UPDATE tenants SET label = ?, admin_email = ?, customer_id = ?, key_file = ?, enabled = ? WHERE id = ?')
          .run(t.label, t.admin_email, t.customer_id, t.key_file, t.enabled, id);
        if (moved) clearTenantData(db, id);
      });
      res.json({ ok: true, cleared: moved });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/tenants/:id', can('tenants'), (req, res) => {
    const id = Number(req.params.id);
    dbm.tx(db, () => {
      clearTenantData(db, id);
      db.prepare('DELETE FROM seat_overrides WHERE tenant_id = ?').run(id);
      db.prepare('DELETE FROM sync_runs WHERE tenant_id = ?').run(id);
      db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
    });
    res.json({ ok: true });
  });
  app.put('/api/tenants/:id/seats', can('tenants'), (req, res) => {
    const sku = String(req.body?.sku || '').trim();
    const seats = req.body?.seats === null || req.body?.seats === '' ? null : Number(req.body?.seats);
    if (!sku) return res.status(400).json({ error: 'License is required' });
    if (seats !== null && (!Number.isInteger(seats) || seats < 0)) return res.status(400).json({ error: 'Seats must be a whole number' });
    if (seats === null) db.prepare('DELETE FROM seat_overrides WHERE tenant_id = ? AND sku = ?').run(Number(req.params.id), sku);
    else db.prepare('INSERT INTO seat_overrides (tenant_id, sku, seats) VALUES (?, ?, ?) ON CONFLICT(tenant_id, sku) DO UPDATE SET seats = excluded.seats')
      .run(Number(req.params.id), sku, seats);
    res.json({ ok: true });
  });
  app.post('/api/tenants/:id/test', can('tenants'), async (req, res) => {
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'No such tenant' });
    const others = db.prepare('SELECT label, primary_domain FROM tenants WHERE id < ? AND enabled = 1 AND primary_domain IS NOT NULL').all(t.id);
    res.json({ checks: await sync.testTenant(t, { ...syncOpts, others }) });
  });
  // Manual syncs only read from Google, but each one makes a few hundred API
  // calls; a short cooldown keeps repeated clicks from eating the quota.
  const SYNC_COOLDOWN_MS = 10 * 60 * 1000;
  let lastManualSync = 0;
  app.post('/api/sync', can('sync'), (req, res) => {
    if (sync.isSyncing()) return res.json({ started: false, message: 'A sync is already running' });
    const wait = lastManualSync + SYNC_COOLDOWN_MS - Date.now();
    if (wait > 0) return res.json({ started: false, message: `Synced recently — try again in ${Math.ceil(wait / 60000)} min` });
    lastManualSync = Date.now();
    sync.syncAll(db, syncOpts).catch(e => console.error('sync failed', e));
    res.json({ started: true });
  });

  // ---- dashboard users (admin) ---------------------------------------------
  app.get('/api/users', can('users'), (req, res) => {
    res.json({ users: db.prepare('SELECT id, username, name, role, created_at FROM users ORDER BY username').all(), roles: Object.keys(auth.ROLES) });
  });
  app.post('/api/users', can('users'), (req, res) => {
    try { res.json({ id: auth.createUser(db, req.body || {}) }); } catch (e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'That username is taken' : e.message }); }
  });
  app.delete('/api/users/:id', can('users'), (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

// Removes everything synced for a tenant (not the tenant itself).
function clearTenantData(db, id) {
  for (const table of ['account_snapshots', 'tenant_snapshots', 'accounts', 'events']) {
    db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(id);
  }
  db.prepare('UPDATE tenants SET primary_domain = NULL WHERE id = ?').run(id);
}

function sendCsv(res, name, csv) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(csv);
}

function syncHour() { const h = Number(process.env.SYNC_HOUR_UTC ?? 3); return Number.isInteger(h) && h >= 0 && h < 24 ? h : 3; }

// Daily sync: once per UTC day, at or after SYNC_HOUR_UTC.
function startScheduler(db) {
  const tick = () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() < syncHour() || dbm.getSetting(db, 'last_auto_sync', null) === day || sync.isSyncing()) return;
    dbm.setSetting(db, 'last_auto_sync', day);
    sync.syncAll(db).then(r => console.log('daily sync', JSON.stringify(r))).catch(e => console.error('daily sync failed', e));
  };
  setInterval(tick, 10 * 60 * 1000).unref();
  setTimeout(tick, 5000).unref();
}

if (require.main === module) {
  const db = dbm.open(process.env.DB_FILE || path.join(__dirname, 'data', 'dashboard.db'));
  if (!db.prepare('SELECT COUNT(*) n FROM users').get().n) {
    console.warn('No dashboard users yet — create the first admin with: npm run add-user -- <username> admin');
  }
  const port = Number(process.env.PORT || 3100);
  createApp(db).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Workspace dashboard on :${port}`));
  if (process.env.DISABLE_SCHEDULER !== '1') startScheduler(db);
}

module.exports = { createApp };
