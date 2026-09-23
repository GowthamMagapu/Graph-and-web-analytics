// Processes a batch of normalised events into the dual-store layer:
//   Postgres  - the raw event log (aggregates, time series, audit)
//   Neo4j     - the Visitor/Session/Page/Goal graph (journeys, funnels)
//   Redis     - real-time counters and per-session navigation state
//
// Delivery is at-least-once, so every write is idempotent on eventId:
// Postgres uses ON CONFLICT DO NOTHING, Neo4j MERGEs VIEWED edges by eventId,
// and real-time counters only count rows Postgres reports as newly inserted.
import { query } from './db/postgres.js';
import { int, writeTx } from './db/neo4j.js';
import { redis } from './db/redis.js';
import {
  keys, minuteOf, MINUTE_KEY_TTL_S, SESSION_STATE_TTL_S,
} from './lib/keys.js';

const REALTIME_MAX_AGE_MS = 2 * 3600_000; // backfilled history doesn't touch live counters

const PAGEVIEW_CYPHER = `
UNWIND $rows AS r
MERGE (v:Visitor {tenantId: r.tenantId, id: r.visitorId})
MERGE (s:Session {tenantId: r.tenantId, id: r.sessionId})
  ON CREATE SET s.startedAt = r.ts, s.device = r.device, s.referrer = r.referrer, s.pageCount = 0
MERGE (v)-[:STARTED]->(s)
MERGE (p:Page {tenantId: r.tenantId, path: r.path})
  ON CREATE SET p.title = r.title
MERGE (s)-[vw:VIEWED {eventId: r.eventId}]->(p)
  ON CREATE SET vw.ts = r.ts, vw.seq = r.seq, vw.fresh = true
WITH r, s, p, vw, coalesce(vw.fresh, false) AS fresh
REMOVE vw.fresh
SET s.lastSeen = CASE WHEN coalesce(s.lastSeen, 0) < r.ts THEN r.ts ELSE s.lastSeen END,
    s.pageCount = CASE WHEN s.pageCount < r.seq THEN r.seq ELSE s.pageCount END
WITH r, p, fresh WHERE fresh AND r.prevPath IS NOT NULL AND r.prevPath <> r.path
MATCH (prev:Page {tenantId: r.tenantId, path: r.prevPath})
MERGE (prev)-[n:NAVIGATED_TO]->(p)
  ON CREATE SET n.count = 1
  ON MATCH SET n.count = n.count + 1`;

const SESSION_EDGE_CYPHER = (rel, label) => `
UNWIND $rows AS r
MERGE (v:Visitor {tenantId: r.tenantId, id: r.visitorId})
MERGE (s:Session {tenantId: r.tenantId, id: r.sessionId})
  ON CREATE SET s.startedAt = r.ts, s.device = r.device, s.referrer = r.referrer, s.pageCount = 0
MERGE (v)-[:STARTED]->(s)
MERGE (n:${label} {tenantId: r.tenantId, name: r.name})
MERGE (s)-[e:${rel} {eventId: r.eventId}]->(n)
  ON CREATE SET e.ts = r.ts, e.props = r.propsJson`;

async function insertEvents(events) {
  if (!events.length) return new Set();
  const cols = ['tenant_id', 'event_id', 'type', 'name', 'visitor_id', 'session_id', 'path', 'url', 'referrer', 'title', 'device', 'props', 'ts'];
  const values = [];
  const tuples = events.map((e, i) => {
    values.push(e.tenantId, e.eventId, e.type, e.name, e.visitorId, e.sessionId, e.path, e.url,
      e.referrer, e.title, e.device, JSON.stringify(e.props), new Date(e.ts));
    return `(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(', ')})`;
  });
  const { rows } = await query(
    `INSERT INTO events (${cols.join(', ')}) VALUES ${tuples.join(', ')}
     ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING event_id`,
    values,
  );
  return new Set(rows.map((r) => r.event_id));
}

/** Assign each page view its position in the session and the page it came from. */
async function sequencePageviews(pageviews) {
  const sessionKeys = [...new Set(pageviews.map((e) => keys.session(e.tenantId, e.sessionId)))];
  const state = new Map();
  if (sessionKeys.length) {
    const pipe = redis.pipeline();
    sessionKeys.forEach((k) => pipe.hmget(k, 'seq', 'last'));
    const results = await pipe.exec();
    sessionKeys.forEach((k, i) => {
      const [seq, last] = results[i][1];
      state.set(k, { seq: Number(seq) || 0, last: last || null });
    });
  }
  const rows = pageviews.map((e) => {
    const s = state.get(keys.session(e.tenantId, e.sessionId));
    s.seq += 1;
    const row = { ...e, seq: s.seq, prevPath: s.last };
    s.last = e.path;
    return row;
  });
  return { rows, state };
}

export async function processEvents(events) {
  if (!events.length) return;
  const fresh = await insertEvents(events);

  const pageviews = events.filter((e) => e.type === 'pageview');
  const { rows: pvRows, state } = await sequencePageviews(pageviews);

  const toNeo = ({ props, seq, ...e }) => ({
    ...e,
    ts: int(e.ts),
    ...(seq === undefined ? {} : { seq: int(seq) }),
    propsJson: JSON.stringify(props),
  });
  const statements = [];
  if (pvRows.length) statements.push([PAGEVIEW_CYPHER, { rows: pvRows.map(toNeo) }]);
  const custom = events.filter((e) => e.type === 'event');
  if (custom.length) statements.push([SESSION_EDGE_CYPHER('TRIGGERED', 'EventType'), { rows: custom.map(toNeo) }]);
  const conversions = events.filter((e) => e.type === 'conversion');
  if (conversions.length) statements.push([SESSION_EDGE_CYPHER('CONVERTED', 'Goal'), { rows: conversions.map(toNeo) }]);
  await writeTx(statements);

  // Only after the graph write succeeds do we advance session state, so a retried
  // batch re-derives the same sequence numbers.
  const now = Date.now();
  const pipe = redis.pipeline();
  for (const [k, s] of state) {
    pipe.hset(k, 'seq', s.seq, 'last', s.last);
    pipe.expire(k, SESSION_STATE_TTL_S);
  }
  for (const e of events) {
    if (!fresh.has(e.eventId) || now - e.ts > REALTIME_MAX_AGE_MS) continue;
    pipe.zadd(keys.activeVisitors(e.tenantId), 'GT', e.ts, e.visitorId);
    pipe.zadd(keys.activeSessions(e.tenantId), 'GT', e.ts, e.sessionId);
    if (e.type === 'pageview') {
      const m = minuteOf(e.ts);
      pipe.incr(keys.pageviewsMinute(e.tenantId, m));
      pipe.expire(keys.pageviewsMinute(e.tenantId, m), MINUTE_KEY_TTL_S);
      pipe.zincrby(keys.pagesMinute(e.tenantId, m), 1, e.path);
      pipe.expire(keys.pagesMinute(e.tenantId, m), MINUTE_KEY_TTL_S);
    }
  }
  await pipe.exec();
}
