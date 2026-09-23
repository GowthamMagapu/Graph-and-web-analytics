import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useQuery } from '../api.js';
import { dec, num, pct, timeLabel } from '../format.js';
import { useTheme } from '../theme.js';

export function Status({ q, empty, children }) {
  if (q.error) return <p className="error">{q.error.message}</p>;
  if (!q.data) return <p className="muted">Loading…</p>;
  if (empty) return <p className="muted">No data in this range yet. Run the simulator or open the demo site.</p>;
  return children;
}

function Delta({ now, prev, invert = false }) {
  if (!prev) return <span className="delta muted">no prior data</span>;
  const change = (now - prev) / prev;
  const good = invert ? change < 0 : change > 0;
  return (
    <span className={`delta ${Math.abs(change) < 0.005 ? 'muted' : good ? 'up' : 'down'}`}>
      {change >= 0 ? '▲' : '▼'} {pct(Math.abs(change))} <span className="muted">vs prior</span>
    </span>
  );
}

const KPI_QUERY = `query ($range: Range!) { overview(range: $range) {
  current { pageviews visitors sessions bounceRate pagesPerSession conversions conversionRate }
  previous { pageviews visitors sessions bounceRate pagesPerSession conversions conversionRate } } }`;

const KPI_TILES = [
  ['visitors', 'Visitors', num],
  ['sessions', 'Sessions', num],
  ['pageviews', 'Page views', num],
  ['pagesPerSession', 'Pages / session', (v) => dec(v, 1)],
  ['bounceRate', 'Bounce rate', pct, true],
  ['conversionRate', 'Conversion rate', pct],
];

export function Kpis({ range }) {
  const q = useQuery(KPI_QUERY, { range }, { pollMs: 30_000 });
  const o = q.data?.overview;
  return (
    <Status q={q}>
      <div className="kpis">
        {o && KPI_TILES.map(([key, label, fmt, invert]) => (
          <div key={key} className="kpi">
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{fmt(o.current[key])}</div>
            <Delta now={o.current[key]} prev={o.previous[key]} invert={invert} />
          </div>
        ))}
      </div>
    </Status>
  );
}

const RT_QUERY = `{ realtime { activeVisitors activeSessions pageviewsLastMinute
  perMinute { minute pageviews } activePages { path views } } }`;

export function Realtime() {
  const q = useQuery(RT_QUERY, {}, { pollMs: 5000 });
  const t = useTheme();
  const rt = q.data?.realtime;
  return (
    <Status q={q}>
      {rt && (
        <div className="realtime">
          <div className="rt-hero">
            <span className="live-dot" aria-hidden="true" />
            <span className="hero-number">{num(rt.activeVisitors)}</span>
            <span className="muted">visitors in the last 5 min · {num(rt.activeSessions)} sessions · {num(rt.pageviewsLastMinute)} views last minute</span>
          </div>
          <div className="chart-sm" aria-label="Page views per minute, last 30 minutes">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rt.perMinute} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
                <XAxis dataKey="minute" hide />
                <Tooltip
                  cursor={{ fill: t.grid }}
                  labelFormatter={(m) => new Date(m).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  formatter={(v) => [num(v), 'Page views']}
                />
                <Bar dataKey="pageviews" fill={t['series-1']} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="muted small">Page views per minute, last 30 minutes</p>
          {rt.activePages.length > 0 && (
            <ul className="active-pages">
              {rt.activePages.map((p) => <li key={p.path}><code>{p.path}</code><span>{num(p.views)}</span></li>)}
            </ul>
          )}
        </div>
      )}
    </Status>
  );
}

export function Traffic({ range }) {
  const q = useQuery('query ($range: Range!) { timeseries(range: $range) { t pageviews visitors } }', { range }, { pollMs: 60_000 });
  const t = useTheme();
  const data = q.data?.timeseries ?? [];
  return (
    <Status q={q} empty={data.every((d) => !d.pageviews)}>
      <div className="chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={t.grid} vertical={false} />
            <XAxis dataKey="t" tickFormatter={(v) => timeLabel(v, range)} stroke={t.axis} tick={{ fill: t['text-secondary'], fontSize: 12 }} minTickGap={32} />
            <YAxis stroke={t.axis} tick={{ fill: t['text-secondary'], fontSize: 12 }} allowDecimals={false} tickFormatter={num} />
            <Tooltip labelFormatter={(v) => timeLabel(v, range)} formatter={(v, name) => [num(v), name]} />
            <Legend iconType="plainline" />
            <Line name="Page views" dataKey="pageviews" stroke={t['series-1']} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line name="Visitors" dataKey="visitors" stroke={t['series-2']} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Status>
  );
}

function BarTable({ rows, label, value, columns }) {
  const max = Math.max(...rows.map((r) => r[value]), 1);
  return (
    <table className="bar-table">
      <thead>
        <tr><th>{label}</th>{columns.map(([, h]) => <th key={h} className="num">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[Object.keys(r)[0]]}>
            <td>
              <div className="bar-cell">
                <span className="bar" style={{ width: `${(r[value] / max) * 100}%` }} />
                <code>{r[Object.keys(r)[0]]}</code>
              </div>
            </td>
            {columns.map(([key, h, fmt = num]) => <td key={h} className="num">{fmt(r[key])}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TopPages({ range }) {
  const q = useQuery('query ($range: Range!) { topPages(range: $range) { path views visitors } }', { range }, { pollMs: 60_000 });
  const rows = q.data?.topPages ?? [];
  return (
    <Status q={q} empty={!rows.length}>
      <BarTable rows={rows} label="Page" value="views" columns={[['views', 'Views'], ['visitors', 'Visitors']]} />
    </Status>
  );
}

export function Referrers({ range }) {
  const q = useQuery('query ($range: Range!) { topReferrers(range: $range) { source sessions } }', { range }, { pollMs: 60_000 });
  const rows = q.data?.topReferrers ?? [];
  return (
    <Status q={q} empty={!rows.length}>
      <BarTable rows={rows} label="Source" value="sessions" columns={[['sessions', 'Sessions']]} />
    </Status>
  );
}

export function DropOffs({ range }) {
  const q = useQuery('query ($range: Range!) { dropOffs(range: $range) { path views exits exitRate } }', { range }, { pollMs: 60_000 });
  const rows = q.data?.dropOffs ?? [];
  return (
    <Status q={q} empty={!rows.length}>
      <p className="muted small">Pages where sessions most often end (from the session graph).</p>
      <BarTable
        rows={rows}
        label="Page"
        value="exitRate"
        columns={[['exitRate', 'Exit rate', (v) => pct(v, 0)], ['exits', 'Exits'], ['views', 'Views']]}
      />
    </Status>
  );
}
