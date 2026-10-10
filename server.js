'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');

const dbm = require('./src/db');
const auth = require('./src/auth');
const reports = require('./src/reports');
const priceImport = require('./src/priceImport');
const ai = require('./src/ai');
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

  // Viewers never receive prices or income: every JSON answer is scrubbed of
  // money fields for a user without the 'money' capability, so no screen or
  // browser tool can show them.
  const { MONEY_KEYS, scrub } = require('./src/money');
  app.use('/api', (req, res, next) => {
    if (req.user && !req.user.can.includes('money')) {
      const json = res.json.bind(res);
      res.json = body => json(scrub(body));
    }
    next();
  });
  const moneyCols = (req, cols) => req.user.can.includes('money') ? cols : cols.filter(c => !MONEY_KEYS.has(c.key));
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
    // Latest finished sync per enabled tenant: when the newest one ended, and
    // how many tenants' latest sync failed.
    const latest = db.prepare(`SELECT r.finished_at, r.ok FROM sync_runs r
      JOIN (SELECT tenant_id, MAX(id) id FROM sync_runs WHERE finished_at IS NOT NULL GROUP BY tenant_id) l ON l.id = r.id
      JOIN tenants t ON t.id = r.tenant_id AND t.enabled = 1`).all();
    const last_sync = latest.length ? { at: latest.map(r => r.finished_at).sort().pop(), failed: latest.filter(r => !r.ok).length } : null;
    res.json({ user: req.user, syncing: sync.isSyncing(), last_sync });
  });

  // ---- reports -----------------------------------------------------------
  app.get('/api/overview', can('view'), (req, res) => res.json(reports.overview(db)));

  const ACCOUNT_COLS = [
    { key: 'email', label: 'Email' }, { key: 'full_name', label: 'Name' }, { key: 'domain', label: 'Domain' },
    { key: 'tenant', label: 'Tenant' }, { key: 'reseller', label: 'Reseller' }, { key: 'status', label: 'Status' }, { key: 'sku', label: 'License' },
    { key: 'extra_skus', label: 'Other licenses' },
    { key: 'gmail_gb', label: 'Gmail GB' }, { key: 'drive_gb', label: 'Drive GB' }, { key: 'photos_gb', label: 'Photos GB' }, { key: 'total_gb', label: 'Total GB' },
    { get: r => r.last_active ? r.last_active.slice(0, 10) : 'Never', label: 'Last activity' },
    { get: r => r.last_login ? r.last_login.slice(0, 10) : 'Never', label: 'Last password sign-in' },
    { get: r => r.created_on ? r.created_on.slice(0, 10) : '', label: 'Created' },
    { key: 'org_unit', label: 'Org unit' }, { key: 'monthly_cost', label: 'Monthly income' },
  ];
  app.get('/api/accounts', can('view'), (req, res) => res.json({ accounts: reports.currentAccounts(db, { all: req.query.all === '1' }) }));
  app.get('/api/accounts.csv', can('view'), (req, res) => {
    sendCsv(res, `accounts-${sync.today()}.csv`, reports.toCsv(moneyCols(req, ACCOUNT_COLS), reports.currentAccounts(db, { all: req.query.all === '1' })));
  });

  function range(req) {
    const t = new Date();
    const from = DATE_RE.test(req.query.from) ? req.query.from : `${t.toISOString().slice(0, 7)}-01`;
    const to = DATE_RE.test(req.query.to) ? req.query.to : t.toISOString().slice(0, 10);
    return [from, to];
  }
  const CHANGE_COLS = [
    { key: 'date', label: 'Date' }, { key: 'change', label: 'Change' }, { key: 'email', label: 'Email' }, { key: 'full_name', label: 'Name' },
    { key: 'domain', label: 'Domain' }, { key: 'reseller', label: 'Reseller' }, { key: 'tenant', label: 'Tenant' }, { key: 'sku', label: 'License' },
    { key: 'monthly_cost', label: 'Monthly income' }, { key: 'by', label: 'By' }, { key: 'source', label: 'Source' },
  ];
  app.get('/api/changes', can('view'), (req, res) => res.json(reports.changes(db, ...range(req))));
  app.get('/api/changes.csv', can('view'), (req, res) => {
    const [from, to] = range(req);
    sendCsv(res, `created-deleted-${from}-to-${to}.csv`, reports.toCsv(moneyCols(req, CHANGE_COLS), reports.changes(db, from, to).rows));
  });

  // Billing report period: ?period=day&key=2026-10-09 | month&key=2026-10 | year&key=2026
  function period(req) {
    const now = new Date().toISOString();
    const p = ['day', 'month', 'year'].includes(req.query.period) ? req.query.period : 'month';
    const re = { day: /^\d{4}-\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/, year: /^\d{4}$/ }[p];
    const dflt = { day: now.slice(0, 10), month: now.slice(0, 7), year: now.slice(0, 4) }[p];
    return [p, re.test(req.query.key) ? req.query.key : dflt];
  }
  app.get('/api/billing', can('view'), (req, res) => res.json(reports.billing(db, ...period(req))));
  app.get('/api/billing.csv', can('money'), (req, res) => {
    const [p, key] = period(req);
    const cols = [
      { key: 'domain', label: 'Domain' }, { key: 'reseller', label: 'Reseller' }, { key: 'tenant', label: 'Tenant' }, { key: 'email', label: 'Email' }, { key: 'full_name', label: 'Name' },
      { key: 'sku', label: 'License' }, { key: 'status', label: 'Status at period end' }, { key: 'price', label: 'Monthly price' },
      { key: 'days', label: 'Days billed' }, { key: 'cost', label: 'Income (prorated)' },
    ];
    sendCsv(res, `billing-report-${key}.csv`, reports.toCsv(cols, reports.billing(db, p, key).accounts));
  });

  // ---- prices (accountant) ----------------------------------------------
  app.get('/api/prices', can('money'), (req, res) => {
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
    // 0 means "no price set": saving 0 clears the price, like an empty box.
    let price = raw === null || raw === '' ? null : Number(raw);
    if (price !== null && (!Number.isFinite(price) || price < 0)) return res.status(400).json({ error: 'Price must be a number ≥ 0' });
    if (price === 0) price = null;
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
  // Price list import: the file is the request body. Without ?apply=1 it only
  // reports what would change; with it, the same plan is worked out again
  // from the file and saved (the browser's copy of the plan is not trusted).
  app.post('/api/prices/import', can('prices'), express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
    try {
      if (!req.body?.length) return res.status(400).json({ error: 'No file received' });
      const p = await priceImport.plan(db, req.body);
      if (req.query.apply === '1') {
        dbm.tx(db, () => priceImport.apply(db, p.changes, req.user.username));
        return res.json({ applied: p.changes.length, ...p });
      }
      res.json(p);
    } catch (e) {
      res.status(400).json({ error: /zip|End of data|Corrupted/i.test(e.message) ? 'That file could not be read as Excel (.xlsx) or CSV' : e.message });
    }
  });
  // ---- AI assistant ("Ask") -------------------------------------------------
  // Everyone signed in may ask; price answers are for the admin only (enforced
  // in src/ai.js on the data Claude receives). A per-user hourly cap keeps
  // the API bill predictable.
  const askPerHour = () => Number(process.env.ASK_PER_HOUR || 40);
  app.get('/api/ask/status', can('view'), (req, res) => {
    const used = db.prepare("SELECT COUNT(*) n FROM ai_log WHERE username = ? AND created_at > ?").get(req.user.username, new Date(Date.now() - 3600000).toISOString()).n;
    res.json({ enabled: ai.enabled(), prices: req.user.role === 'admin', remaining: Math.max(0, askPerHour() - used) });
  });
  // The answer streams back as server-sent events: progress while lookups
  // run, then the answer as it is written. A comment line every 10 s keeps
  // nginx and the browser from timing out a long answer.
  app.post('/api/ask', can('view'), async (req, res) => {
    if (!ai.enabled()) return res.status(503).json({ error: 'The AI assistant is not set up yet (no Anthropic API key on the server).' });
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Ask a question first' });
    if (question.length > 2000) return res.status(400).json({ error: 'Keep the question under 2000 characters' });
    const used = db.prepare("SELECT COUNT(*) n FROM ai_log WHERE username = ? AND created_at > ?").get(req.user.username, new Date(Date.now() - 3600000).toISOString()).n;
    if (used >= askPerHour()) return res.status(429).json({ error: `You have asked ${askPerHour()} questions in the last hour — try again a little later.` });

    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = ev => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 10_000);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    const started = Date.now();
    const log = db.prepare('INSERT INTO ai_log (username, question, input_tokens, output_tokens, ok, error, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    try {
      const history = Array.isArray(req.body?.history) ? req.body.history : [];
      const r = await ai.ask(db, req.user, question, history, send, abort.signal);
      log.run(req.user.username, question, r.usage.input_tokens, r.usage.output_tokens, 1, null, Date.now() - started, new Date().toISOString());
      send({ type: 'done', answer: r.answer });
    } catch (e) {
      const why = abort.signal.aborted ? 'closed by the browser' : `${e?.status || ''} ${e?.message || e}`.trim().slice(0, 300);
      log.run(req.user.username, question, null, null, 0, why, Date.now() - started, new Date().toISOString());
      console.error('ask failed:', why);
      const msg = e?.status === 401 ? 'The Anthropic API key on the server is not valid.'
        : e?.status === 429 || e?.status === 529 ? 'The AI service is busy — try again in a minute.'
        : e?.name === 'APIConnectionTimeoutError' ? 'The AI took too long to answer — try a narrower question.'
        : 'The AI assistant could not answer just now — try again.';
      send({ type: 'error', error: msg });
    } finally {
      clearInterval(ping);
      res.end();
    }
  });

  // ---- reseller per domain -------------------------------------------------
  app.get('/api/resellers', can('view'), (req, res) => {
    res.json({ resellers: [...new Set(reports.loadResellers(db).values())].sort((a, b) => a.localeCompare(b)) });
  });
  app.put('/api/domains/:domain/reseller', can('prices'), (req, res) => {
    const domain = String(req.params.domain || '').toLowerCase().trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return res.status(400).json({ error: 'Invalid domain' });
    const reseller = String(req.body?.reseller ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
    db.prepare(`INSERT INTO domain_info (domain, reseller, updated_by, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET reseller = excluded.reseller, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(domain, reseller, req.user.username, new Date().toISOString());
    res.json({ ok: true, reseller });
  });

  // ---- notes on domains (Prices page) -------------------------------------
  const noteOut = n => ({ ...n, mentions: JSON.parse(n.mentions) });
  app.get('/api/people', can('money'), (req, res) => {
    res.json({ people: db.prepare('SELECT username, name, role FROM users ORDER BY username').all() });
  });
  app.get('/api/notes', can('money'), (req, res) => {
    const notes = db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT 2000').all().map(noteOut);
    const mine = notes.filter(n => !n.resolved_at && n.mentions.includes(req.user.username)).length;
    res.json({ notes, mine });
  });
  app.post('/api/notes', can('prices'), (req, res) => {
    const domain = String(req.body?.domain || '').toLowerCase().trim();
    const body = String(req.body?.body || '').trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return res.status(400).json({ error: 'Invalid domain' });
    if (!body) return res.status(400).json({ error: 'Write a note first' });
    if (body.length > 2000) return res.status(400).json({ error: 'Keep a note under 2000 characters' });
    const known = new Set(db.prepare('SELECT username FROM users').all().map(u => u.username));
    const mentions = [...new Set([...body.matchAll(/@([a-z0-9._-]+)/gi)].map(m => m[1].toLowerCase()).filter(u => known.has(u)))];
    const id = db.prepare('INSERT INTO notes (domain, body, mentions, author, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(domain, body, JSON.stringify(mentions), req.user.username, new Date().toISOString()).lastInsertRowid;
    res.json({ note: noteOut(db.prepare('SELECT * FROM notes WHERE id = ?').get(id)) });
  });
  app.post('/api/notes/:id/resolve', can('prices'), (req, res) => {
    const done = req.body?.resolved !== false;
    const r = db.prepare('UPDATE notes SET resolved_by = ?, resolved_at = ? WHERE id = ?')
      .run(done ? req.user.username : null, done ? new Date().toISOString() : null, Number(req.params.id));
    if (!r.changes) return res.status(404).json({ error: 'No such note' });
    res.json({ ok: true });
  });

  app.get('/api/prices/log', can('money'), (req, res) => {
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
    const runs = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all()
      .map(r => ({ ...r, warnings: r.warnings ? JSON.parse(r.warnings) : [] }));
    res.json({ tenants, runs });
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
