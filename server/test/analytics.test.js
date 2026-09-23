import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAnomaly, evaluateRule } from '../src/lib/anomaly.js';
import { buildFunnelQuery, funnelRows } from '../src/lib/funnel.js';

const flat = Array(30).fill(100);

test('detectAnomaly flags spikes and drops but not normal noise', () => {
  assert.equal(detectAnomaly(flat, 105).isAnomaly, false);
  const spike = detectAnomaly(flat, 200);
  assert.equal(spike.isAnomaly, true);
  assert.equal(spike.direction, 'spike');
  assert.equal(detectAnomaly(flat, 10).direction, 'drop');
});

test('detectAnomaly needs enough baseline', () => {
  assert.equal(detectAnomaly([1, 2, 3], 500).isAnomaly, false);
});

test('evaluateRule handles threshold and anomaly rules', () => {
  assert.match(evaluateRule({ condition: 'above', threshold: 50, metric: 'pv' }, 60, flat), /above/);
  assert.equal(evaluateRule({ condition: 'above', threshold: 50, metric: 'pv' }, 40, flat), null);
  assert.match(evaluateRule({ condition: 'below', threshold: 1, metric: 'pv' }, 0, flat), /below/);
  assert.match(evaluateRule({ condition: 'anomaly', threshold: 3, metric: 'pv' }, 400, flat), /spike/);
});

test('buildFunnelQuery chains ordered steps and supports goals', () => {
  const { cypher, params } = buildFunnelQuery(['/pricing', '/signup', 'goal:signup']);
  assert.deepEqual(params, { s0: '/pricing', s1: '/signup', s2: 'signup' });
  assert.match(cypher, /MATCH \(s:Session \{tenantId: \$tenantId\}\)-\[r0:VIEWED\]/);
  assert.match(cypher, /OPTIONAL MATCH \(s\)-\[r1:VIEWED\].*WHERE r1\.ts > q0/);
  assert.match(cypher, /\[r2:CONVERTED\]->\(:Goal/);
  assert.match(cypher, /RETURN count\(q0\) AS c0, count\(q1\) AS c1, count\(q2\) AS c2/);
  assert.throws(() => buildFunnelQuery(['/only-one']), /2-8 steps/);
});

test('funnelRows computes conversion and drop-off rates', () => {
  const rows = funnelRows(['a', 'b', 'c'], [200, 100, 25]);
  assert.deepEqual(rows.map((r) => r.conversionRate), [1, 0.5, 0.125]);
  assert.deepEqual(rows.map((r) => r.dropOffRate), [0, 0.5, 0.75]);
});
