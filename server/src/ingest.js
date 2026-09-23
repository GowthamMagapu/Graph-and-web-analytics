// Ingestion gateway: validates tracker events and publishes them to Kafka.
// Also serves the tracking snippet and a small demo site that uses it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Partitioners } from 'kafkajs';
import { config } from './config.js';
import { kafka } from './db/kafka.js';
import { query } from './db/postgres.js';
import { mountCollector, mountTrackerRoutes } from './lib/collect.js';
import { waitFor } from './lib/retry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT_CACHE_MS = 60_000;
const tenantCache = new Map(); // apiKey -> { tenantId, expires }

async function resolveTenant(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey) return null;
  const hit = tenantCache.get(apiKey);
  if (hit && hit.expires > Date.now()) return hit.tenantId;
  const { rows } = await query('SELECT id FROM tenants WHERE api_key = $1', [apiKey]);
  const tenantId = rows[0]?.id ?? null;
  tenantCache.set(apiKey, { tenantId, expires: Date.now() + TENANT_CACHE_MS });
  return tenantId;
}

const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });

// Keyed by tenant+session so every event of a session lands on the same
// partition, in order - the worker relies on that to sequence page views.
const publish = (events) => producer.send({
  topic: config.eventsTopic,
  messages: events.map((e) => ({ key: `${e.tenantId}:${e.sessionId}`, value: JSON.stringify(e) })),
});

const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true, service: 'ingest' }));
mountTrackerRoutes(app, root);
mountCollector(app, { resolveTenant, publish });

app.use((err, _req, res, _next) => {
  console.error('[ingest]', err);
  res.status(500).json({ error: 'internal error' });
});

await waitFor('kafka producer', () => producer.connect());
app.listen(config.ingestPort, () => {
  console.log(`[ingest] listening on http://localhost:${config.ingestPort}  (demo site: /demo/)`);
});

const shutdown = async () => {
  await producer.disconnect().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
