// GraphPulse lite mode: the whole platform in one Node process, no Docker.
//   SQLite (node:sqlite)  instead of Postgres
//   MemGraph              instead of Neo4j
//   in-process calls      instead of Kafka
//   Realtime (in-memory)  instead of Redis
// Serves the tracker, demo site, collector, GraphQL API and the built dashboard
// on a single port. Seeds a week of demo traffic on first start.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createSchema, createYoga } from 'graphql-yoga';
import { config } from './config.js';
import { typeDefs } from './typeDefs.js';
import { userFromAuthHeader } from './lib/auth.js';
import { mountCollector, mountTrackerRoutes } from './lib/collect.js';
import { loginHandler } from './lib/login.js';
import { evaluateRule } from './lib/anomaly.js';
import { minuteOf } from './lib/keys.js';
import { notify } from './notify.js';
import { MemGraph } from './lite/memgraph.js';
import { Realtime } from './lite/realtime.js';
import { insertEvents, loadEvents, openStore } from './lite/store.js';
import { createLiteResolvers } from './lite/resolvers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT || 4000);
const DB_FILE = process.env.LITE_DB || path.join(root, 'data', 'graphpulse.db');
const dist = path.join(root, 'web', 'dist');
const isProduction = process.env.NODE_ENV === 'production';

// A public deployment must not run with the dev JWT secret or the demo password.
const admin = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
  ? { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
  : null;
if (isProduction && (!process.env.JWT_SECRET || !admin)) {
  console.error('[lite] In production set JWT_SECRET, ADMIN_EMAIL and ADMIN_PASSWORD.');
  process.exit(1);
}
// Demo traffic only for local demos; a real site's dashboard should show real visitors.
const seedDemoTraffic = !admin && process.env.LITE_SEED !== 'false' && !process.argv.includes('--no-seed');

// ---- storage + in-memory engines --------------------------------------------
const db = openStore(DB_FILE, { demoApiKey: config.demoApiKey, admin });
const graph = new MemGraph();
const realtime = new Realtime();
const history = loadEvents(db);
for (const e of history) {
  graph.add(e);
  realtime.add(e);
}

function ingest(events) {
  for (const e of insertEvents(db, events)) {
    graph.add(e);
    realtime.add(e);
  }
}

const tenantByKey = db.prepare('SELECT id FROM tenants WHERE api_key = ?');
const resolveTenant = (apiKey) => (typeof apiKey === 'string' ? tenantByKey.get(apiKey)?.id ?? null : null);

// ---- HTTP -------------------------------------------------------------------
const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers: createLiteResolvers({ db, graph, realtime }) }),
  context: ({ request }) => ({ user: userFromAuthHeader(request.headers.get('authorization')) }),
});

const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true, mode: 'lite' }));
mountTrackerRoutes(app, root);
mountCollector(app, { resolveTenant, publish: ingest });
app.post('/auth/login', express.json(), loginHandler({
  findUserByEmail: (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email),
  findTenant: (id) => db.prepare('SELECT name, api_key FROM tenants WHERE id = ?').get(id),
}));
app.use(yoga.graphqlEndpoint, yoga);

if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.use((req, res, next) => (req.method === 'GET' && req.accepts('html') ? res.sendFile(path.join(dist, 'index.html')) : next()));
} else {
  app.get('/', (_req, res) => res.type('text').send('Dashboard not built. Run: npm run build (or use `npm run lite`).'));
}

app.use((err, _req, res, _next) => {
  console.error('[lite]', err);
  res.status(500).json({ error: 'internal error' });
});

// ---- alerts (once per minute, same rules as the full worker) ----------------
const cooldownUntil = new Map();
let lastCheckedMinute = minuteOf(Date.now()) - 1;

function checkAlerts(now = Date.now()) {
  const lastMinute = minuteOf(now) - 1;
  if (lastMinute <= lastCheckedMinute) return;
  lastCheckedMinute = lastMinute;
  const rules = db.prepare('SELECT * FROM alert_rules WHERE enabled = 1').all();
  for (const rule of rules) {
    const series = realtime.series(rule.tenant_id, lastMinute, 31);
    const value = series.at(-1);
    const message = evaluateRule(rule, value, series.slice(0, -1));
    if (!message || (cooldownUntil.get(rule.id) || 0) > now) continue;
    cooldownUntil.set(rule.id, now + rule.cooldown_minutes * 60_000);
    const { lastInsertRowid } = db.prepare(`INSERT INTO alerts (tenant_id, rule_id, rule_name, message, value, triggered_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(rule.tenant_id, rule.id, rule.name, message, value, now);
    notify(rule, { id: Number(lastInsertRowid), message, value, triggered_at: new Date(now), tenantId: rule.tenant_id });
  }
  realtime.prune(now);
}
setInterval(checkAlerts, 15_000);

// ---- start --------------------------------------------------------------------
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  GraphPulse (lite mode) is running\n`);
  console.log(`  Dashboard   ${url}   (${admin ? admin.email : 'admin@demo.local / graphpulse'})`);
  console.log(`  Demo site   ${url}/demo/index.html`);
  console.log(`  GraphQL     ${url}/graphql`);
  console.log(`  Data file   ${DB_FILE}  (${history.length} events loaded)\n`);

  if (!history.length && seedDemoTraffic) {
    console.log('  First run: generating a week of demo traffic...');
    const sim = spawn(process.execPath, [
      path.join(root, 'server', 'scripts', 'simulate.js'),
      '--backfill', '7', '--sessions', '3000', '--endpoint', `${url}/v1/collect`,
    ], { stdio: 'inherit' });
    sim.on('exit', (code) => console.log(code === 0 ? '  Demo data ready - refresh the dashboard.\n' : `  Demo data generation failed (exit ${code}).`));
  }
});
