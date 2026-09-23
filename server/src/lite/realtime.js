// In-memory stand-in for the Redis real-time counters in lite mode.
import { minuteOf, REALTIME_WINDOW_MS } from '../lib/keys.js';

const MAX_AGE_MS = 2 * 3600_000; // backfilled history doesn't touch live counters

export class Realtime {
  constructor() {
    this.tenants = new Map();
  }

  #tenant(id) {
    let t = this.tenants.get(id);
    if (!t) {
      t = { visitors: new Map(), sessions: new Map(), pv: new Map(), pages: new Map() };
      this.tenants.set(id, t);
    }
    return t;
  }

  add(e, now = Date.now()) {
    if (now - e.ts > MAX_AGE_MS) return;
    const t = this.#tenant(e.tenantId);
    if ((t.visitors.get(e.visitorId) || 0) < e.ts) t.visitors.set(e.visitorId, e.ts);
    if ((t.sessions.get(e.sessionId) || 0) < e.ts) t.sessions.set(e.sessionId, e.ts);
    if (e.type !== 'pageview') return;
    const m = minuteOf(e.ts);
    t.pv.set(m, (t.pv.get(m) || 0) + 1);
    const pages = t.pages.get(m) || new Map();
    pages.set(e.path, (pages.get(e.path) || 0) + 1);
    t.pages.set(m, pages);
  }

  /** Page views for `count` consecutive minutes ending at `lastMinute`. */
  series(tenantId, lastMinute, count) {
    const t = this.tenants.get(tenantId);
    return Array.from({ length: count }, (_, i) => t?.pv.get(lastMinute - count + 1 + i) || 0);
  }

  snapshot(tenantId, now = Date.now()) {
    const t = this.tenants.get(tenantId);
    const since = now - REALTIME_WINDOW_MS;
    const active = (map) => (map ? [...map.values()].filter((ts) => ts >= since).length : 0);
    const current = minuteOf(now);
    const counts = this.series(tenantId, current, 30);
    const perMinute = counts.map((pageviews, i) => ({
      minute: new Date((current - 29 + i) * 60_000).toISOString(),
      pageviews,
    }));
    const pageTotals = new Map();
    for (let m = current - 4; m <= current; m++) {
      for (const [path, n] of t?.pages.get(m) ?? []) pageTotals.set(path, (pageTotals.get(path) || 0) + n);
    }
    return {
      activeVisitors: active(t?.visitors),
      activeSessions: active(t?.sessions),
      pageviewsLastMinute: perMinute.at(-2).pageviews,
      perMinute,
      activePages: [...pageTotals].map(([path, views]) => ({ path, views }))
        .sort((a, b) => b.views - a.views).slice(0, 8),
    };
  }

  prune(now = Date.now()) {
    const oldestMinute = minuteOf(now - 3 * 3600_000);
    const cutoff = now - 12 * REALTIME_WINDOW_MS;
    for (const t of this.tenants.values()) {
      for (const m of t.pv.keys()) if (m < oldestMinute) t.pv.delete(m);
      for (const m of t.pages.keys()) if (m < oldestMinute) t.pages.delete(m);
      for (const map of [t.visitors, t.sessions]) {
        for (const [k, ts] of map) if (ts < cutoff) map.delete(k);
      }
    }
  }
}
