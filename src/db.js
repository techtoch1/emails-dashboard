'use strict';
// SQLite store (Node's built-in node:sqlite — no native module to compile on
// the server). Everything the dashboard knows lives here: the tenants it reads,
// one snapshot of every account per tenant per day, the lifecycle registry that
// turns those snapshots into "created" and "deleted" for accounting, the admin
// audit events Google reports, and the prices the accountant enters.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,
  admin_email   TEXT NOT NULL,          -- admin the service account impersonates (read-only scopes)
  customer_id   TEXT NOT NULL DEFAULT 'my_customer',
  key_file      TEXT,                   -- optional per-tenant service-account key; else GOOGLE_SA_KEY_FILE
  primary_domain TEXT,                  -- learned on first sync
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- Seats bought per tenant and license, when Google does not report them
-- (Flexible plans have no cap; Annual plans do). Entered by an admin.
CREATE TABLE IF NOT EXISTS seat_overrides (
  tenant_id INTEGER NOT NULL,
  sku       TEXT NOT NULL,
  seats     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER,
  accounts    INTEGER,
  warnings    TEXT,          -- JSON array of non-fatal problems (a missing scope, a lagging report)
  error       TEXT
);

-- Per tenant per day: domains hosted there, seat counts, pooled storage.
CREATE TABLE IF NOT EXISTS tenant_snapshots (
  tenant_id   INTEGER NOT NULL,
  date        TEXT NOT NULL,
  synced_at   TEXT NOT NULL,
  domains     TEXT NOT NULL,   -- JSON [{domain, primary, verified, alias_of}]
  seats       TEXT NOT NULL,   -- JSON {sku: {total, used}} as reported by Google
  storage_used_mb  REAL,
  storage_total_mb REAL,
  usage_date  TEXT,            -- the date Google's usage report actually covers (it lags 2–4 days)
  PRIMARY KEY (tenant_id, date)
);

-- One row per account per tenant per day. Re-syncing the same day replaces it.
CREATE TABLE IF NOT EXISTS account_snapshots (
  tenant_id   INTEGER NOT NULL,
  date        TEXT NOT NULL,
  email       TEXT NOT NULL,
  domain      TEXT NOT NULL,
  full_name   TEXT,
  status      TEXT NOT NULL,   -- active | suspended | archived
  sku         TEXT NOT NULL,   -- Workspace license name, 'Unlicensed' when none
  extra_skus  TEXT,            -- other licenses held (Vault, Archived User…), comma-separated
  gmail_gb    REAL, drive_gb REAL, photos_gb REAL, total_gb REAL,
  last_login  TEXT,            -- NULL = never signed in (Google's lastLoginTime: password sign-ins only)
  last_activity TEXT,          -- newest mailbox/account use from the usage report (Outlook, IMAP, mobile, web)
  created_on  TEXT,
  org_unit    TEXT,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, date, email)
);
CREATE INDEX IF NOT EXISTS idx_acc_snap_date ON account_snapshots(date);

-- Lifecycle registry: when each account was first and last seen, and when it
-- disappeared. This is what the accountant's created/deleted report reads.
CREATE TABLE IF NOT EXISTS accounts (
  tenant_id   INTEGER NOT NULL,
  email       TEXT NOT NULL,
  domain      TEXT NOT NULL,
  full_name   TEXT,
  created_on  TEXT,          -- Google's creationTime
  first_seen  TEXT NOT NULL, -- first snapshot date that contained it
  last_seen   TEXT NOT NULL,
  deleted_on  TEXT,          -- date it vanished (audit time when Google reported one)
  deleted_by  TEXT,
  created_by  TEXT,
  PRIMARY KEY (tenant_id, email)
);

-- Admin-console audit events (user created/deleted/suspended, license changes).
CREATE TABLE IF NOT EXISTS events (
  tenant_id INTEGER NOT NULL,
  time      TEXT NOT NULL,
  name      TEXT NOT NULL,
  email     TEXT,
  actor     TEXT,
  detail    TEXT,
  uid       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(time);

-- Prices: a domain's price applies to every licensed account on it; a row
-- with a specific sku overrides it for that license. Monthly, per account.
CREATE TABLE IF NOT EXISTS prices (
  domain     TEXT NOT NULL,
  sku        TEXT NOT NULL DEFAULT '*',
  price      REAL NOT NULL,
  note       TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (domain, sku)
);
CREATE TABLE IF NOT EXISTS price_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  domain     TEXT NOT NULL,
  sku        TEXT NOT NULL,
  old_price  REAL,
  new_price  REAL,
  changed_by TEXT,
  changed_at TEXT NOT NULL
);

-- Notes on a domain's pricing, e.g. for the accountant. @username mentions
-- are stored so each user can see the open notes that mention them.
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain      TEXT NOT NULL,
  body        TEXT NOT NULL,
  mentions    TEXT NOT NULL DEFAULT '[]',  -- JSON array of usernames
  author      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_domain ON notes(domain);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT,
  role          TEXT NOT NULL,   -- admin | accountant | viewer
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after the first release, for databases created before them.
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(account_snapshots)').all().map(c => c.name));
  if (!cols.has('last_activity')) db.exec('ALTER TABLE account_snapshots ADD COLUMN last_activity TEXT');
  // A purchased count of 0 was only ever a mis-entry (a license in use was bought).
  db.exec('DELETE FROM seat_overrides WHERE seats = 0');
  // A price of 0 means "no price set". Clear any saved before that rule,
  // and log each one so the change log explains where they went.
  const zero = db.prepare('SELECT domain, sku FROM prices WHERE price = 0').all();
  if (zero.length) {
    const now = new Date().toISOString();
    const log = db.prepare("INSERT INTO price_log (domain, sku, old_price, new_price, changed_by, changed_at) VALUES (?, ?, 0, NULL, 'system (0 = no price)', ?)");
    for (const z of zero) log.run(z.domain, z.sku, now);
    db.exec('DELETE FROM prices WHERE price = 0');
  }
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

module.exports = { open, tx, getSetting, setSetting };
