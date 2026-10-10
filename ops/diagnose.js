'use strict';
// Read-only health check, printed for the Diagnose workflow: syncs, the AI
// assistant's key and recent use. Prints no question text and no secrets.
const path = require('path');
const dbm = require('../src/db');

(async () => {
  const db = dbm.open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'dashboard.db'));
  const q = (sql, ...a) => db.prepare(sql).all(...a);

  console.log('--- tenants / latest sync ---');
  for (const r of q(`SELECT t.label, t.enabled, r.finished_at, r.ok, r.accounts, r.error FROM tenants t
      LEFT JOIN sync_runs r ON r.id = (SELECT MAX(id) FROM sync_runs WHERE tenant_id = t.id) ORDER BY t.id`)) {
    console.log(`${r.enabled ? ' ' : 'x'} ${r.label}: ${r.ok ? 'ok' : r.finished_at ? 'FAILED' : 'never'} ${r.finished_at || ''} ${r.accounts ?? ''} ${r.error || ''}`);
  }

  console.log('\n--- AI assistant ---');
  console.log('API key present:', !!process.env.ANTHROPIC_API_KEY);
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const m = await new Anthropic().models.retrieve('claude-opus-5-5');
      console.log('Key works: Anthropic answered for model', m.id);
    } catch (e) {
      console.log(`Key check FAILED: ${e.status || ''} ${e.message}`);
    }
  }
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const s = q("SELECT COUNT(*) n, SUM(ok) ok, SUM(input_tokens) i, SUM(output_tokens) o FROM ai_log WHERE created_at > ?", since)[0];
  console.log(`Questions in the last 7 days: ${s.n} (${s.ok || 0} answered, ${s.n - (s.ok || 0)} failed), tokens in/out: ${s.i || 0}/${s.o || 0}`);
  for (const r of q('SELECT username, ok, input_tokens, output_tokens, created_at FROM ai_log ORDER BY id DESC LIMIT 10')) {
    console.log(`  ${r.created_at}  ${r.username.padEnd(14)} ${r.ok ? 'answered' : 'FAILED  '}  ${r.input_tokens ?? '-'}/${r.output_tokens ?? '-'} tokens`);
  }
})();
