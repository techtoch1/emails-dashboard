'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dbm = require('../src/db');
const ai = require('../src/ai');

function seed() {
  const db = dbm.open(':memory:');
  const id = db.prepare("INSERT INTO tenants (label, admin_email, created_at) VALUES ('T1', 'a@t.example', 'x')").run().lastInsertRowid;
  db.prepare("INSERT INTO tenant_snapshots (tenant_id, date, synced_at, domains, seats) VALUES (?, '2026-10-09', 'x', '[]', '{}')").run(id);
  db.prepare("INSERT INTO account_snapshots (tenant_id, date, email, domain, status, sku) VALUES (?, '2026-10-09', 'u@client.example', 'client.example', 'active', 'Google Workspace Business Starter')").run(id);
  db.prepare("INSERT INTO prices (domain, sku, price, updated_at) VALUES ('client.example', '*', 6.5, 'x')").run();
  return db;
}

// A stand-in for the Claude client: first asks for list_domains, then answers;
// records every request so the test can inspect what Claude was sent.
function fakeClaude() {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async req => {
      requests.push(JSON.parse(JSON.stringify(req)));
      if (requests.length === 1) {
        return { stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10 }, content: [
          { type: 'tool_use', id: 't1', name: 'list_domains', input: { search: null, tenant: null, reseller: null } }] };
      }
      return { stop_reason: 'end_turn', usage: { input_tokens: 150, output_tokens: 20 }, content: [{ type: 'text', text: 'client.example has 1 email.' }] };
    } } },
  };
}

test('prices reach Claude only for the admin, never for an accountant or viewer', async () => {
  const db = seed();
  for (const [role, seesPrices] of [['admin', true], ['accountant', false], ['viewer', false]]) {
    const fake = fakeClaude();
    ai.setClient(fake);
    const r = await ai.ask(db, { username: role, role }, 'What does client.example pay?');
    assert.equal(r.answer, 'client.example has 1 email.');
    assert.deepEqual(r.looked, ['list_domains']);
    const toolResult = fake.requests[1].messages.at(-1).content[0].content;
    assert.match(toolResult, /client\.example/);
    if (seesPrices) assert.match(toolResult, /"price":6\.5/);
    else assert.doesNotMatch(toolResult, /price|monthly_cost|currency|6\.5/, `${role} must not receive prices`);
    assert.equal(/only the admin can get answers about prices/.test(fake.requests[0].system), !seesPrices);
  }
});

test('tools are strict, read-only lookups and the request uses the default model with fallbacks', async () => {
  const fake = fakeClaude();
  ai.setClient(fake);
  await ai.ask(seed(), { username: 'a', role: 'admin' }, 'hi', [{ role: 'assistant', text: 'earlier' }, { role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }]);
  const req = fake.requests[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.messages[0].role, 'user', 'history starts with a user turn');
  assert.match(req.messages.at(-1).content, /\(Today is \d{4}-\d{2}-\d{2}\.\)\n\nhi$/);
  for (const t of req.tools) {
    assert.equal(t.strict, true);
    assert.equal(t.input_schema.additionalProperties, false);
    assert.doesNotMatch(t.name, /set|update|delete|create/);
  }
});

test('a refusal is answered politely instead of failing', async () => {
  ai.setClient({ beta: { messages: { create: async () => ({ stop_reason: 'refusal', usage: {}, content: [] }) } } });
  const r = await ai.ask(seed(), { username: 'v', role: 'viewer' }, 'x');
  assert.match(r.answer, /can’t help/);
});
