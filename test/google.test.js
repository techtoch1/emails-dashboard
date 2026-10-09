'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { GoogleClient, SCOPES } = require('../src/google');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { client_email: 'sa@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'tok', expires_in: 3600 });
    for (const [re, handler] of routes) if (re.test(url)) return handler(url);
    return json(404, { error: { message: 'no route' } });
  };
  fn.calls = calls;
  return fn;
}
const json = (status, body) => ({ ok: status < 300, status, statusText: '', json: async () => body });

test('signs a domain-wide-delegation JWT for the admin with read scopes', async () => {
  const f = mockFetch([]);
  const c = new GoogleClient({ key, subject: 'admin@tenant.example', fetch: f });
  assert.equal(await c.accessToken(), 'tok');
  const assertion = new URLSearchParams(f.calls[0].body).get('assertion');
  const [hd, cl, sig] = assertion.split('.');
  const claims = JSON.parse(Buffer.from(cl, 'base64url'));
  assert.equal(claims.sub, 'admin@tenant.example');
  assert.equal(claims.iss, key.client_email);
  assert.deepEqual(claims.scope.split(' '), SCOPES);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${hd}.${cl}`), publicKey, Buffer.from(sig, 'base64url')));
  for (const s of SCOPES) assert.ok(/readonly$/.test(s) || s.endsWith('/apps.licensing'), `${s} should be read-only`);
});

test('follows pagination and never sends anything but GET to Google APIs', async () => {
  const f = mockFetch([[/\/users\?/, url => new URL(url).searchParams.get('pageToken')
    ? json(200, { users: [{ primaryEmail: 'b@x.example' }] })
    : json(200, { users: [{ primaryEmail: 'a@x.example' }], nextPageToken: 'p2' })]]);
  const c = new GoogleClient({ key, subject: 'admin@x.example', fetch: f });
  const users = await c.listUsers();
  assert.deepEqual(users.map(u => u.primaryEmail), ['a@x.example', 'b@x.example']);
  for (const call of f.calls.filter(x => !x.url.includes('oauth2'))) assert.equal(call.method, 'GET');
});

test('walks back to the newest day the usage report has data for', async () => {
  const f = mockFetch([[/usage\/users\/all\/dates\/(\d{4}-\d{2}-\d{2})/, url => {
    const date = /dates\/([\d-]+)/.exec(url)[1];
    const fourAgo = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
    if (date > fourAgo) return json(400, { error: { message: `Data for dates later than ${fourAgo} is not yet available.` } });
    return json(200, { usageReports: [{ entity: { userEmail: 'A@x.example' }, parameters: [{ name: 'accounts:used_quota_in_mb', intValue: '2048' }, { name: 'accounts:gmail_used_quota_in_mb', intValue: '1024' }] }] });
  }]]);
  const c = new GoogleClient({ key, subject: 'admin@x.example', fetch: f });
  const s = await c.userStorage();
  assert.equal(s.date, new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10));
  assert.deepEqual(s.byEmail.get('a@x.example'), { gmail_gb: 1, drive_gb: null, photos_gb: null, total_gb: 2 });
});

test('reads seat counts from the customer usage report', async () => {
  const f = mockFetch([[/usage\/dates\//, () => json(200, { usageReports: [{ parameters: [
    { name: 'accounts:gsuite_basic_total_licenses', intValue: '50' }, { name: 'accounts:gsuite_basic_used_licenses', intValue: '42' },
    { name: 'accounts:used_quota_in_mb', intValue: '10240' }] }] })]]);
  const c = new GoogleClient({ key, subject: 'admin@x.example', fetch: f });
  const u = await c.customerUsage();
  assert.deepEqual(u.seats, { gsuite_basic: { total: 50, used: 42 } });
  assert.equal(u.storage_used_mb, 10240);
});
