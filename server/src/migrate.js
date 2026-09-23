// Creates the Postgres schema, Neo4j constraints and Kafka topic, then seeds a demo tenant.
// Safe to run repeatedly.
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { pool } from './db/postgres.js';
import { driver } from './db/neo4j.js';
import { kafka } from './db/kafka.js';
import { waitFor } from './lib/retry.js';

const SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  api_key     text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('viewer', 'analyst', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL,
  type        text NOT NULL,
  name        text,
  visitor_id  text NOT NULL,
  session_id  text NOT NULL,
  path        text,
  url         text,
  referrer    text,
  title       text,
  device      text,
  props       jsonb NOT NULL DEFAULT '{}',
  ts          timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id)
);
CREATE INDEX IF NOT EXISTS events_tenant_ts ON events (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_tenant_session ON events (tenant_id, session_id, ts);

CREATE TABLE IF NOT EXISTS alert_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  metric           text NOT NULL DEFAULT 'pageviews_per_min',
  condition        text NOT NULL CHECK (condition IN ('above', 'below', 'anomaly')),
  threshold        double precision NOT NULL DEFAULT 3,
  channel          text NOT NULL CHECK (channel IN ('log', 'slack', 'email', 'webhook')),
  target           text,
  cooldown_minutes integer NOT NULL DEFAULT 15,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id      uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  rule_name    text NOT NULL,
  message      text NOT NULL,
  value        double precision,
  triggered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_tenant_time ON alerts (tenant_id, triggered_at DESC);

CREATE TABLE IF NOT EXISTS dashboards (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  widgets    jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

const CYPHER = [
  'CREATE CONSTRAINT visitor_key IF NOT EXISTS FOR (n:Visitor) REQUIRE (n.tenantId, n.id) IS UNIQUE',
  'CREATE CONSTRAINT session_key IF NOT EXISTS FOR (n:Session) REQUIRE (n.tenantId, n.id) IS UNIQUE',
  'CREATE CONSTRAINT page_key IF NOT EXISTS FOR (n:Page) REQUIRE (n.tenantId, n.path) IS UNIQUE',
  'CREATE CONSTRAINT goal_key IF NOT EXISTS FOR (n:Goal) REQUIRE (n.tenantId, n.name) IS UNIQUE',
  'CREATE CONSTRAINT event_type_key IF NOT EXISTS FOR (n:EventType) REQUIRE (n.tenantId, n.name) IS UNIQUE',
  'CREATE INDEX session_tenant IF NOT EXISTS FOR (n:Session) ON (n.tenantId)',
  'CREATE INDEX viewed_ts IF NOT EXISTS FOR ()-[r:VIEWED]-() ON (r.ts)',
];

async function migratePostgres() {
  await waitFor('postgres', () => pool.query('SELECT 1'));
  await pool.query(SQL);
  console.log('[migrate] postgres schema ready');
}

async function migrateNeo4j() {
  await waitFor('neo4j', () => driver.verifyConnectivity());
  for (const stmt of CYPHER) await driver.executeQuery(stmt);
  console.log('[migrate] neo4j constraints ready');
}

async function migrateKafka() {
  const admin = kafka.admin();
  await waitFor('kafka', () => admin.connect());
  const created = await admin.createTopics({
    topics: [{ topic: config.eventsTopic, numPartitions: 6, replicationFactor: 1 }],
  });
  await admin.disconnect();
  console.log(`[migrate] kafka topic ${config.eventsTopic} ${created ? 'created' : 'already exists'}`);
}

async function seed() {
  const { rows: [tenant] } = await pool.query(
    `INSERT INTO tenants (name, api_key) VALUES ('Demo Co', $1)
     ON CONFLICT (api_key) DO UPDATE SET name = tenants.name RETURNING id`,
    [config.demoApiKey],
  );
  const hash = await bcrypt.hash('graphpulse', 10);
  for (const [email, role] of [['admin@demo.local', 'admin'], ['analyst@demo.local', 'analyst'], ['viewer@demo.local', 'viewer']]) {
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [tenant.id, email, hash, role],
    );
  }
  const { rowCount } = await pool.query('SELECT 1 FROM alert_rules WHERE tenant_id = $1', [tenant.id]);
  if (!rowCount) {
    await pool.query(
      `INSERT INTO alert_rules (tenant_id, name, condition, threshold, channel, cooldown_minutes) VALUES
       ($1, 'Traffic anomaly (z >= 3)', 'anomaly', 3, 'log', 10),
       ($1, 'Traffic flatlined', 'below', 1, 'log', 30)`,
      [tenant.id],
    );
  }
  console.log(`[migrate] demo tenant ${tenant.id} (api key: ${config.demoApiKey})`);
  console.log('[migrate] logins: admin@demo.local / analyst@demo.local / viewer@demo.local, password "graphpulse"');
}

try {
  await migratePostgres();
  await migrateNeo4j();
  await migrateKafka();
  await seed();
} catch (err) {
  console.error('[migrate] failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
  await driver.close();
}
