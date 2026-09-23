// SQLite storage for lite mode (Node's built-in node:sqlite - nothing to install).
// Mirrors the Postgres schema in migrate.js; timestamps are epoch milliseconds.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'analyst', 'admin'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT,
  visitor_id TEXT NOT NULL, session_id TEXT NOT NULL,
  path TEXT, url TEXT, referrer TEXT, title TEXT, device TEXT,
  props TEXT NOT NULL DEFAULT '{}', ts INTEGER NOT NULL,
  UNIQUE (tenant_id, event_id)
);
CREATE INDEX IF NOT EXISTS events_tenant_ts ON events (tenant_id, ts);
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL, metric TEXT NOT NULL DEFAULT 'pageviews_per_min',
  condition TEXT NOT NULL CHECK (condition IN ('above', 'below', 'anomaly')),
  threshold REAL NOT NULL DEFAULT 3,
  channel TEXT NOT NULL CHECK (channel IN ('log', 'slack', 'email', 'webhook')),
  target TEXT, cooldown_minutes INTEGER NOT NULL DEFAULT 15,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id TEXT, rule_name TEXT NOT NULL, message TEXT NOT NULL,
  value REAL, triggered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_tenant_time ON alerts (tenant_id, triggered_at);
CREATE TABLE IF NOT EXISTS dashboards (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  widgets TEXT NOT NULL
);
`;

export function openStore(file, { demoApiKey, admin }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  seed(db, demoApiKey, admin);
  return db;
}

/**
 * First start: create the tenant, users and default alert rules.
 * With `admin` ({ email, password }) only that admin is created - use this for any
 * public deployment. Without it, local demo users share the password "graphpulse".
 */
function seed(db, apiKey, admin) {
  if (db.prepare('SELECT 1 FROM tenants WHERE api_key = ?').get(apiKey)) return;
  const tenantId = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO tenants (id, name, api_key, created_at) VALUES (?, ?, ?, ?)')
    .run(tenantId, admin ? 'My Website' : 'Demo Co', apiKey, now);
  const addUser = db.prepare('INSERT OR IGNORE INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  if (admin) {
    addUser.run(randomUUID(), tenantId, admin.email.toLowerCase(), bcrypt.hashSync(admin.password, 10), 'admin');
  } else {
    const hash = bcrypt.hashSync('graphpulse', 10);
    for (const role of ['admin', 'analyst', 'viewer']) addUser.run(randomUUID(), tenantId, `${role}@demo.local`, hash, role);
  }
  const addRule = db.prepare(`INSERT INTO alert_rules (id, tenant_id, name, condition, threshold, channel, cooldown_minutes, created_at)
    VALUES (?, ?, ?, ?, ?, 'log', ?, ?)`);
  addRule.run(randomUUID(), tenantId, 'Traffic anomaly (z >= 3)', 'anomaly', 3, 10, now);
  addRule.run(randomUUID(), tenantId, 'Traffic flatlined', 'below', 1, 30, now + 1);
}

/** Insert events; returns only the ones that were new (idempotent on eventId). */
export function insertEvents(db, events) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO events
    (tenant_id, event_id, type, name, visitor_id, session_id, path, url, referrer, title, device, props, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const fresh = [];
  db.exec('BEGIN');
  try {
    for (const e of events) {
      const { changes } = stmt.run(e.tenantId, e.eventId, e.type, e.name, e.visitorId, e.sessionId, e.path,
        e.url, e.referrer, e.title, e.device, JSON.stringify(e.props), e.ts);
      if (changes) fresh.push(e);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return fresh;
}

/** All stored events, oldest first, in the shape the in-memory graph expects. */
export function loadEvents(db) {
  return db.prepare(`SELECT tenant_id AS tenantId, type, name, visitor_id AS visitorId, session_id AS sessionId,
    path, referrer, ts FROM events ORDER BY ts`).all();
}
