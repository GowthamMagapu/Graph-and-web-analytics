import { GraphQLError } from 'graphql';
import { query } from './db/postgres.js';
import { int, read } from './db/neo4j.js';
import { redis } from './db/redis.js';
import { requireRole } from './lib/auth.js';
import { buildFunnelQuery, funnelRows } from './lib/funnel.js';
import { keys, minuteOf, REALTIME_WINDOW_MS } from './lib/keys.js';
import { DEFAULT_WIDGETS, RANGES } from './typeDefs.js';

export { typeDefs } from './typeDefs.js';

const clampLimit = (n, max = 100) => Math.min(Math.max(1, n), max);

async function kpis(tenantId, from, to) {
  const { rows: [r] } = await query(
    `WITH e AS (
       SELECT type, visitor_id, session_id FROM events
       WHERE tenant_id = $1 AND ts >= $2 AND ts < $3
     ), s AS (
       SELECT session_id, count(*) FILTER (WHERE type = 'pageview') AS pv,
              bool_or(type = 'conversion') AS converted
       FROM e GROUP BY session_id
     )
     SELECT
       (SELECT count(*) FROM e WHERE type = 'pageview')::int AS pageviews,
       (SELECT count(DISTINCT visitor_id) FROM e)::int      AS visitors,
       (SELECT count(*) FROM s)::int                         AS sessions,
       (SELECT count(*) FROM s WHERE pv <= 1)::int           AS bounces,
       (SELECT coalesce(avg(pv), 0) FROM s)::float           AS pages_per_session,
       (SELECT count(*) FROM e WHERE type = 'conversion')::int AS conversions,
       (SELECT count(*) FROM s WHERE converted)::int         AS converted_sessions`,
    [tenantId, new Date(from), new Date(to)],
  );
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

export const resolvers = {
  Query: {
    me: (_, __, ctx) => requireRole(ctx),

    overview: async (_, { range }, ctx) => {
      const { tenantId } = requireRole(ctx);
      const now = Date.now();
      const { ms } = RANGES[range];
      const [current, previous] = await Promise.all([
        kpis(tenantId, now - ms, now),
        kpis(tenantId, now - 2 * ms, now - ms),
      ]);
      return { current, previous };
    },

    realtime: async (_, __, ctx) => {
      const { tenantId } = requireRole(ctx);
      const now = Date.now();
      const since = now - REALTIME_WINDOW_MS;
      const current = minuteOf(now);
      const minutes = Array.from({ length: 30 }, (_, i) => current - 29 + i);
      const [visitors, sessions, counts, ...pageSets] = await Promise.all([
        redis.zcount(keys.activeVisitors(tenantId), since, '+inf'),
        redis.zcount(keys.activeSessions(tenantId), since, '+inf'),
        redis.mget(minutes.map((m) => keys.pageviewsMinute(tenantId, m))),
        ...minutes.slice(-5).map((m) => redis.zrange(keys.pagesMinute(tenantId, m), 0, -1, 'WITHSCORES')),
      ]);
      const pageTotals = new Map();
      for (const set of pageSets) {
        for (let i = 0; i < set.length; i += 2) pageTotals.set(set[i], (pageTotals.get(set[i]) || 0) + Number(set[i + 1]));
      }
      const perMinute = minutes.map((m, i) => ({ minute: new Date(m * 60_000).toISOString(), pageviews: Number(counts[i]) || 0 }));
      return {
        activeVisitors: visitors,
        activeSessions: sessions,
        pageviewsLastMinute: perMinute.at(-2).pageviews,
        perMinute,
        activePages: [...pageTotals].map(([path, views]) => ({ path, views }))
          .sort((a, b) => b.views - a.views).slice(0, 8),
      };
    },

    timeseries: async (_, { range }, ctx) => {
      const { tenantId } = requireRole(ctx);
      const { ms, bucket } = RANGES[range];
      const { rows } = await query(
        `SELECT b.t, coalesce(x.pageviews, 0)::int AS pageviews, coalesce(x.visitors, 0)::int AS visitors
         FROM generate_series(date_trunc($3, $2::timestamptz), date_trunc($3, now()), ('1 ' || $3)::interval) AS b(t)
         LEFT JOIN (
           SELECT date_trunc($3, ts) AS t,
                  count(*) FILTER (WHERE type = 'pageview') AS pageviews,
                  count(DISTINCT visitor_id) AS visitors
           FROM events WHERE tenant_id = $1 AND ts >= $2 GROUP BY 1
         ) x ON x.t = b.t
         ORDER BY b.t`,
        [tenantId, new Date(Date.now() - ms), bucket],
      );
      return rows.map((r) => ({ t: r.t.toISOString(), pageviews: r.pageviews, visitors: r.visitors }));
    },

    topPages: async (_, { range, limit }, ctx) => {
      const { tenantId } = requireRole(ctx);
      const { rows } = await query(
        `SELECT path, count(*)::int AS views, count(DISTINCT visitor_id)::int AS visitors
         FROM events WHERE tenant_id = $1 AND ts >= $2 AND type = 'pageview'
         GROUP BY path ORDER BY views DESC LIMIT $3`,
        [tenantId, new Date(Date.now() - RANGES[range].ms), clampLimit(limit)],
      );
      return rows;
    },

    topReferrers: async (_, { range, limit }, ctx) => {
      const { tenantId } = requireRole(ctx);
      const { rows } = await query(
        `SELECT source, count(*)::int AS sessions FROM (
           SELECT DISTINCT ON (session_id)
                  coalesce(substring(referrer FROM '^https?://(?:www\\.)?([^/:]+)'), '(direct)') AS source
           FROM events WHERE tenant_id = $1 AND ts >= $2 AND type = 'pageview'
           ORDER BY session_id, ts
         ) first_hits GROUP BY source ORDER BY sessions DESC LIMIT $3`,
        [tenantId, new Date(Date.now() - RANGES[range].ms), clampLimit(limit)],
      );
      return rows;
    },

    // Page-to-page transitions: consecutive VIEWED edges within a session.
    journey: async (_, { range, limit }, ctx) => {
      const { tenantId } = requireRole(ctx);
      const links = await read(
        `MATCH (s:Session {tenantId: $tenantId})-[a:VIEWED]->(p1:Page)
         WHERE a.ts >= $since
         MATCH (s)-[b:VIEWED]->(p2:Page)
         WHERE b.seq = a.seq + 1 AND p1 <> p2
         RETURN p1.path AS source, p2.path AS target, count(*) AS weight
         ORDER BY weight DESC LIMIT $limit`,
        { tenantId, since: int(Date.now() - RANGES[range].ms), limit: int(clampLimit(limit)) },
      );
      const views = new Map();
      for (const l of links) {
        views.set(l.source, (views.get(l.source) || 0) + l.weight);
        views.set(l.target, (views.get(l.target) || 0) + l.weight);
      }
      return { nodes: [...views].map(([id, v]) => ({ id, views: v })), links };
    },

    dropOffs: async (_, { range, limit }, ctx) => {
      const { tenantId } = requireRole(ctx);
      return read(
        `MATCH (s:Session {tenantId: $tenantId})-[v:VIEWED]->(p:Page)
         WHERE v.ts >= $since
         WITH p, count(*) AS views, sum(CASE WHEN v.seq = s.pageCount THEN 1 ELSE 0 END) AS exits
         WHERE views >= 5
         RETURN p.path AS path, views, exits, toFloat(exits) / views AS exitRate
         ORDER BY exitRate DESC, views DESC LIMIT $limit`,
        { tenantId, since: int(Date.now() - RANGES[range].ms), limit: int(clampLimit(limit)) },
      );
    },

    funnel: async (_, { range, steps }, ctx) => {
      const { tenantId } = requireRole(ctx);
      let built;
      try {
        built = buildFunnelQuery(steps);
      } catch (err) {
        throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      const [row] = await read(built.cypher, {
        ...built.params, tenantId, since: int(Date.now() - RANGES[range].ms),
      });
      const counts = steps.map((_, i) => row?.[`c${i}`] ?? 0);
      return funnelRows(steps, counts);
    },

    catalog: async (_, __, ctx) => {
      const { tenantId } = requireRole(ctx);
      const [pages, goals] = await Promise.all([
        read('MATCH (p:Page {tenantId: $tenantId}) RETURN p.path AS v ORDER BY v LIMIT 500', { tenantId }),
        read('MATCH (g:Goal {tenantId: $tenantId}) RETURN g.name AS v ORDER BY v LIMIT 100', { tenantId }),
      ]);
      return { pages: pages.map((r) => r.v), goals: goals.map((r) => r.v) };
    },

    alertRules: async (_, __, ctx) => {
      const { tenantId } = requireRole(ctx);
      const { rows } = await query('SELECT * FROM alert_rules WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
      return rows;
    },

    alerts: async (_, { limit }, ctx) => {
      const { tenantId } = requireRole(ctx);
      const { rows } = await query(
        'SELECT * FROM alerts WHERE tenant_id = $1 ORDER BY triggered_at DESC LIMIT $2',
        [tenantId, clampLimit(limit, 500)],
      );
      return rows;
    },

    dashboard: async (_, __, ctx) => {
      const user = requireRole(ctx);
      const { rows } = await query('SELECT widgets FROM dashboards WHERE user_id = $1', [user.id]);
      return rows[0]?.widgets ?? DEFAULT_WIDGETS;
    },
  },

  Mutation: {
    createAlertRule: async (_, { input }, ctx) => {
      const { tenantId } = requireRole(ctx, 'admin');
      if (['slack', 'webhook'].includes(input.channel) && !/^https:\/\//.test(input.target || '')) {
        throw new GraphQLError('Slack and webhook channels need an https:// target URL', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      if (input.channel === 'email' && !/^[^@\s]+@[^@\s]+$/.test(input.target || '')) {
        throw new GraphQLError('Email channel needs a valid address', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      const { rows: [rule] } = await query(
        `INSERT INTO alert_rules (tenant_id, name, condition, threshold, channel, target, cooldown_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [tenantId, input.name, input.condition, input.threshold, input.channel, input.target || null,
          Math.max(1, input.cooldownMinutes)],
      );
      return rule;
    },

    setAlertRuleEnabled: async (_, { id, enabled }, ctx) => {
      const { tenantId } = requireRole(ctx, 'admin');
      const { rows: [rule] } = await query(
        'UPDATE alert_rules SET enabled = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *',
        [id, tenantId, enabled],
      );
      if (!rule) throw new GraphQLError('Alert rule not found', { extensions: { code: 'NOT_FOUND' } });
      return rule;
    },

    deleteAlertRule: async (_, { id }, ctx) => {
      const { tenantId } = requireRole(ctx, 'admin');
      const { rowCount } = await query('DELETE FROM alert_rules WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
      return rowCount > 0;
    },

    saveDashboard: async (_, { widgets }, ctx) => {
      const user = requireRole(ctx, 'analyst');
      const clean = [...new Set(widgets)].filter((w) => DEFAULT_WIDGETS.includes(w));
      await query(
        `INSERT INTO dashboards (user_id, widgets) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET widgets = EXCLUDED.widgets, updated_at = now()`,
        [user.id, JSON.stringify(clean)],
      );
      return clean;
    },
  },

  AlertRule: {
    cooldownMinutes: (r) => r.cooldown_minutes,
  },
  Alert: {
    ruleName: (a) => a.rule_name,
    triggeredAt: (a) => a.triggered_at.toISOString(),
  },
};
