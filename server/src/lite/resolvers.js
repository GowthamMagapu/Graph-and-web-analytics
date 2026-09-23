// GraphQL resolvers for lite mode: same schema as schema.js, backed by
// SQLite (aggregates) + MemGraph (journeys, funnels) + Realtime (live counters).
import { randomUUID } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { requireRole } from '../lib/auth.js';
import { funnelRows } from '../lib/funnel.js';
import { DEFAULT_WIDGETS, RANGES } from '../typeDefs.js';

const BUCKET_MS = { minute: 60_000, hour: 3600_000, day: 86_400_000 };
const clampLimit = (n, max = 100) => Math.min(Math.max(1, n), max);
const badInput = (message) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

const ruleRow = (r) => r && { ...r, enabled: Boolean(r.enabled) };
const alertRow = (a) => ({ ...a, triggered_at: new Date(a.triggered_at) });

export function createLiteResolvers({ db, graph, realtime }) {
  const since = (range) => Date.now() - RANGES[range].ms;

  function kpis(tenantId, from, to) {
    const r = db.prepare(`
      WITH e AS (SELECT type, visitor_id, session_id FROM events WHERE tenant_id = ? AND ts >= ? AND ts < ?),
           s AS (SELECT session_id, sum(type = 'pageview') AS pv, max(type = 'conversion') AS converted
                 FROM e GROUP BY session_id)
      SELECT (SELECT count(*) FROM e WHERE type = 'pageview')   AS pageviews,
             (SELECT count(DISTINCT visitor_id) FROM e)         AS visitors,
             (SELECT count(*) FROM s)                           AS sessions,
             (SELECT count(*) FROM s WHERE pv <= 1)             AS bounces,
             (SELECT coalesce(avg(pv), 0) FROM s)               AS pages_per_session,
             (SELECT count(*) FROM e WHERE type = 'conversion') AS conversions,
             (SELECT count(*) FROM s WHERE converted)           AS converted_sessions`).get(tenantId, from, to);
    return {
      pageviews: r.pageviews,
      visitors: r.visitors,
      sessions: r.sessions,
      bounceRate: r.sessions ? r.bounces / r.sessions : 0,
      pagesPerSession: r.pages_per_session,
      conversions: r.conversions,
      conversionRate: r.sessions ? r.converted_sessions / r.sessions : 0,
    };
  }

  return {
    Query: {
      me: (_, __, ctx) => requireRole(ctx),

      overview: (_, { range }, ctx) => {
        const { tenantId } = requireRole(ctx);
        const now = Date.now();
        const { ms } = RANGES[range];
        return { current: kpis(tenantId, now - ms, now), previous: kpis(tenantId, now - 2 * ms, now - ms) };
      },

      realtime: (_, __, ctx) => realtime.snapshot(requireRole(ctx).tenantId),

      timeseries: (_, { range }, ctx) => {
        const { tenantId } = requireRole(ctx);
        const step = BUCKET_MS[RANGES[range].bucket];
        const from = Math.floor(since(range) / step) * step;
        // node:sqlite binds JS numbers as REAL, so truncate explicitly to get whole buckets.
        const rows = db.prepare(`SELECT CAST(ts / ? AS INTEGER) * ? AS t, sum(type = 'pageview') AS pageviews,
            count(DISTINCT visitor_id) AS visitors
          FROM events WHERE tenant_id = ? AND ts >= ? GROUP BY 1`).all(step, step, tenantId, from);
        const byBucket = new Map(rows.map((r) => [r.t, r]));
        const out = [];
        for (let t = from; t <= Date.now(); t += step) {
          const r = byBucket.get(t);
          out.push({ t: new Date(t).toISOString(), pageviews: r?.pageviews ?? 0, visitors: r?.visitors ?? 0 });
        }
        return out;
      },

      topPages: (_, { range, limit }, ctx) => {
        const { tenantId } = requireRole(ctx);
        return db.prepare(`SELECT path, count(*) AS views, count(DISTINCT visitor_id) AS visitors
          FROM events WHERE tenant_id = ? AND ts >= ? AND type = 'pageview'
          GROUP BY path ORDER BY views DESC LIMIT ?`).all(tenantId, since(range), clampLimit(limit));
      },

      topReferrers: (_, { range, limit }, ctx) => graph.referrers(requireRole(ctx).tenantId, since(range), clampLimit(limit)),
      journey: (_, { range, limit }, ctx) => graph.journey(requireRole(ctx).tenantId, since(range), clampLimit(limit)),
      dropOffs: (_, { range, limit }, ctx) => graph.dropOffs(requireRole(ctx).tenantId, since(range), clampLimit(limit)),

      funnel: (_, { range, steps }, ctx) => {
        const { tenantId } = requireRole(ctx);
        if (steps.length < 2 || steps.length > 8) throw badInput('A funnel needs 2-8 steps');
        return funnelRows(steps, graph.funnel(tenantId, since(range), steps));
      },

      catalog: (_, __, ctx) => graph.catalog(requireRole(ctx).tenantId),

      alertRules: (_, __, ctx) => {
        const { tenantId } = requireRole(ctx);
        return db.prepare('SELECT * FROM alert_rules WHERE tenant_id = ? ORDER BY created_at').all(tenantId).map(ruleRow);
      },

      alerts: (_, { limit }, ctx) => {
        const { tenantId } = requireRole(ctx);
        return db.prepare('SELECT * FROM alerts WHERE tenant_id = ? ORDER BY triggered_at DESC LIMIT ?')
          .all(tenantId, clampLimit(limit, 500)).map(alertRow);
      },

      dashboard: (_, __, ctx) => {
        const user = requireRole(ctx);
        const row = db.prepare('SELECT widgets FROM dashboards WHERE user_id = ?').get(user.id);
        return row ? JSON.parse(row.widgets) : DEFAULT_WIDGETS;
      },
    },

    Mutation: {
      createAlertRule: (_, { input }, ctx) => {
        const { tenantId } = requireRole(ctx, 'admin');
        if (['slack', 'webhook'].includes(input.channel) && !/^https:\/\//.test(input.target || '')) {
          throw badInput('Slack and webhook channels need an https:// target URL');
        }
        if (input.channel === 'email' && !/^[^@\s]+@[^@\s]+$/.test(input.target || '')) {
          throw badInput('Email channel needs a valid address');
        }
        const id = randomUUID();
        db.prepare(`INSERT INTO alert_rules (id, tenant_id, name, condition, threshold, channel, target, cooldown_minutes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, tenantId, input.name, input.condition, input.threshold,
          input.channel, input.target || null, Math.max(1, input.cooldownMinutes), Date.now());
        return ruleRow(db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id));
      },

      setAlertRuleEnabled: (_, { id, enabled }, ctx) => {
        const { tenantId } = requireRole(ctx, 'admin');
        db.prepare('UPDATE alert_rules SET enabled = ? WHERE id = ? AND tenant_id = ?').run(enabled ? 1 : 0, id, tenantId);
        const rule = db.prepare('SELECT * FROM alert_rules WHERE id = ? AND tenant_id = ?').get(id, tenantId);
        if (!rule) throw new GraphQLError('Alert rule not found', { extensions: { code: 'NOT_FOUND' } });
        return ruleRow(rule);
      },

      deleteAlertRule: (_, { id }, ctx) => {
        const { tenantId } = requireRole(ctx, 'admin');
        return db.prepare('DELETE FROM alert_rules WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
      },

      saveDashboard: (_, { widgets }, ctx) => {
        const user = requireRole(ctx, 'analyst');
        const clean = [...new Set(widgets)].filter((w) => DEFAULT_WIDGETS.includes(w));
        db.prepare(`INSERT INTO dashboards (user_id, widgets) VALUES (?, ?)
          ON CONFLICT (user_id) DO UPDATE SET widgets = excluded.widgets`).run(user.id, JSON.stringify(clean));
        return clean;
      },
    },

    AlertRule: { cooldownMinutes: (r) => r.cooldown_minutes },
    Alert: {
      ruleName: (a) => a.rule_name,
      triggeredAt: (a) => a.triggered_at.toISOString(),
    },
  };
}
