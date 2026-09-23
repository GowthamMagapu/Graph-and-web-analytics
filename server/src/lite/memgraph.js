// In-memory stand-in for Neo4j in lite mode. Keeps the same graph model:
//   Visitor -STARTED-> Session -VIEWED{ts}-> Page,  Session -CONVERTED{ts}-> Goal
// and answers the same traversal questions as the Cypher queries in schema.js.
import { parseStep } from '../lib/funnel.js';

const REFERRER_HOST = /^https?:\/\/(?:www\.)?([^/:]+)/;

export class MemGraph {
  constructor() {
    this.tenants = new Map(); // tenantId -> { sessions: Map, pages: Set, goals: Set }
  }

  #tenant(id) {
    let t = this.tenants.get(id);
    if (!t) {
      t = { sessions: new Map(), pages: new Set(), goals: new Set() };
      this.tenants.set(id, t);
    }
    return t;
  }

  #sessions(tenantId) {
    return this.tenants.get(tenantId)?.sessions.values() ?? [];
  }

  add(e) {
    const t = this.#tenant(e.tenantId);
    let s = t.sessions.get(e.sessionId);
    if (!s) {
      s = { visitorId: e.visitorId, referrer: null, views: [], conversions: [] };
      t.sessions.set(e.sessionId, s);
    }
    if (e.type === 'pageview') {
      t.pages.add(e.path);
      if (!s.views.length) s.referrer = e.referrer;
      const last = s.views.at(-1);
      s.views.push({ path: e.path, ts: e.ts });
      if (last && last.ts > e.ts) s.views.sort((a, b) => a.ts - b.ts); // late arrival
    } else if (e.type === 'conversion') {
      t.goals.add(e.name);
      s.conversions.push({ name: e.name, ts: e.ts });
    }
  }

  /** Page-to-page transitions (consecutive views in a session) since `since`. */
  journey(tenantId, since, limit) {
    const counts = new Map();
    for (const s of this.#sessions(tenantId)) {
      for (let i = 0; i < s.views.length - 1; i++) {
        const a = s.views[i];
        const b = s.views[i + 1];
        if (a.ts < since || a.path === b.path) continue;
        const key = `${a.path}\n${b.path}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const links = [...counts]
      .map(([key, weight]) => {
        const [source, target] = key.split('\n');
        return { source, target, weight };
      })
      .sort((x, y) => y.weight - x.weight)
      .slice(0, limit);
    const views = new Map();
    for (const l of links) {
      views.set(l.source, (views.get(l.source) || 0) + l.weight);
      views.set(l.target, (views.get(l.target) || 0) + l.weight);
    }
    return { nodes: [...views].map(([id, v]) => ({ id, views: v })), links };
  }

  /** Pages where sessions end most often. */
  dropOffs(tenantId, since, limit) {
    const stats = new Map();
    for (const s of this.#sessions(tenantId)) {
      s.views.forEach((v, i) => {
        if (v.ts < since) return;
        const st = stats.get(v.path) || { path: v.path, views: 0, exits: 0 };
        st.views += 1;
        if (i === s.views.length - 1) st.exits += 1;
        stats.set(v.path, st);
      });
    }
    return [...stats.values()]
      .filter((st) => st.views >= 5)
      .map((st) => ({ ...st, exitRate: st.exits / st.views }))
      .sort((a, b) => b.exitRate - a.exitRate || b.views - a.views)
      .slice(0, limit);
  }

  /** Sessions reaching each step in order (same semantics as buildFunnelQuery). */
  funnel(tenantId, since, steps) {
    const parsed = steps.map(parseStep);
    const counts = steps.map(() => 0);
    for (const s of this.#sessions(tenantId)) {
      let prev = null;
      for (let i = 0; i < parsed.length; i++) {
        const { kind, value } = parsed[i];
        const hits = kind === 'goal'
          ? s.conversions.filter((c) => c.name === value)
          : s.views.filter((v) => v.path === value);
        let best = null;
        for (const h of hits) {
          const ok = i === 0 ? h.ts >= since : h.ts > prev;
          if (ok && (best === null || h.ts < best)) best = h.ts;
        }
        if (best === null) break;
        counts[i] += 1;
        prev = best;
      }
    }
    return counts;
  }

  /** Sessions active in the window, grouped by the site that referred them. */
  referrers(tenantId, since, limit) {
    const counts = new Map();
    for (const s of this.#sessions(tenantId)) {
      if (!s.views.some((v) => v.ts >= since)) continue;
      const source = s.referrer?.match(REFERRER_HOST)?.[1] ?? '(direct)';
      counts.set(source, (counts.get(source) || 0) + 1);
    }
    return [...counts]
      .map(([source, sessions]) => ({ source, sessions }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, limit);
  }

  catalog(tenantId) {
    const t = this.tenants.get(tenantId);
    return {
      pages: [...(t?.pages ?? [])].sort(),
      goals: [...(t?.goals ?? [])].sort(),
    };
  }
}
