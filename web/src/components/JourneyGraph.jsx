import { useMemo, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import { useQuery } from '../api.js';
import { num } from '../format.js';
import { useTheme } from '../theme.js';
import { Status } from './Widgets.jsx';

const W = 900;
const H = 440;

const QUERY = `query ($range: Range!) { journey(range: $range, limit: 40) {
  nodes { id views } links { source target weight } } }`;

/** Lay the graph out once per data change (no animation - stable positions). */
function layout(data) {
  const nodes = data.nodes.map((n) => ({ ...n }));
  const links = data.links.map((l) => ({ ...l }));
  const maxViews = Math.max(...nodes.map((n) => n.views), 1);
  nodes.forEach((n) => { n.r = 8 + 18 * Math.sqrt(n.views / maxViews); });
  const sim = forceSimulation(nodes)
    .force('link', forceLink(links).id((d) => d.id).distance(130).strength(0.4))
    .force('charge', forceManyBody().strength(-700))
    .force('center', forceCenter(W / 2, H / 2))
    .force('x', forceX(W / 2).strength(0.05))
    .force('y', forceY(H / 2).strength(0.12))
    .force('collide', forceCollide((d) => d.r + 26))
    .stop();
  for (let i = 0; i < 300; i++) sim.tick();
  nodes.forEach((n) => {
    n.x = Math.max(n.r + 50, Math.min(W - n.r - 50, n.x));
    n.y = Math.max(n.r + 16, Math.min(H - n.r - 22, n.y));
  });
  return { nodes, links, maxWeight: Math.max(...links.map((l) => l.weight), 1) };
}

/** Edge from the source circle's rim to the target circle's rim, slightly curved so A->B and B->A don't overlap. */
function edgePath(s, t) {
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const x1 = s.x + ux * s.r;
  const y1 = s.y + uy * s.r;
  const x2 = t.x - ux * (t.r + 4);
  const y2 = t.y - uy * (t.r + 4);
  const cx = (x1 + x2) / 2 - uy * len * 0.12;
  const cy = (y1 + y2) / 2 + ux * len * 0.12;
  return `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
}

export default function JourneyGraph({ range }) {
  const q = useQuery(QUERY, { range }, { pollMs: 60_000 });
  const t = useTheme();
  const [hover, setHover] = useState(null);
  const graph = useMemo(() => (q.data ? layout(q.data.journey) : null), [q.data]);

  const isLit = (l) => !hover || l.source.id === hover || l.target.id === hover;

  return (
    <Status q={q} empty={!graph?.links.length}>
      {graph && (
        <>
          <p className="muted small">
            Pages are nodes (size = traffic); arrows are page-to-page navigations from the session graph
            (thickness = number of transitions). Hover a page to isolate its paths.
          </p>
          <svg className="journey" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Visitor journey graph">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={t.axis} />
              </marker>
              <marker id="arrow-lit" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={t['series-1']} />
              </marker>
            </defs>
            {graph.links.map((l) => {
              const lit = hover && isLit(l);
              return (
                <path
                  key={`${l.source.id}->${l.target.id}`}
                  d={edgePath(l.source, l.target)}
                  fill="none"
                  stroke={lit ? t['series-1'] : t.axis}
                  strokeOpacity={isLit(l) ? (lit ? 0.9 : 0.45) : 0.08}
                  strokeWidth={1 + 5 * (l.weight / graph.maxWeight)}
                  markerEnd={`url(#${lit ? 'arrow-lit' : 'arrow'})`}
                >
                  <title>{`${l.source.id} → ${l.target.id}: ${num(l.weight)} transitions`}</title>
                </path>
              );
            })}
            {graph.nodes.map((n) => {
              const dim = hover && hover !== n.id && !graph.links.some((l) => isLit(l) && (l.source.id === n.id || l.target.id === n.id));
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  opacity={dim ? 0.25 : 1}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  className="journey-node"
                >
                  <circle r={n.r + 8} fill="transparent" />
                  <circle r={n.r} fill={t['series-1']} stroke={t['surface-1']} strokeWidth={2} />
                  <text y={n.r + 15} textAnchor="middle" className="node-label">{n.id}</text>
                  <title>{`${n.id}: ${num(n.views)} transitions in/out`}</title>
                </g>
              );
            })}
          </svg>
        </>
      )}
    </Status>
  );
}
