// Stream worker: consumes tracker events from Kafka, writes them to the
// dual-store layer and runs the per-minute alert checks.
import { config } from './config.js';
import { kafka } from './db/kafka.js';
import { driver } from './db/neo4j.js';
import { pool } from './db/postgres.js';
import { redis } from './db/redis.js';
import { processEvents } from './pipeline.js';
import { runAlertChecks } from './alerts.js';
import { waitFor } from './lib/retry.js';

const consumer = kafka.consumer({ groupId: 'gp-workers' });
let processed = 0;

await waitFor('neo4j', () => driver.verifyConnectivity());
await waitFor('kafka consumer', () => consumer.connect());
await consumer.subscribe({ topic: config.eventsTopic, fromBeginning: true });

await consumer.run({
  eachBatchAutoResolve: false,
  eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
    const CHUNK = 500;
    for (let i = 0; i < batch.messages.length && isRunning() && !isStale(); i += CHUNK) {
      const messages = batch.messages.slice(i, i + CHUNK);
      const events = [];
      for (const m of messages) {
        try {
          events.push(JSON.parse(m.value.toString()));
        } catch {
          console.warn(`[worker] skipping malformed message at offset ${m.offset}`);
        }
      }
      // Throwing here makes kafkajs retry the batch; writes are idempotent.
      await processEvents(events);
      resolveOffset(messages.at(-1).offset);
      processed += events.length;
      await heartbeat();
    }
  },
});
console.log(`[worker] consuming ${config.eventsTopic}`);

const alertTimer = setInterval(() => {
  runAlertChecks().catch((err) => console.error('[worker] alert check failed:', err));
}, 15_000); // the per-minute lock makes extra ticks no-ops

const statsTimer = setInterval(() => {
  if (processed) console.log(`[worker] processed ${processed} events in the last 30s`);
  processed = 0;
}, 30_000);

const shutdown = async () => {
  clearInterval(alertTimer);
  clearInterval(statsTimer);
  await consumer.disconnect().catch(() => {});
  await Promise.allSettled([driver.close(), pool.end(), redis.quit()]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
