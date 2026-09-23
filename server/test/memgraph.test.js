import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemGraph } from '../src/lite/memgraph.js';

const T = 't1';
const view = (sessionId, path, ts, referrer = null) => ({ tenantId: T, type: 'pageview', visitorId: `v-${sessionId}`, sessionId, path, ts, referrer });
const goal = (sessionId, name, ts) => ({ tenantId: T, type: 'conversion', visitorId: `v-${sessionId}`, sessionId, name, ts });

function sample() {
  const g = new MemGraph();
  [
    view('a', '/', 1, 'https://www.google.com/q'), view('a', '/pricing', 2), view('a', '/signup', 3), goal('a', 'signup', 4),
    view('b', '/', 1), view('b', '/pricing', 2),
    view('c', '/signup', 1), view('c', '/pricing', 2), // signup before pricing: not in order
    view('d', '/pricing', 5), view('d', '/pricing', 6), // refresh is not a transition
  ].forEach((e) => g.add(e));
  return g;
}

test('funnel counts ordered steps per session, including goals', () => {
  assert.deepEqual(sample().funnel(T, 0, ['/pricing', '/signup', 'goal:signup']), [4, 1, 1]);
  assert.deepEqual(sample().funnel(T, 0, ['/', '/pricing']), [2, 2]);
});

test('journey counts consecutive transitions and skips self-loops', () => {
  const { links, nodes } = sample().journey(T, 0, 10);
  const w = Object.fromEntries(links.map((l) => [`${l.source}>${l.target}`, l.weight]));
  assert.deepEqual(w, { '/>/pricing': 2, '/pricing>/signup': 1, '/signup>/pricing': 1 });
  assert.equal(nodes.find((n) => n.id === '/pricing').views, 4);
});

test('late events are re-sorted into session order', () => {
  const g = new MemGraph();
  [view('x', '/b', 20), view('x', '/a', 10)].forEach((e) => g.add(e));
  assert.deepEqual(g.journey(T, 0, 10).links, [{ source: '/a', target: '/b', weight: 1 }]);
});

test('referrers group sessions by referring host', () => {
  assert.deepEqual(sample().referrers(T, 0, 5), [{ source: '(direct)', sessions: 3 }, { source: 'google.com', sessions: 1 }]);
});

test('tenants are isolated', () => {
  assert.deepEqual(sample().funnel('other', 0, ['/', '/pricing']), [0, 0]);
  assert.deepEqual(sample().catalog('other'), { pages: [], goals: [] });
});
