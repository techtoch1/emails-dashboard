'use strict';
// "Ask the dashboard": Claude answers questions about the dashboard's data by
// calling read-only lookup tools backed by the same reports the screens use.
//
// Prices and income are for the admin only. For anyone else every tool result
// is scrubbed of money fields before Claude sees it, so no wording of a
// question can get a price out — Claude never has one to give.
const Anthropic = require('@anthropic-ai/sdk');
const reports = require('./reports');
const { scrub } = require('./money');

const MODEL = 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 8;
const MAX_ROWS = 100; // keeps each lookup small: faster and cheaper answers

function enabled() { return !!process.env.ANTHROPIC_API_KEY; }

let client;
function getClient() { return client ||= new Anthropic({ timeout: 90_000, maxRetries: 1 }); }
function setClient(c) { client = c; } // tests use a stand-in

const nullable = t => ({ type: [t, 'null'] });
const tool = (name, description, properties) => ({
  name, description, strict: true,
  input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});

const TOOLS = [
  tool('get_overview',
    'Totals across all tenants (email accounts, active/suspended, licensed, domains, storage) and one entry per tenant with its accounts, licenses assigned and storage. Accounts without a paid Workspace license are not counted as emails.',
    {}),
  tool('list_domains',
    'Domains with their tenant, reseller (null = sold directly), email count, active/suspended, licenses held and storage. All arguments are optional filters; pass null to skip one.',
    {
      search: { ...nullable('string'), description: 'Part of the domain name' },
      tenant: { ...nullable('string'), description: 'Exact tenant name' },
      reseller: { ...nullable('string'), description: 'Exact reseller name, or "direct" for domains with no reseller' },
    }),
  tool('list_accounts',
    'Individual email accounts: email, name, domain, tenant, reseller, license, status, storage in GB, last activity date, creation date. Filters are optional (null to skip) — filter as narrowly as the question allows. Returns at most 100 rows plus the total that matched.',
    {
      domain: { ...nullable('string'), description: 'Exact domain' },
      tenant: { ...nullable('string'), description: 'Exact tenant name' },
      reseller: { ...nullable('string'), description: 'Exact reseller name, or "direct"' },
      license: { ...nullable('string'), description: 'License name, e.g. "Business Starter" (matched loosely)' },
      status: { ...nullable('string'), description: 'active, suspended or archived' },
      not_used_in_days: { ...nullable('integer'), description: 'Only accounts with no activity in at least this many days (or never used)' },
      search: { ...nullable('string'), description: 'Part of the email address or name' },
    }),
  tool('get_changes',
    'Email accounts created (added) and deleted (removed) between two dates, inclusive, with domain, tenant, reseller, license and who made the change.',
    {
      from: { type: 'string', description: 'Start date, YYYY-MM-DD' },
      to: { type: 'string', description: 'End date, YYYY-MM-DD' },
    }),
  tool('get_billing_report',
    'Billing report for one day, month or year: emails at period end, added and removed counts, per-domain breakdown and (for a year) per-month breakdown.',
    {
      period: { type: 'string', enum: ['day', 'month', 'year'] },
      key: { type: 'string', description: 'YYYY-MM-DD for a day, YYYY-MM for a month, YYYY for a year' },
    }),
];

const short = s => String(s || '').replace(/^Google Workspace /i, '');
const eqi = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const resellerOk = (want, r) => want == null || (String(want).toLowerCase() === 'direct' ? !r : eqi(r, want));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function runTool(db, name, input) {
  switch (name) {
    case 'get_overview': {
      const o = reports.overview(db);
      return {
        currency: o.currency, totals: o.totals,
        tenants: o.tenants.map(t => ({ name: t.label, primary_domain: t.primary_domain, accounts: t.accounts, not_counted_no_workspace_license: t.hidden, licenses: t.licenses.map(l => ({ license: short(l.sku), assigned: l.assigned })), storage_gb: t.storage_gb, domains: t.domains.length, monthly_cost: t.monthly_cost, last_sync: t.last_sync?.at || null })),
      };
    }
    case 'list_domains': {
      const o = reports.overview(db);
      const rows = o.domains.filter(d => d.accounts &&
        (input.search == null || d.domain.includes(String(input.search).toLowerCase())) &&
        (input.tenant == null || d.tenants.some(t => eqi(t, input.tenant))) &&
        resellerOk(input.reseller, d.reseller));
      return {
        currency: o.currency, count: rows.length,
        domains: rows.slice(0, MAX_ROWS).map(d => ({ domain: d.domain, tenants: d.tenants, reseller: d.reseller, emails: d.accounts, active: d.active, suspended: d.suspended, licenses: Object.fromEntries(Object.entries(d.licenses).map(([k, v]) => [short(k), v])), storage_gb: d.storage_gb, price: d.price, monthly_cost: d.monthly_cost, unpriced: d.unpriced })),
      };
    }
    case 'list_accounts': {
      const now = Date.now();
      const rows = reports.currentAccounts(db).filter(a =>
        (input.domain == null || eqi(a.domain, input.domain)) &&
        (input.tenant == null || eqi(a.tenant, input.tenant)) &&
        resellerOk(input.reseller, a.reseller) &&
        (input.license == null || short(a.sku).toLowerCase().includes(short(input.license).toLowerCase())) &&
        (input.status == null || eqi(a.status, input.status)) &&
        (input.not_used_in_days == null || !a.last_active || now - Date.parse(a.last_active) >= input.not_used_in_days * 86400000) &&
        (input.search == null || `${a.email} ${a.full_name || ''}`.toLowerCase().includes(String(input.search).toLowerCase())));
      return {
        matched: rows.length, shown: Math.min(rows.length, MAX_ROWS),
        accounts: rows.slice(0, MAX_ROWS).map(a => ({ email: a.email, name: a.full_name, domain: a.domain, tenant: a.tenant, reseller: a.reseller, license: short(a.sku), status: a.status, storage_gb: a.total_gb, last_active: a.last_active ? a.last_active.slice(0, 10) : 'never', created: a.created_on ? a.created_on.slice(0, 10) : null, monthly_cost: a.monthly_cost })),
      };
    }
    case 'get_changes': {
      if (!DATE.test(input.from) || !DATE.test(input.to)) return { error: 'Dates must be YYYY-MM-DD' };
      const c = reports.changes(db, input.from, input.to);
      return { from: c.from, to: c.to, count: c.rows.length, changes: c.rows.slice(0, MAX_ROWS).map(r => ({ date: r.date, change: r.change === 'created' ? 'added' : 'removed', email: r.email, domain: r.domain, tenant: r.tenant, reseller: r.reseller, license: short(r.sku), by: r.by, monthly_cost: r.monthly_cost })) };
    }
    case 'get_billing_report': {
      const re = { day: DATE, month: /^\d{4}-\d{2}$/, year: /^\d{4}$/ }[input.period];
      if (!re || !re.test(input.key)) return { error: 'key must be YYYY-MM-DD (day), YYYY-MM (month) or YYYY (year)' };
      const b = reports.billing(db, input.period, input.key);
      return {
        period: b.period, start: b.start, end: b.end, projected: b.projected, history_starts: b.covered_from, currency: b.currency,
        total: b.total, emails_at_end: b.emails_at_end, added: b.changes.filter(x => x.change === 'created').length, removed: b.changes.filter(x => x.change === 'deleted').length,
        months: b.period === 'year' ? b.months : undefined,
        domains: b.domains.slice(0, MAX_ROWS).map(d => ({ domain: d.domain, reseller: d.reseller, tenants: d.tenants, emails_at_end: d.at_end, added: d.created, removed: d.deleted, email_days: d.license_days, cost: d.cost, unpriced: d.unpriced })),
      };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

// Removes null/undefined fields so lookups send fewer tokens.
function compact(v) {
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => [k, compact(x)]));
  return v;
}

const STATUS = {
  get_overview: 'Looking at the totals…',
  list_domains: 'Looking up domains…',
  list_accounts: 'Looking up accounts…',
  get_changes: 'Checking added and removed emails…',
  get_billing_report: 'Reading the billing report…',
};

function systemPrompt(isAdmin) {
  return `You are the assistant inside ALIGNED's Workspace Licenses dashboard, which reads ALIGNED's Google Workspace tenants (read-only) and tracks the email accounts ALIGNED provides to its clients: emails per domain, which tenant hosts each domain, resellers, licenses, storage, last activity, and accounts added and removed.

Answer the user's question from the dashboard's data, using the lookup tools. Look things up rather than guessing, and use as many lookups as the question needs. Keep answers short and concrete: lead with the answer, then the supporting numbers. Use a small Markdown table when listing several rows; never more than about 25 rows — summarise beyond that and say how many there are in total. Dates are YYYY-MM-DD. "Emails" means accounts with a paid Workspace license; accounts without one are not counted.

Storage and last activity come from Google's usage report, which runs 2–4 days behind. History only reaches back to the first daily sync, so say so when a question asks about earlier dates.

${isAdmin
    ? 'The user is the admin and may see prices and income. "Price" is what a client pays ALIGNED per email per month; "monthly_cost"/"income"/"total" are income to ALIGNED, not what Google charges. A null price means no price has been set.'
    : 'This user is not allowed to see prices, income or costs, and the data you receive contains none. If they ask about prices, income, costs or billing amounts, say that only the admin can get answers about prices, and answer any non-price part of the question.'}

You can only read data. If asked to change something (prices, tenants, users, resellers), say it has to be done on the relevant page of the dashboard.`;
}

// question: string; history: [{role:'user'|'assistant', text}] from earlier in
// this chat. emit(event) receives progress as it happens:
//   {type:'round'}            a new model turn starts (discard partial text)
//   {type:'status', text}     a lookup is running
//   {type:'text', text}       a piece of the answer
// Resolves to {answer, usage, looked}.
async function ask(db, user, question, history = [], emit = () => {}, signal) {
  const isAdmin = user.role === 'admin';
  const today = new Date().toISOString().slice(0, 10);
  const messages = [];
  for (const h of history.slice(-10)) {
    if ((h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string' && h.text.trim()) {
      messages.push({ role: h.role, content: h.text.slice(0, 4000) });
    }
  }
  if (messages.length && messages[0].role !== 'user') messages.shift();
  messages.push({ role: 'user', content: `(Today is ${today}.)\n\n${question}` });

  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const looked = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    emit({ type: 'round' });
    const stream = getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // Data look-ups need little deliberation; low effort answers much faster.
      output_config: { effort: 'low' },
      cache_control: { type: 'ephemeral' }, // the instructions and tools repeat every turn
      system: systemPrompt(isAdmin),
      tools: TOOLS,
      messages,
    }, signal ? { signal } : undefined);
    stream.on('text', t => emit({ type: 'text', text: t }));
    const response = await stream.finalMessage();
    for (const k of Object.keys(usage)) usage[k] += response.usage?.[k] || 0;

    if (response.stop_reason === 'refusal') {
      return { answer: 'Sorry — I can’t help with that question.', usage, looked };
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !toolUses.length) {
      const answer = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { answer: answer || 'I couldn’t find an answer to that.', usage, looked };
    }
    if (round === MAX_TOOL_ROUNDS) break;

    messages.push({ role: 'assistant', content: response.content });
    const results = toolUses.map(t => {
      looked.push(t.name);
      emit({ type: 'status', text: STATUS[t.name] || 'Looking it up…' });
      let out;
      try {
        out = runTool(db, t.name, t.input || {});
        if (!isAdmin) out = scrub(out); // the price rule, enforced on the data itself
      } catch (e) {
        return { type: 'tool_result', tool_use_id: t.id, is_error: true, content: e.message };
      }
      return { type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(compact(out)) };
    });
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'That question needed too many lookups — try asking something narrower.', usage, looked };
}

module.exports = { ask, enabled, setClient, runTool, systemPrompt, TOOLS, MODEL };
