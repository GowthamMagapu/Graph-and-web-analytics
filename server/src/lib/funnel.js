/**
 * Funnels run as a single multi-hop Cypher query: for every session, find the
 * earliest hit of step 0, then the earliest hit of step 1 after it, and so on.
 * A step is a page path ("/pricing") or a conversion goal ("goal:signup").
 */
export function parseStep(step) {
  return step.startsWith('goal:')
    ? { kind: 'goal', value: step.slice(5) }
    : { kind: 'page', value: step };
}

function stepPattern(i, kind) {
  return kind === 'goal'
    ? `(s)-[r${i}:CONVERTED]->(:Goal {tenantId: $tenantId, name: $s${i}})`
    : `(s)-[r${i}:VIEWED]->(:Page {tenantId: $tenantId, path: $s${i}})`;
}

export function buildFunnelQuery(steps) {
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 8) {
    throw new Error('A funnel needs 2-8 steps');
  }
  const parsed = steps.map(parseStep);
  const params = Object.fromEntries(parsed.map((p, i) => [`s${i}`, p.value]));
  const lines = [
    `MATCH ${stepPattern(0, parsed[0].kind).replace('(s)', '(s:Session {tenantId: $tenantId})')}`,
    'WHERE r0.ts >= $since',
    'WITH s, min(r0.ts) AS q0',
  ];
  for (let i = 1; i < parsed.length; i++) {
    const carried = Array.from({ length: i }, (_, j) => `q${j}`).join(', ');
    lines.push(
      `OPTIONAL MATCH ${stepPattern(i, parsed[i].kind)} WHERE r${i}.ts > q${i - 1}`,
      `WITH s, ${carried}, min(r${i}.ts) AS q${i}`,
    );
  }
  lines.push(`RETURN ${parsed.map((_, i) => `count(q${i}) AS c${i}`).join(', ')}`);
  return { cypher: lines.join('\n'), params };
}

/** Turn raw step counts into funnel rows with conversion and drop-off rates. */
export function funnelRows(steps, counts) {
  const first = counts[0] || 0;
  return steps.map((step, i) => ({
    step,
    sessions: counts[i],
    conversionRate: first ? counts[i] / first : 0,
    dropOffRate: i === 0 || !counts[i - 1] ? 0 : 1 - counts[i] / counts[i - 1],
  }));
}
