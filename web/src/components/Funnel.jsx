import { useState } from 'react';
import { useQuery } from '../api.js';
import { num, pct } from '../format.js';
import { Status } from './Widgets.jsx';

const DEFAULT_STEPS = ['/pricing', '/signup', 'goal:signup'];
const QUERY = `query ($range: Range!, $steps: [String!]!) {
  funnel(range: $range, steps: $steps) { step sessions conversionRate dropOffRate } }`;

export default function Funnel({ range }) {
  const [steps, setSteps] = useState(DEFAULT_STEPS);
  const [draft, setDraft] = useState('');
  const catalog = useQuery('{ catalog { pages goals } }');
  const q = useQuery(QUERY, { range, steps }, { pollMs: 60_000, skip: steps.length < 2 });

  const options = [
    ...(catalog.data?.catalog.pages ?? []),
    ...(catalog.data?.catalog.goals ?? []).map((g) => `goal:${g}`),
  ];

  const add = (e) => {
    e.preventDefault();
    const value = draft.trim();
    if (value && steps.length < 8) setSteps([...steps, value]);
    setDraft('');
  };

  return (
    <div className="funnel">
      <div className="steps">
        {steps.map((s, i) => (
          <span key={`${s}-${i}`} className="chip">
            {i + 1}. {s}
            <button aria-label={`Remove step ${s}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>×</button>
          </span>
        ))}
        <form onSubmit={add} className="add-step">
          <input
            list="funnel-options"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add page or goal:name"
            aria-label="Add funnel step"
          />
          <datalist id="funnel-options">{options.map((o) => <option key={o} value={o} />)}</datalist>
          <button className="ghost" disabled={!draft.trim() || steps.length >= 8}>Add</button>
        </form>
      </div>
      {steps.length < 2 ? (
        <p className="muted">Add at least two steps.</p>
      ) : (
        <Status q={q} empty={!q.data?.funnel[0]?.sessions}>
          <ol className="funnel-bars">
            {q.data?.funnel.map((r, i) => (
              <li key={`${r.step}-${i}`}>
                <div className="funnel-label">
                  <code>{r.step}</code>
                  <span><strong>{num(r.sessions)}</strong> sessions · {pct(r.conversionRate)}</span>
                </div>
                <div className="funnel-track">
                  <span className="bar" style={{ width: `${Math.max(r.conversionRate * 100, 0.5)}%` }} />
                </div>
                {i > 0 && <div className="funnel-drop">▼ {pct(r.dropOffRate)} dropped off</div>}
              </li>
            ))}
          </ol>
        </Status>
      )}
    </div>
  );
}
