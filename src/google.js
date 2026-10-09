'use strict';
// Read-only client for the Google Workspace APIs the dashboard needs.
//
// Authentication is a service account with domain-wide delegation: the
// service account signs a JWT naming the tenant admin to act as (`sub`) and
// the scopes it wants, and Google returns a one-hour access token. No admin
// password is ever stored. Every call below is an HTTP GET — this module has
// no code path that writes to Google.
const crypto = require('crypto');
const fs = require('fs');

// All read-only, except Licensing: Google publishes no read-only scope for the
// Enterprise License Manager API, so `apps.licensing` is the only way to read
// who holds which license. This client only ever issues GETs with it.
const SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.domain.readonly',
  'https://www.googleapis.com/auth/admin.reports.usage.readonly',
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
  'https://www.googleapis.com/auth/apps.licensing',
];

// Products whose licenses are listed. Google-Apps covers every Workspace
// edition (Business Starter/Standard/Plus, Enterprise, Essentials…);
// 101034 is Archived User; 101001/101005 are Cloud Identity Free/Premium.
// A tenant that does not own a product answers 400/403/404 — skipped quietly.
const LICENSE_PRODUCTS = ['Google-Apps', '101034', '101001', '101005', 'Google-Vault', '101033'];

const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
const REPORTS = 'https://admin.googleapis.com/admin/reports/v1';
const LICENSING = 'https://licensing.googleapis.com/apps/licensing/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

class GoogleError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function loadKey(keyFile) {
  if (!keyFile) throw new Error('No service-account key configured (set GOOGLE_SA_KEY_FILE or the tenant key file)');
  const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  if (!key.client_email || !key.private_key) throw new Error(`${keyFile} is not a service-account JSON key`);
  return key;
}

class GoogleClient {
  // opts: { key, subject, fetch } — fetch is injectable so tests run offline.
  constructor({ key, subject, fetch: fetchImpl }) {
    this.key = key;
    this.subject = subject;
    this.fetch = fetchImpl || globalThis.fetch;
    this.token = null;
    this.tokenExpires = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: this.key.client_email,
      sub: this.subject,
      scope: SCOPES.join(' '),
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }));
    const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), this.key.private_key));
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // unauthorized_client = the client ID / scopes are not authorized for
      // domain-wide delegation in that tenant's Admin console.
      const hint = body.error === 'unauthorized_client'
        ? ' — authorize the service account client ID with the listed scopes under Security → API controls → Domain-wide delegation in this tenant'
        : '';
      throw new GoogleError(`Token request failed: ${body.error || res.status} ${body.error_description || ''}${hint}`.trim(), res.status, body);
    }
    this.token = body.access_token;
    this.tokenExpires = Date.now() + (body.expires_in || 3600) * 1000;
    return this.token;
  }

  async get(url, params = {}) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(u.toString(), { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body.error?.message || res.statusText || `HTTP ${res.status}`;
        throw new GoogleError(msg, res.status, body);
      }
      return body;
    }
  }

  async getAll(url, params, listKey) {
    const out = [];
    let pageToken;
    do {
      const page = await this.get(url, { ...params, pageToken });
      out.push(...(page[listKey] || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  // ---- Directory -------------------------------------------------------
  listUsers(customer = 'my_customer') {
    return this.getAll(`${DIRECTORY}/users`, {
      customer, maxResults: 500, projection: 'basic', orderBy: 'email',
      fields: 'nextPageToken,users(id,primaryEmail,name/fullName,suspended,archived,creationTime,lastLoginTime,orgUnitPath,isAdmin)',
    }, 'users');
  }

  async listDomains(customer = 'my_customer') {
    const page = await this.get(`${DIRECTORY}/customer/${encodeURIComponent(customer)}/domains`);
    const out = [];
    for (const d of page.domains || []) {
      out.push({ domain: d.domainName.toLowerCase(), primary: !!d.isPrimary, verified: !!d.verified, alias_of: null });
      for (const a of d.domainAliases || []) {
        out.push({ domain: a.domainAliasName.toLowerCase(), primary: false, verified: !!a.verified, alias_of: d.domainName.toLowerCase() });
      }
    }
    return out;
  }

  // ---- Licensing -------------------------------------------------------
  // customerId must be the tenant's primary domain or its customer ID.
  async listLicenses(customerId, warn = () => {}) {
    const out = [];
    for (const productId of LICENSE_PRODUCTS) {
      try {
        const items = await this.getAll(`${LICENSING}/product/${encodeURIComponent(productId)}/users`,
          { customerId, maxResults: 1000 }, 'items');
        out.push(...items);
      } catch (e) {
        if (e instanceof GoogleError && [400, 403, 404].includes(e.status) && productId !== 'Google-Apps') continue;
        if (productId === 'Google-Apps') throw e;
        warn(`Licenses for product ${productId}: ${e.message}`);
      }
    }
    return out.map(i => ({ email: (i.userId || '').toLowerCase(), productId: i.productId, skuId: i.skuId, sku: i.skuName || i.skuId }));
  }

  // ---- Reports (usage lags 2–4 days, so walk back to the newest available day)
  async latestUsage(kind, params, warn = () => {}) {
    const base = kind === 'users' ? `${REPORTS}/usage/users/all/dates/` : `${REPORTS}/usage/dates/`;
    const listKey = 'usageReports';
    for (let back = 2; back <= 8; back++) {
      const date = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
      try {
        const reports = await this.getAll(base + date, { ...params, ...(kind === 'users' ? { maxResults: 1000 } : {}) }, listKey);
        const usable = reports.filter(r => (r.parameters || []).length);
        if (usable.length) return { date, reports: usable };
      } catch (e) {
        // "Data for dates later than X is not yet available" — try an earlier day.
        if (e instanceof GoogleError && e.status === 400 && /not yet available|later than/i.test(e.message)) continue;
        throw e;
      }
    }
    warn(`No ${kind} usage report available in the last 8 days`);
    return { date: null, reports: [] };
  }

  // Storage per account, plus when each mailbox was last actually used.
  // The Directory's lastLoginTime only moves when someone types a password,
  // so an Outlook or phone user who stays signed in looks idle for weeks;
  // these usage times record the access itself (IMAP, Outlook sync, mobile, web).
  async userStorage(warn = () => {}) {
    const storage = 'accounts:gmail_used_quota_in_mb,accounts:drive_used_quota_in_mb,accounts:gplus_photos_used_quota_in_mb,accounts:used_quota_in_mb';
    let result;
    try {
      result = await this.latestUsage('users', { parameters: `${storage},${ACTIVITY_PARAMS.join(',')}` }, warn);
    } catch (e) {
      if (!(e instanceof GoogleError && e.status === 400)) throw e;
      warn(`Last activity not available (${e.message}); showing Google's last sign-in only`);
      result = await this.latestUsage('users', { parameters: storage }, warn);
    }
    const { date, reports } = result;
    const byEmail = new Map();
    for (const r of reports) {
      const p = paramMap(r.parameters);
      byEmail.set((r.entity?.userEmail || '').toLowerCase(), {
        gmail_gb: mbToGb(p['accounts:gmail_used_quota_in_mb']),
        drive_gb: mbToGb(p['accounts:drive_used_quota_in_mb']),
        photos_gb: mbToGb(p['accounts:gplus_photos_used_quota_in_mb']),
        total_gb: mbToGb(p['accounts:used_quota_in_mb']),
        last_activity: latest(ACTIVITY_PARAMS.map(k => p[k])),
      });
    }
    return { date, byEmail };
  }

  // Customer-level usage: pooled storage, and licence counts Google reports
  // as accounts:<sku>_total_licenses / accounts:<sku>_used_licenses.
  async customerUsage(warn) {
    const { date, reports } = await this.latestUsage('customer', {}, warn);
    const p = reports.length ? paramMap(reports[0].parameters) : {};
    const seats = {};
    for (const [name, value] of Object.entries(p)) {
      const m = /^accounts:(.+)_(total|used)_licenses$/.exec(name);
      if (!m || value == null) continue;
      (seats[m[1]] ||= {})[m[2]] = Number(value);
    }
    return {
      date,
      seats,
      storage_used_mb: num(p['accounts:used_quota_in_mb']),
      storage_total_mb: num(p['accounts:total_quota_in_mb']),
    };
  }

  // ---- Admin audit log -------------------------------------------------
  async adminEvents(startTime) {
    const items = await this.getAll(`${REPORTS}/activity/users/all/applications/admin`,
      { startTime, maxResults: 1000 }, 'items');
    const out = [];
    for (const it of items) {
      for (const ev of it.events || []) {
        if (!RELEVANT_EVENT.test(ev.name)) continue;
        const p = paramMap(ev.parameters);
        out.push({
          uid: `${it.id?.uniqueQualifier || ''}:${it.id?.time}:${ev.name}:${p.USER_EMAIL || ''}`,
          time: it.id?.time,
          name: ev.name,
          email: (p.USER_EMAIL || '').toLowerCase() || null,
          actor: it.actor?.email || null,
          detail: JSON.stringify(p),
        });
      }
    }
    return out;
  }
}

const RELEVANT_EVENT = /^(CREATE_USER|DELETE_USER|UNDELETE_USER|SUSPEND_USER|UNSUSPEND_USER|ARCHIVE_USER|UNARCHIVE_USER|RENAME_USER)$|LICENSE/;

const ACTIVITY_PARAMS = [
  'accounts:last_login_time', 'accounts:last_sso_time',
  'gmail:last_access_time', 'gmail:last_imap_time', 'gmail:last_pop_time',
  'gmail:last_webmail_time', 'gmail:last_interaction_time',
];
// Newest real timestamp of several (Google reports "never" as 1970).
function latest(values) {
  let best = null;
  for (const v of values) if (typeof v === 'string' && v > '1971' && (!best || v > best)) best = v;
  return best;
}

function paramMap(params = []) {
  const m = {};
  for (const p of params) m[p.name] = p.intValue ?? p.value ?? p.boolValue ?? p.datetimeValue ?? p.multiValue ?? null;
  return m;
}
function num(v) { return v == null ? null : Number(v); }
function mbToGb(v) { return v == null ? null : Math.round(Number(v) / 1024 * 100) / 100; }

module.exports = { GoogleClient, GoogleError, SCOPES, LICENSE_PRODUCTS, loadKey };
