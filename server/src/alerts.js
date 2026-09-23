// Once a minute: evaluate every enabled alert rule against the last complete
// minute of traffic (from Redis), record fired alerts and notify.
import { query } from './db/postgres.js';
import { redis } from './db/redis.js';
import { evaluateRule } from './lib/anomaly.js';
import { keys, minuteOf, REALTIME_WINDOW_MS } from './lib/keys.js';
import { notify } from './notify.js';

const BASELINE_MINUTES = 30;

async function pageviewsPerMinute(tenantId, lastMinute) {
  const minutes = Array.from({ length: BASELINE_MINUTES + 1 }, (_, i) => lastMinute - BASELINE_MINUTES + i);
  const counts = await redis.mget(minutes.map((m) => keys.pageviewsMinute(tenantId, m)));
  return counts.map((c) => Number(c) || 0);
}

export async function runAlertChecks(now = Date.now()) {
  const lastMinute = minuteOf(now) - 1; // last *complete* minute
  // Several workers may run; only one evaluates each minute.
  const gotLock = await redis.set(keys.alertLock(lastMinute), '1', 'EX', 120, 'NX');
  if (!gotLock) return;

  const { rows: rules } = await query('SELECT * FROM alert_rules WHERE enabled');
  const byTenant = Map.groupBy(rules, (r) => r.tenant_id);

  for (const [tenantId, tenantRules] of byTenant) {
    const series = await pageviewsPerMinute(tenantId, lastMinute);
    const value = series.at(-1);
    const baseline = series.slice(0, -1);

    for (const rule of tenantRules) {
      const message = evaluateRule(rule, value, baseline);
      if (!message) continue;
      const cooling = !(await redis.set(keys.cooldown(rule.id), '1', 'EX', rule.cooldown_minutes * 60, 'NX'));
      if (cooling) continue;
      const { rows: [alert] } = await query(
        `INSERT INTO alerts (tenant_id, rule_id, rule_name, message, value)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, message, value, triggered_at`,
        [tenantId, rule.id, rule.name, message, value],
      );
      await notify(rule, { ...alert, tenantId });
    }

    // Housekeeping: drop visitors/sessions that are no longer "active".
    const cutoff = now - REALTIME_WINDOW_MS * 12;
    await redis.zremrangebyscore(keys.activeVisitors(tenantId), 0, cutoff);
    await redis.zremrangebyscore(keys.activeSessions(tenantId), 0, cutoff);
  }
}
