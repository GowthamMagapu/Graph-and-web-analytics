// Traffic simulator: generates realistic visitor journeys and posts them to the
// ingestion API exactly like the browser snippet would.
//
//   node scripts/simulate.js --backfill 7 --sessions 4000   # history for the last 7 days
//   node scripts/simulate.js --live --rate 2                # ~2 new sessions/sec, in real time
//   node scripts/simulate.js --live --rate 2 --spike-after 600   # 10x traffic spike after 10 min
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    endpoint: { type: 'string', default: process.env.INGEST_URL || 'http://localhost:4000/v1/collect' },
    key: { type: 'string', default: process.env.DEMO_API_KEY || 'gp_demo_public_key' },
    backfill: { type: 'string' }, // days
    sessions: { type: 'string', default: '3000' },
    live: { type: 'boolean', default: false },
    rate: { type: 'string', default: '1' }, // sessions per second (live mode)
    'spike-after': { type: 'string' }, // seconds (live mode)
  },
});

const SITE = 'https://demo-saas.example';
const EXIT = null;
// Markov chain of page transitions; remaining probability mass = exit.
const TRANSITIONS = {
  '/': [['/features', 0.28], ['/pricing', 0.22], ['/blog', 0.12], ['/docs', 0.08], ['/signup', 0.06]],
  '/features': [['/pricing', 0.38], ['/docs', 0.12], ['/signup', 0.1], ['/', 0.08]],
  '/pricing': [['/signup', 0.32], ['/features', 0.12], ['/docs', 0.06]],
  '/blog': [['/blog/graph-analytics', 0.35], ['/blog/funnels-lie', 0.2], ['/', 0.15]],
  '/blog/graph-analytics': [['/features', 0.25], ['/pricing', 0.12], ['/blog', 0.1]],
  '/blog/funnels-lie': [['/features', 0.2], ['/blog', 0.12]],
  '/docs': [['/docs/quickstart', 0.45], ['/pricing', 0.1]],
  '/docs/quickstart': [['/signup', 0.22], ['/docs', 0.1]],
  '/signup': [['/onboarding', 0.55]],
  '/onboarding': [['/checkout', 0.35]],
  '/checkout': [],
};
const ENTRY = [['/', 0.45], ['/blog/graph-analytics', 0.15], ['/pricing', 0.12], ['/features', 0.1], ['/docs/quickstart', 0.08], ['/blog', 0.1]];
const REFERRERS = [[null, 0.35], ['https://www.google.com/', 0.3], ['https://news.ycombinator.com/', 0.1],
  ['https://www.linkedin.com/', 0.1], ['https://x.com/', 0.08], ['https://www.producthunt.com/', 0.07]];
const AGENTS = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36', 0.55],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 0.3],
  ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 0.15],
];

function pick(weighted) {
  let r = Math.random();
  for (const [value, p] of weighted) {
    if ((r -= p) < 0) return value;
  }
  return EXIT;
}

const visitorPool = [];
function visitorId() {
  if (visitorPool.length > 50 && Math.random() < 0.3) return visitorPool[Math.floor(Math.random() * visitorPool.length)];
  const id = randomUUID();
  visitorPool.push(id);
  if (visitorPool.length > 5000) visitorPool.shift();
  return id;
}

/** One session as a list of { event, delayMs } relative to its start. */
function buildSession() {
  const visitor = visitorId();
  const session = randomUUID();
  const referrer = pick(REFERRERS);
  const userAgent = pick(AGENTS);
  const steps = [];
  let path = pick(ENTRY);
  let t = 0;
  for (let n = 0; path && n < 12; n++) {
    steps.push({ delayMs: t, event: { type: 'pageview', url: SITE + path, title: path, referrer: n === 0 ? referrer : null } });
    if (path === '/signup' && Math.random() < 0.45) {
      t += 20_000 + Math.random() * 40_000;
      steps.push({ delayMs: t, event: { type: 'conversion', name: 'signup', url: SITE + path, props: { plan: 'growth' } } });
    }
    if (path === '/checkout' && Math.random() < 0.6) {
      t += 30_000 + Math.random() * 60_000;
      steps.push({ delayMs: t, event: { type: 'conversion', name: 'purchase', url: SITE + path, props: { value: 49 } } });
    }
    if (path.startsWith('/blog/') && Math.random() < 0.1) {
      steps.push({ delayMs: t + 15_000, event: { type: 'event', name: 'newsletter_subscribe', url: SITE + path } });
    }
    t += 5_000 + Math.random() * 55_000;
    path = pick(TRANSITIONS[path] || []);
  }
  return { visitor, session, userAgent, steps };
}

let sent = 0;
let failed = 0;
async function post(events, userAgent) {
  try {
    const res = await fetch(opts.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'user-agent': userAgent },
      body: JSON.stringify({ apiKey: opts.key, events }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    sent += events.length;
  } catch (err) {
    failed += events.length;
    if (failed <= events.length) console.error('[simulate] post failed:', err.message);
  }
}

const toEvent = (s, step, ts) => ({ ...step.event, eventId: randomUUID(), visitorId: s.visitor, sessionId: s.session, ts });

async function backfill(days, count) {
  const now = Date.now();
  const span = days * 24 * 3600_000;
  console.log(`[simulate] backfilling ${count} sessions over ${days} day(s)`);
  const byAgent = new Map();
  for (let i = 0; i < count; i++) {
    // Daytime-weighted start times with a gentle upward trend.
    let start;
    do {
      start = now - span * Math.pow(Math.random(), 0.85);
    } while (Math.random() > 0.35 + 0.65 * Math.sin((Math.PI * ((new Date(start).getUTCHours() + 18) % 24)) / 24) ** 2);
    const s = buildSession();
    const list = byAgent.get(s.userAgent) || [];
    for (const step of s.steps) {
      const ts = Math.round(start + step.delayMs);
      if (ts < now) list.push(toEvent(s, step, ts));
    }
    byAgent.set(s.userAgent, list);
  }
  for (const [agent, events] of byAgent) {
    events.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < events.length; i += 100) {
      await post(events.slice(i, i + 100), agent);
    }
  }
  console.log(`[simulate] backfill done: ${sent} events sent, ${failed} failed`);
}

function live(rate, spikeAfter) {
  const started = Date.now();
  console.log(`[simulate] live mode: ~${rate} sessions/sec${spikeAfter ? `, 10x spike after ${spikeAfter}s` : ''} (Ctrl+C to stop)`);
  const TIME_SCALE = 0.25; // compress in-session gaps so journeys finish quickly
  setInterval(() => {
    const elapsed = (Date.now() - started) / 1000;
    const spiking = spikeAfter && elapsed > spikeAfter && elapsed < spikeAfter + 120;
    const expected = rate * (spiking ? 10 : 1);
    let n = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
    while (n-- > 0) {
      const s = buildSession();
      for (const step of s.steps) {
        setTimeout(() => post([toEvent(s, step, Date.now())], s.userAgent), step.delayMs * TIME_SCALE);
      }
    }
  }, 1000);
  setInterval(() => console.log(`[simulate] ${sent} events sent, ${failed} failed`), 10_000);
}

if (opts.backfill) await backfill(Number(opts.backfill), Number(opts.sessions));
if (opts.live) live(Number(opts.rate), opts['spike-after'] ? Number(opts['spike-after']) : null);
if (!opts.backfill && !opts.live) console.log('Pass --backfill <days> and/or --live. See the header of this file.');
