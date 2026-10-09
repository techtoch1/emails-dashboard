'use strict';
// An offline stand-in for GoogleClient: serves a tenant whose accounts are
// created and deleted on given dates, as seen on `asOf`. Used by the tests
// and by the demo seed.
class FakeGoogle {
  constructor(spec, asOf) { this.spec = spec; this.asOf = asOf; this.calls = []; }
  alive() { return this.spec.users.filter(u => u.created <= this.asOf && (!u.deleted || u.deleted > this.asOf)); }
  async accessToken() { if (this.spec.failAuth) throw new Error('Token request failed: unauthorized_client'); return 'fake'; }
  async listDomains() { this.calls.push('domains'); return this.spec.domains.map((d, i) => ({ domain: d, primary: i === 0, verified: true, alias_of: null })); }
  async listUsers() {
    this.calls.push('users');
    return this.alive().map(u => ({
      primaryEmail: u.email, name: { fullName: u.name }, suspended: !!u.suspended, archived: !!u.archived,
      creationTime: `${u.created}T09:00:00.000Z`, lastLoginTime: u.lastLogin || '1970-01-01T00:00:00.000Z', orgUnitPath: '/', isAdmin: false,
    }));
  }
  async listLicenses() {
    this.calls.push('licenses');
    if (this.spec.failLicenses) throw new Error('Not Authorized to access this resource/api');
    return this.alive().filter(u => u.sku).map(u => ({ email: u.email, productId: 'Google-Apps', skuId: 'x', sku: u.sku }));
  }
  async userStorage() {
    const byEmail = new Map(this.alive().map(u => [u.email, { gmail_gb: u.gb * 0.7, drive_gb: u.gb * 0.3, photos_gb: 0, total_gb: u.gb }]));
    return { date: this.asOf, byEmail };
  }
  async customerUsage() {
    return { date: this.asOf, seats: this.spec.seats || {}, storage_used_mb: this.alive().reduce((s, u) => s + u.gb * 1024, 0), storage_total_mb: this.spec.pooledMb || null };
  }
  async adminEvents(since) {
    const out = [];
    for (const u of this.spec.users) {
      for (const [name, d] of [['CREATE_USER', u.created], ['DELETE_USER', u.deleted]]) {
        if (!d || d > this.asOf) continue;
        const time = `${d}T10:00:00.000Z`;
        if (time < since) continue;
        out.push({ uid: `${u.email}:${name}:${d}`, time, name, email: u.email, actor: this.spec.actor || 'admin@example.com', detail: '{}' });
      }
    }
    return out;
  }
}
module.exports = { FakeGoogle };
