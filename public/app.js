'use strict';
/* Workspace Licenses — single-page front end. No framework; every value that
   came from Google goes through h() before it touches innerHTML. */

const state = { me: null, view: 'overview', overview: null, accounts: null, filters: {}, sort: { col: 'email', dir: 1 } };
const $ = s => document.querySelector(s);
const view = () => $('#view');

function h(v) {
  return v == null ? '' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nf = new Intl.NumberFormat(undefined);
const n = v => v == null ? '—' : nf.format(v);
const gb = v => v == null ? '—' : `${nf.format(Math.round(v * 100) / 100)} GB`;
function money(v, cur) {
  if (v == null) return '<span class="notset">no price</span>';
  return h(new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', minimumFractionDigits: 2 }).format(v));
}
const day = s => s ? s.slice(0, 10) : '—';
function ago(s) {
  if (!s) return 'Never';
  const d = Math.floor((Date.now() - new Date(s).getTime()) / 86400000);
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : `${d} days ago`;
}
function when(s) { return s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
function sectionHead(title, actions = '') {
  return `<div class="section-head"><h2>${h(title)}</h2><span class="rule" aria-hidden="true"></span>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
}
const can = cap => state.me?.can.includes(cap);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Signed out'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---- session ---------------------------------------------------------------
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    e.target.reset();
    $('#login-error').textContent = '';
    boot();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });
$('#sync-btn').addEventListener('click', async () => {
  const r = await api('/api/sync', { method: 'POST' });
  $('#sync-state').textContent = r.started ? 'Syncing with Google…' : r.message;
  if (r.started || /already running/.test(r.message || '')) pollSync();
});
function pollSync() {
  const t = setInterval(async () => {
    const me = await api('/api/me').catch(() => null);
    if (me && !me.syncing) {
      clearInterval(t);
      $('#sync-state').textContent = 'Sync finished';
      state.overview = state.accounts = null;
      render();
    }
  }, 4000);
}

async function boot() {
  try {
    const me = await api('/api/me');
    state.me = me.user;
  } catch { return showLogin(); }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who').textContent = `${state.me.name || state.me.username} · ${state.me.role}`;
  $('#sync-btn').classList.toggle('hidden', !can('sync'));
  document.querySelectorAll('#tabs button[data-cap]').forEach(b => b.classList.toggle('hidden', !can(b.dataset.cap)));
  const fromHash = location.hash.slice(1);
  if (fromHash && document.querySelector(`#tabs button[data-view="${fromHash}"]:not(.hidden)`)) state.view = fromHash;
  render();
}

document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
function go(v, filters) {
  state.view = v;
  if (filters) state.filters = { ...filters };
  history.replaceState(null, '', `#${v}`);
  render();
}

async function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  view().innerHTML = '<p class="muted" style="margin-top:24px">Loading…</p>';
  try {
    await VIEWS[state.view]();
  } catch (e) {
    if (e.message !== 'Signed out') view().innerHTML = `<div class="banner">${h(e.message)}</div>`;
  }
}

async function getOverview() { return state.overview ||= await api('/api/overview'); }
async function getAccounts() { return state.accounts ||= (await api(`/api/accounts${state.showAll ? '?all=1' : ''}`)).accounts; }

// ---- Overview --------------------------------------------------------------
async function viewOverview() {
  const o = await getOverview();
  const t = o.totals;
  if (!t.tenants) {
    view().innerHTML = sectionHead('Overview') + `<div class="empty">No tenants connected yet.${can('tenants') ? ' Add them under <button class="linkish" data-go="tenants">Tenants</button>.' : ''}</div>`;
    bindGo();
    return;
  }
  const snapDates = o.tenants.map(x => x.snapshot_date).filter(Boolean).sort();
  view().innerHTML = `
    <div class="kpis">
      ${kpi('Email accounts', n(t.accounts), `${n(t.active)} active · ${n(t.suspended)} suspended${t.archived ? ` · ${n(t.archived)} archived` : ''}`)}
      ${kpi('Licensed', n(t.licensed), t.hidden ? `${n(t.hidden)} accounts with no Workspace license not counted` : 'every account has a license')}
      ${kpi('Domains', n(t.domains), `across ${n(t.tenants)} tenant${t.tenants === 1 ? '' : 's'}`)}
      ${kpi('Storage used', gb(t.storage_gb), 'Gmail + Drive + Photos')}
      ${kpi('Monthly cost', money(t.monthly_cost, o.currency), t.unpriced_accounts ? `${n(t.unpriced_accounts)} accounts have no price` : 'every account priced', !!t.unpriced_accounts)}
    </div>
    ${snapDates.length ? `<p class="small muted">Accounts as of ${h(snapDates[0])}${snapDates[0] !== snapDates.at(-1) ? `–${h(snapDates.at(-1))}` : ''}. Storage comes from Google's usage report, which runs 2–4 days behind.</p>` : ''}
    ${sectionHead('Tenants')}
    <div class="tenant-grid">${o.tenants.map(tenantCard).join('')}</div>
    ${sectionHead('Domains', `<input type="search" id="dom-q" placeholder="Find a domain" aria-label="Find a domain">`)}
    <div class="table-wrap"><table id="dom-table">
      <thead><tr><th>Domain</th><th>Hosted on</th><th class="num">Emails</th><th class="num">Active</th><th class="num">Suspended</th><th>Licenses</th><th class="num">Storage</th><th class="num">Price / email</th><th class="num">Monthly cost</th></tr></thead>
      <tbody></tbody>
    </table></div>`;
  const body = $('#dom-table tbody');
  const draw = () => {
    const q = ($('#dom-q').value || '').toLowerCase();
    const rows = o.domains.filter(d => d.accounts && (!q || d.domain.includes(q)));
    body.innerHTML = rows.map(d => `<tr>
      <td><button class="linkish" data-domain="${h(d.domain)}">${h(d.domain)}</button></td>
      <td>${d.tenants.map(h).join('<br>')}</td>
      <td class="num">${n(d.accounts)}</td><td class="num">${n(d.active)}</td><td class="num">${d.suspended ? n(d.suspended) : ''}</td>
      <td>${Object.entries(d.licenses).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${h(k)} × ${n(v)}</span>`).join('')}</td>
      <td class="num">${gb(d.storage_gb)}</td>
      <td class="num">${d.price == null ? '<span class="notset">not set</span>' : money(d.price, o.currency)}</td>
      <td class="num">${d.unpriced && !d.monthly_cost ? '<span class="notset">no price</span>' : money(d.monthly_cost, o.currency)}${d.unpriced && d.monthly_cost ? `<div class="small notset">${n(d.unpriced)} unpriced</div>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="muted">No domain matches.</td></tr>';
    body.querySelectorAll('[data-domain]').forEach(b => b.addEventListener('click', () => go('accounts', { domain: b.dataset.domain })));
  };
  $('#dom-q').addEventListener('input', draw);
  draw();
}
function kpi(label, value, sub, warn) {
  return `<div class="kpi"><div class="label">${h(label)}</div><div class="value">${value}</div><div class="sub${warn ? ' warn' : ''}">${h(sub)}</div></div>`;
}
function tenantCard(t) {
  const lic = t.licenses.map(l => {
    const pct = l.purchased ? Math.min(100, l.assigned / l.purchased * 100) : null;
    return `<div class="lic">
      <div class="name"><span>${h(l.sku)}</span><span class="num">${n(l.assigned)}${l.purchased != null ? ` of ${n(l.purchased)}` : ''}</span></div>
      ${pct != null ? `<div class="bar${pct >= 100 ? ' full' : ''}" role="img" aria-label="${l.assigned} of ${l.purchased} seats used"><span style="width:${pct}%"></span></div>
        <div class="small ${l.remaining < 0 ? 'bad' : 'muted'}">${l.remaining < 0 ? `${n(-l.remaining)} over the purchased seats` : `${n(l.remaining)} remaining`}</div>`
      : '<div class="small muted">Seats purchased not known — Flexible plan, or enter it under Tenants</div>'}
    </div>`;
  }).join('');
  const gs = Object.entries(t.google_seats || {}).filter(([, v]) => v.total != null);
  const s = t.last_sync;
  return `<article class="tcard">
    <h3>${h(t.label)}</h3>
    <div class="meta">${h(t.primary_domain || '')} · ${n(t.domains.length)} domain${t.domains.length === 1 ? '' : 's'}</div>
    <div class="row"><span>Email accounts</span><span class="num">${n(t.accounts)}</span></div>
    ${t.hidden ? `<div class="row muted"><span>Not counted (no Workspace license)</span><span class="num">${n(t.hidden)}</span></div>` : ''}
    <div class="row"><span>Storage (accounts)</span><span class="num">${gb(t.storage_gb)}</span></div>
    ${t.pooled_total_gb ? `<div class="row"><span>Pooled storage</span><span class="num">${gb(t.pooled_used_gb)} of ${gb(t.pooled_total_gb)}</span></div>` : ''}
    <div class="row"><span>Monthly cost</span><span class="num">${money(t.monthly_cost, state.overview.currency)}</span></div>
    ${lic}
    ${gs.length ? `<div class="small muted">Google reports: ${gs.map(([k, v]) => `${h(k.replace(/_/g, ' '))} ${n(v.used)} of ${n(v.total)}`).join(' · ')}</div>` : ''}
    <div class="sync">${s ? `${s.ok ? '<span class="ok">Synced</span>' : '<span class="bad">Sync failed</span>'} ${h(when(s.at))}${s.error ? `<div class="bad">${h(s.error)}</div>` : ''}${s.warnings?.length ? `<div class="small" style="color:var(--warn-fg)">${s.warnings.length} warning${s.warnings.length === 1 ? '' : 's'} — see Tenants</div>` : ''}` : '<span class="muted">Not synced yet</span>'}</div>
  </article>`;
}
function bindGo() { view().querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go))); }

// ---- Accounts --------------------------------------------------------------
const ACCOUNT_COLS = [
  ['email', 'Email'], ['domain', 'Domain'], ['tenant', 'Tenant'], ['sku', 'License'], ['status', 'Status'],
  ['gmail_gb', 'Gmail', 'num'], ['drive_gb', 'Drive', 'num'], ['total_gb', 'Total storage', 'num'],
  ['last_login', 'Last login'], ['created_on', 'Created'], ['monthly_cost', 'Monthly cost', 'num'],
];
async function viewAccounts() {
  const [rows, o] = await Promise.all([getAccounts(), getOverview()]);
  const uniq = k => [...new Set(rows.map(r => r[k]).filter(Boolean))].sort();
  const f = state.filters;
  const opt = (vals, cur) => '<option value="">All</option>' + vals.map(v => `<option${v === cur ? ' selected' : ''}>${h(v)}</option>`).join('');
  view().innerHTML = `
    ${sectionHead('Accounts', '<button class="btn secondary" id="acc-export" type="button">Export to Excel (CSV)</button>')}
    <div class="filters">
      <label>Tenant <select id="f-tenant">${opt(uniq('tenant'), f.tenant)}</select></label>
      <label>Domain <select id="f-domain">${opt(uniq('domain'), f.domain)}</select></label>
      <label>License <select id="f-sku">${opt(uniq('sku'), f.sku)}</select></label>
      <label>Status <select id="f-status">${opt(['active', 'suspended', 'archived'], f.status)}</select></label>
      <label>Last login <select id="f-login">
        <option value="">Any</option><option value="30">Not in 30 days</option><option value="90">Not in 90 days</option><option value="never">Never signed in</option>
      </select></label>
      <label>Search <input id="f-q" type="search" placeholder="Name or email" value="${h(f.q || '')}"></label>
      <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="f-all" ${state.showAll ? 'checked' : ''}> Include accounts with no Workspace license</label>
    </div>
    <p class="count" id="acc-count"></p>
    <div class="table-wrap"><table>
      <thead><tr>${ACCOUNT_COLS.map(([k, l, c]) => `<th class="sortable ${c || ''}" data-col="${k}" aria-sort="none">${h(l)}</th>`).join('')}</tr></thead>
      <tbody id="acc-body"></tbody><tfoot id="acc-foot"></tfoot>
    </table></div>`;
  if (f.login) $('#f-login').value = f.login;

  const filtered = () => {
    const now = Date.now();
    const q = (f.q || '').toLowerCase();
    return rows.filter(r =>
      (!f.tenant || r.tenant === f.tenant) && (!f.domain || r.domain === f.domain) && (!f.sku || r.sku === f.sku) &&
      (!f.status || r.status === f.status) &&
      (!f.login || (f.login === 'never' ? !r.last_login : (!r.last_login || now - new Date(r.last_login) > f.login * 86400000))) &&
      (!q || `${r.email} ${r.full_name || ''}`.toLowerCase().includes(q)));
  };
  const draw = () => {
    const { col, dir } = state.sort;
    const list = filtered().sort((a, b) => {
      const x = a[col], y = b[col];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
    document.querySelectorAll('th.sortable').forEach(th => th.setAttribute('aria-sort', th.dataset.col === col ? (dir > 0 ? 'ascending' : 'descending') : 'none'));
    document.querySelectorAll('th.sortable').forEach(th => { th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (th.dataset.col === col ? (dir > 0 ? ' ▲' : ' ▼') : ''); });
    $('#acc-count').textContent = `${n(list.length)} of ${n(rows.length)} accounts`;
    const shown = list.slice(0, 2000);
    $('#acc-body').innerHTML = shown.map(r => `<tr>
      <td>${h(r.email)}<div class="small muted">${h(r.full_name || '')}</div></td>
      <td>${h(r.domain)}</td><td>${h(r.tenant)}</td>
      <td>${h(r.sku)}${r.extra_skus ? `<div class="small muted">+ ${h(r.extra_skus)}</div>` : ''}</td>
      <td>${r.status === 'active' ? 'Active' : `<span class="chip ${h(r.status)}">${h(r.status)}</span>`}</td>
      <td class="num">${gb(r.gmail_gb)}</td><td class="num">${gb(r.drive_gb)}</td><td class="num">${gb(r.total_gb)}</td>
      <td title="${h(r.last_login || '')}">${r.last_login ? `${h(day(r.last_login))}<div class="small muted">${h(ago(r.last_login))}</div>` : '<span class="muted">Never</span>'}</td>
      <td>${h(day(r.created_on))}</td>
      <td class="num">${r.monthly_cost === 0 ? money(0, o.currency) : money(r.monthly_cost, o.currency)}</td>
    </tr>`).join('') || `<tr><td colspan="${ACCOUNT_COLS.length}" class="muted">No account matches these filters.</td></tr>`;
    const sumOf = k => list.reduce((s, r) => s + (r[k] || 0), 0);
    $('#acc-foot').innerHTML = list.length ? `<tr><td colspan="5">Total${list.length > shown.length ? ` (table shows the first ${n(shown.length)})` : ''}</td>
      <td class="num">${gb(sumOf('gmail_gb'))}</td><td class="num">${gb(sumOf('drive_gb'))}</td><td class="num">${gb(sumOf('total_gb'))}</td>
      <td colspan="2"></td><td class="num">${money(Math.round(sumOf('monthly_cost') * 100) / 100, o.currency)}</td></tr>` : '';
  };
  const bind = (id, key) => $(id).addEventListener(id === '#f-q' ? 'input' : 'change', e => { f[key] = e.target.value || undefined; draw(); });
  $('#f-all').addEventListener('change', e => { state.showAll = e.target.checked; state.accounts = null; render(); });
  bind('#f-tenant', 'tenant'); bind('#f-domain', 'domain'); bind('#f-sku', 'sku'); bind('#f-status', 'status'); bind('#f-login', 'login'); bind('#f-q', 'q');
  document.querySelectorAll('th.sortable').forEach(th => th.addEventListener('click', () => {
    state.sort = { col: th.dataset.col, dir: state.sort.col === th.dataset.col ? -state.sort.dir : 1 };
    draw();
  }));
  $('#acc-export').addEventListener('click', () => downloadCsv(`accounts-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Email', 'Name', 'Domain', 'Tenant', 'License', 'Other licenses', 'Status', 'Gmail GB', 'Drive GB', 'Photos GB', 'Total GB', 'Last login', 'Created', 'Org unit', `Monthly cost (${o.currency})`],
    filtered().map(r => [r.email, r.full_name, r.domain, r.tenant, r.sku, r.extra_skus, r.status, r.gmail_gb, r.drive_gb, r.photos_gb, r.total_gb, r.last_login ? day(r.last_login) : 'Never', day(r.created_on), r.org_unit, r.monthly_cost])));
  draw();
}

function downloadCsv(name, header, rows) {
  const esc = v => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- Created & deleted -------------------------------------------------------
function monthRange(offset) {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + offset);
  const from = d.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return [from, end];
}
async function viewChanges() {
  const [defFrom, defTo] = monthRange(0);
  const from = state.filters.from || defFrom, to = state.filters.to || defTo;
  const [r, o] = await Promise.all([api(`/api/changes?from=${from}&to=${to}`), getOverview()]);
  const created = r.rows.filter(x => x.change === 'created'), deleted = r.rows.filter(x => x.change === 'deleted');
  const byDomain = {};
  for (const x of r.rows) { (byDomain[x.domain] ||= { created: 0, deleted: 0, tenant: x.tenant })[x.change]++; }
  view().innerHTML = `
    ${sectionHead('Created & deleted', `<a class="btn secondary" href="/api/changes.csv?from=${from}&to=${to}">Export to Excel (CSV)</a>`)}
    <div class="filters">
      <label>From <input type="date" id="c-from" value="${from}"></label>
      <label>To <input type="date" id="c-to" value="${to}"></label>
      <button class="btn secondary" data-range="0" type="button">This month</button>
      <button class="btn secondary" data-range="-1" type="button">Last month</button>
    </div>
    <div class="kpis">
      ${kpi('Created', n(created.length), `${from} to ${to}`)}
      ${kpi('Deleted', n(deleted.length), `${from} to ${to}`)}
      ${kpi('Net change', (created.length - deleted.length > 0 ? '+' : '') + n(created.length - deleted.length), 'accounts')}
    </div>
    ${Object.keys(byDomain).length ? `${sectionHead('By domain')}
    <div class="table-wrap"><table><thead><tr><th>Domain</th><th>Tenant</th><th class="num">Created</th><th class="num">Deleted</th><th class="num">Net</th></tr></thead><tbody>
      ${Object.entries(byDomain).sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => `<tr><td>${h(d)}</td><td>${h(v.tenant)}</td><td class="num">${n(v.created)}</td><td class="num">${n(v.deleted)}</td><td class="num">${v.created - v.deleted > 0 ? '+' : ''}${n(v.created - v.deleted)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${sectionHead('Accounts')}
    ${r.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Change</th><th>Email</th><th>Domain</th><th>Tenant</th><th>License</th><th class="num">Monthly cost</th><th>By</th><th>Source</th></tr></thead><tbody>
      ${r.rows.map(x => `<tr><td>${h(x.date)}</td><td><span class="chip ${x.change}">${x.change}</span></td>
        <td>${h(x.email)}<div class="small muted">${h(x.full_name || '')}</div></td><td>${h(x.domain)}</td><td>${h(x.tenant)}</td>
        <td>${h(x.sku || '—')}</td><td class="num">${x.sku ? money(x.monthly_cost, o.currency) : '—'}</td><td>${h(x.by || '—')}</td><td class="small muted">${h(x.source)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No account was created or deleted in this period.</div>'}
    <p class="small muted">Created dates are Google's own account creation time. Deleted dates come from the admin audit log when Google reported the deletion; otherwise they are the first daily sync that no longer found the account.</p>`;
  const set = (f, t) => { state.filters.from = f; state.filters.to = t; render(); };
  $('#c-from').addEventListener('change', e => set(e.target.value, $('#c-to').value));
  $('#c-to').addEventListener('change', e => set($('#c-from').value, e.target.value));
  view().querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => set(...monthRange(Number(b.dataset.range)))));
}

// ---- Monthly billing -----------------------------------------------------------
async function viewBilling() {
  const month = state.filters.month || new Date().toISOString().slice(0, 7);
  const m = await api(`/api/monthly?month=${month}`);
  const cur = m.currency;
  view().innerHTML = `
    ${sectionHead('Monthly billing', `<a class="btn secondary" href="/api/monthly.csv?month=${month}">Export per-email detail (CSV)</a>`)}
    <div class="filters"><label>Month <input type="month" id="b-month" value="${month}"></label></div>
    ${m.projected ? `<div class="note">This month is not over yet: days after the latest sync are projected from the accounts as they are now.</div>` : ''}
    ${m.covered_from && m.covered_from > m.start ? `<div class="banner">Sync history starts on ${h(m.covered_from)}, so days before that are not counted for this month.</div>` : ''}
    ${!m.covered_from ? '<div class="empty">No sync covers this month.</div>' : ''}
    ${m.unpriced_accounts ? `<div class="banner">${n(m.unpriced_accounts)} licensed account${m.unpriced_accounts === 1 ? ' has' : 's have'} no price for its domain, so the total below leaves them out. Set them under <button class="linkish" data-go="prices">Prices</button>.</div>` : ''}
    <div class="kpis">
      ${kpi(`Total for ${month}`, money(m.total, cur), 'prorated by day, like Google’s Flexible plan')}
      ${kpi('Accounts billed', n(m.accounts.filter(a => a.cost).length), `of ${n(m.accounts.length)} seen this month`)}
      ${kpi('Created / deleted', `${n(m.changes.filter(c => c.change === 'created').length)} / ${n(m.changes.filter(c => c.change === 'deleted').length)}`, 'during the month')}
    </div>
    ${sectionHead('By domain')}
    <div class="table-wrap"><table><thead><tr><th>Domain</th><th>Tenant</th><th class="num">Accounts</th><th class="num">Licensed</th><th class="num">Created</th><th class="num">Deleted</th><th class="num">License-days</th><th class="num">Cost</th></tr></thead><tbody>
      ${m.domains.map(d => `<tr><td>${h(d.domain)}</td><td>${d.tenants.map(h).join(', ')}</td><td class="num">${n(d.accounts)}</td><td class="num">${n(d.licensed)}</td>
        <td class="num">${d.created ? n(d.created) : ''}</td><td class="num">${d.deleted ? n(d.deleted) : ''}</td><td class="num">${n(d.license_days)}</td>
        <td class="num">${d.unpriced && !d.cost ? '<span class="notset">no price</span>' : money(d.cost, cur)}</td></tr>`).join('')}
    </tbody><tfoot><tr><td colspan="7">Total</td><td class="num">${money(m.total, cur)}</td></tr></tfoot></table></div>
    <p class="small muted">Cost per email = monthly price × days it held a license in the month ÷ ${m.days}. Suspended accounts still hold their license, so they are billed; unlicensed accounts are not.</p>`;
  $('#b-month').addEventListener('change', e => { state.filters.month = e.target.value; render(); });
  bindGo();
}

// ---- Prices ------------------------------------------------------------------
async function viewPrices() {
  const [p, log] = await Promise.all([api('/api/prices'), api('/api/prices/log')]);
  const editable = can('prices');
  const domains = p.domains.filter(d => d.accounts);
  const input = (d, sku, val, label) => editable
    ? `<input class="price-input" type="number" min="0" step="0.01" inputmode="decimal" data-domain="${h(d)}" data-sku="${h(sku)}" value="${val ?? ''}" placeholder="not set" aria-label="${h(label)}"> <span class="saved" aria-live="polite"></span>`
    : (val == null ? '<span class="notset">not set</span>' : money(val, p.currency));
  view().innerHTML = `
    ${sectionHead('Prices', editable ? `<label class="small muted">Currency <input id="currency" value="${h(p.currency)}" maxlength="3" size="4" aria-label="Currency"></label>` : '')}
    <div class="note">Enter what each domain pays per email per month. That price applies to every licensed email on the domain, whatever its license. ${editable ? 'Changes save as soon as you leave the box, and every change is logged below.' : 'Only an accountant or admin can change prices.'}</div>
    <div class="filters"><label>Find <input type="search" id="p-q" placeholder="Domain"></label><label>Show <select id="p-show"><option value="">All domains</option><option value="unset">Without a price</option></select></label></div>
    <div class="table-wrap"><table id="p-table"><thead><tr><th>Domain</th><th>Tenant</th><th class="num">Licensed emails</th><th>Price per email / month</th><th class="num">Monthly cost</th></tr></thead><tbody>
      ${domains.map(d => {
        const licensed = Object.entries(d.licenses).filter(([s]) => s !== 'Unlicensed' && s !== 'Unknown').reduce((a, [, v]) => a + v, 0);
        return `<tr data-row="${h(d.domain)}" data-unset="${d.price == null ? 1 : 0}"><td><strong>${h(d.domain)}</strong></td><td>${d.tenants.map(h).join('<br>')}</td>
        <td class="num">${n(licensed)}</td>
        <td>${input(d.domain, '*', d.price, `Price per email for ${d.domain}`)}</td>
        <td class="num">${d.unpriced && !d.monthly_cost ? '<span class="notset">—</span>' : money(d.monthly_cost, p.currency)}</td></tr>`;
      }).join('')}
    </tbody></table></div>
    ${sectionHead('Change log')}
    ${log.log.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Domain</th><th class="num">Old</th><th class="num">New</th><th>By</th></tr></thead><tbody>
      ${log.log.map(l => `<tr><td>${h(when(l.changed_at))}</td><td>${h(l.domain)}</td><td class="num">${l.old_price == null ? '—' : money(l.old_price, p.currency)}</td><td class="num">${l.new_price == null ? 'removed' : money(l.new_price, p.currency)}</td><td>${h(l.changed_by)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No price has been changed yet.</div>'}`;

  const filter = () => {
    const q = $('#p-q').value.toLowerCase(), unset = $('#p-show').value === 'unset';
    view().querySelectorAll('#p-table tbody tr').forEach(tr => tr.classList.toggle('hidden', (q && !tr.dataset.row.includes(q)) || (unset && tr.dataset.unset !== '1')));
  };
  $('#p-q').addEventListener('input', filter);
  $('#p-show').addEventListener('change', filter);
  view().querySelectorAll('.price-input').forEach(inp => {
    inp.dataset.orig = inp.value;
    inp.addEventListener('change', async () => {
      const mark = inp.nextElementSibling;
      try {
        await api('/api/prices', { method: 'PUT', body: { domain: inp.dataset.domain, sku: inp.dataset.sku, price: inp.value === '' ? null : inp.value } });
        mark.textContent = 'Saved';
        mark.className = 'saved';
        inp.dataset.orig = inp.value;
        state.overview = state.accounts = null;
        setTimeout(() => { mark.textContent = ''; }, 2500);
      } catch (e) { mark.textContent = e.message; mark.className = 'error'; inp.value = inp.dataset.orig; }
    });
  });
  $('#currency')?.addEventListener('change', async e => {
    try { await api('/api/settings/currency', { method: 'PUT', body: { currency: e.target.value } }); state.overview = null; render(); }
    catch (err) { alert(err.message); }
  });
}

// ---- Tenants (admin) --------------------------------------------------------------
async function viewTenants() {
  const [setup, data, o] = await Promise.all([api('/api/setup'), api('/api/tenants'), getOverview()]);
  const sa = setup.serviceAccount;
  const licByTenant = Object.fromEntries(o.tenants.map(t => [t.id, t.licenses.map(l => l.sku)]));
  view().innerHTML = `
    ${sectionHead('Tenants', '<button class="btn" id="t-add" type="button">Add tenant</button>')}
    <div class="note"><strong>Connecting a tenant (once per tenant, by a super admin of that tenant):</strong>
      <ol>
        <li>In <a href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noopener">Admin console → Security → API controls → Domain-wide delegation</a>, choose <em>Add new</em>.</li>
        <li>Client ID: ${sa?.client_id ? `<code>${h(sa.client_id)}</code>` : `<span class="bad">${h(sa?.error || 'no service-account key on the server yet')}</span>`}</li>
        <li>OAuth scopes (paste as one line):<pre class="copy">${h(setup.scopes.join(','))}</pre></li>
        <li>Add the tenant here with an admin address the dashboard reads as, then <em>Test connection</em>.</li>
      </ol>
      <span class="small muted">Every scope is read-only except licensing, for which Google offers no read-only scope; this app only ever reads with it. Daily sync runs at ${String(setup.syncHourUtc).padStart(2, '0')}:00 UTC.</span>
    </div>
    <div id="t-form"></div>
    ${data.tenants.length ? data.tenants.map(t => `<div class="panel">
      <div class="section-head" style="margin-top:0"><h3>${h(t.label)}${t.enabled ? '' : ' <span class="chip">disabled</span>'}</h3><span class="rule" aria-hidden="true"></span>
        <div class="actions"><button class="btn secondary small" data-test="${t.id}" type="button">Test connection</button><button class="btn secondary small" data-edit="${t.id}" type="button">Edit</button><button class="btn secondary small" data-remove="${t.id}" type="button">Remove</button></div></div>
      <div class="small">Reads as <strong>${h(t.admin_email)}</strong> · customer <code>${h(t.customer_id)}</code> · primary domain ${h(t.primary_domain || 'learned on first sync')}${t.key_file ? ` · key <code>${h(t.key_file)}</code>` : ''}</div>
      <div id="test-${t.id}"></div>
      <div style="margin-top:10px"><span class="small muted">Seats purchased (Annual plans) — leave blank on Flexible plans:</span>
        <div class="filters" style="margin:6px 0 0">${[...new Set([...(licByTenant[t.id] || []), ...t.seats.map(s => s.sku)])].map(sku => {
          const v = t.seats.find(s => s.sku === sku)?.seats;
          return `<label>${h(sku)} <input type="number" min="0" step="1" class="price-input" data-seats="${t.id}" data-sku="${h(sku)}" value="${v ?? ''}" placeholder="unknown"></label>`;
        }).join('') || '<span class="small muted">Licenses appear here after the first sync.</span>'}</div>
      </div>
    </div>`).join('') : '<div class="empty">No tenants yet.</div>'}
    ${sectionHead('Recent syncs')}
    ${data.runs.length ? `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Tenant</th><th>Result</th><th class="num">Accounts</th><th>Problems</th></tr></thead><tbody>
      ${data.runs.map(r => `<tr><td>${h(when(r.started_at))}</td><td>${h(data.tenants.find(t => t.id === r.tenant_id)?.label || r.tenant_id)}</td>
        <td>${r.ok ? '<span class="ok">OK</span>' : r.finished_at ? '<span class="bad">Failed</span>' : 'Running…'}</td><td class="num">${n(r.accounts)}</td>
        <td class="small">${r.error ? `<span class="bad">${h(r.error)}</span>` : ''}${r.warnings.map(w => `<div style="color:var(--warn-fg)">${h(w)}</div>`).join('')}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No sync has run yet.</div>'}`;

  const form = (t = {}) => {
    $('#t-form').innerHTML = `<form class="panel" id="tenant-form">
      <h3 style="margin-bottom:10px">${t.id ? `Edit ${h(t.label)}` : 'Add a tenant'}</h3>
      <div class="form-grid">
        <label>Name shown in the dashboard <input name="label" required value="${h(t.label || '')}"></label>
        <label>Admin email to read as <input name="admin_email" type="email" required value="${h(t.admin_email || '')}"></label>
        <label>Customer ID <input name="customer_id" value="${h(t.customer_id || 'my_customer')}"></label>
        <label>Key file on server (optional) <input name="key_file" value="${h(t.key_file || '')}" placeholder="uses GOOGLE_SA_KEY_FILE"></label>
        <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" name="enabled" ${t.enabled === 0 ? '' : 'checked'}> Enabled</label>
      </div>
      <p class="error" id="t-err"></p>
      <button class="btn" type="submit">Save</button> <button class="btn secondary" type="button" id="t-cancel">Cancel</button>
    </form>`;
    $('#t-cancel').addEventListener('click', () => { $('#t-form').innerHTML = ''; });
    $('#tenant-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = { label: f.get('label'), admin_email: f.get('admin_email'), customer_id: f.get('customer_id'), key_file: f.get('key_file') || null, enabled: f.get('enabled') === 'on' };
      try {
        if (t.id && (body.admin_email !== t.admin_email || body.customer_id !== t.customer_id) && t.primary_domain &&
            !confirm('Changing the admin email or customer ID clears what was synced for this tenant, so it can be re-read from the right tenant. Continue?')) return;
        await api(t.id ? `/api/tenants/${t.id}` : '/api/tenants', { method: t.id ? 'PUT' : 'POST', body });
        state.overview = state.accounts = null;
        render();
      } catch (err) { $('#t-err').textContent = err.message; }
    });
    $('#t-form').scrollIntoView({ behavior: 'smooth' });
  };
  $('#t-add').addEventListener('click', () => form());
  view().querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => form(data.tenants.find(t => t.id === Number(b.dataset.edit)))));
  view().querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', async () => {
    const t = data.tenants.find(x => x.id === Number(b.dataset.remove));
    if (!confirm(`Remove "${t.label}" and everything synced from it? Nothing in Google changes.`)) return;
    await api(`/api/tenants/${t.id}`, { method: 'DELETE' });
    state.overview = state.accounts = null;
    render();
  }));
  view().querySelectorAll('[data-test]').forEach(b => b.addEventListener('click', async () => {
    const out = $(`#test-${b.dataset.test}`);
    out.innerHTML = '<p class="small muted">Testing…</p>';
    try {
      const r = await api(`/api/tenants/${b.dataset.test}/test`, { method: 'POST' });
      out.innerHTML = `<ul class="checks small">${r.checks.map(c => `<li><span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</span> ${h(c.name)} — ${h(c.detail)}</li>`).join('')}</ul>`;
    } catch (e) { out.innerHTML = `<p class="error">${h(e.message)}</p>`; }
  }));
  view().querySelectorAll('[data-seats]').forEach(inp => inp.addEventListener('change', async () => {
    try {
      await api(`/api/tenants/${inp.dataset.seats}/seats`, { method: 'PUT', body: { sku: inp.dataset.sku, seats: inp.value === '' ? null : Number(inp.value) } });
      state.overview = null;
      inp.style.borderColor = 'var(--good)';
    } catch (e) { alert(e.message); }
  }));
}

// ---- Users (admin) -------------------------------------------------------------
async function viewUsers() {
  const r = await api('/api/users');
  view().innerHTML = `
    ${sectionHead('Dashboard users')}
    <div class="table-wrap"><table><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Added</th><th></th></tr></thead><tbody>
      ${r.users.map(u => `<tr><td>${h(u.username)}</td><td>${h(u.name || '')}</td><td>${h(u.role)}</td><td>${h(day(u.created_at))}</td>
        <td>${u.id === state.me.id ? '<span class="small muted">you</span>' : `<button class="btn secondary small" data-del="${u.id}" type="button">Remove</button>`}</td></tr>`).join('')}
    </tbody></table></div>
    <form class="panel" id="user-form" style="margin-top:16px">
      <h3 style="margin-bottom:10px">Add a user</h3>
      <div class="form-grid">
        <label>Username <input name="username" required autocomplete="off"></label>
        <label>Name <input name="name"></label>
        <label>Role <select name="role">${r.roles.map(x => `<option${x === 'accountant' ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
        <label>Password (min 10 characters) <input name="password" type="password" minlength="10" required autocomplete="new-password"></label>
      </div>
      <p class="small muted">Admin: everything. Accountant: sees everything, sets prices and can sync now. Viewer: read-only.</p>
      <p class="error" id="u-err"></p>
      <button class="btn" type="submit">Add user</button>
    </form>`;
  $('#user-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('/api/users', { method: 'POST', body: f }); render(); } catch (err) { $('#u-err').textContent = err.message; }
  });
  view().querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Remove this user?')) return;
    await api(`/api/users/${b.dataset.del}`, { method: 'DELETE' });
    render();
  }));
}

const VIEWS = { overview: viewOverview, accounts: viewAccounts, changes: viewChanges, billing: viewBilling, prices: viewPrices, tenants: viewTenants, users: viewUsers };
boot();
