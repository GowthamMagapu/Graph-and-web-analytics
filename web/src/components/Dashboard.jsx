import { useEffect, useState } from 'react';
import { gql, useQuery } from '../api.js';
import { Kpis, Realtime, Traffic, TopPages, Referrers, DropOffs } from './Widgets.jsx';
import JourneyGraph from './JourneyGraph.jsx';
import Funnel from './Funnel.jsx';

const WIDGETS = {
  kpis: { title: 'Key metrics', Component: Kpis, wide: true },
  realtime: { title: 'Real-time', Component: Realtime },
  traffic: { title: 'Traffic', Component: Traffic },
  journey: { title: 'Visitor journeys', Component: JourneyGraph, wide: true },
  funnel: { title: 'Funnel', Component: Funnel },
  dropOffs: { title: 'Drop-off pages', Component: DropOffs },
  topPages: { title: 'Top pages', Component: TopPages },
  referrers: { title: 'Traffic sources', Component: Referrers },
};

export default function Dashboard({ range, role }) {
  const saved = useQuery('{ dashboard }');
  const [order, setOrder] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [customizing, setCustomizing] = useState(false);
  const canEdit = role !== 'viewer';

  useEffect(() => {
    if (saved.data) setOrder(saved.data.dashboard);
  }, [saved.data]);

  const persist = (next) => {
    setOrder(next);
    if (canEdit) gql('mutation ($w: [String!]!) { saveDashboard(widgets: $w) }', { w: next }).catch(console.error);
  };

  const onDrop = (target) => {
    if (!dragging || dragging === target) return;
    const next = order.filter((w) => w !== dragging);
    next.splice(next.indexOf(target), 0, dragging);
    setDragging(null);
    persist(next);
  };

  const toggle = (id) => persist(order.includes(id) ? order.filter((w) => w !== id) : [...order, id]);

  if (!order) return <p className="muted pad">{saved.error ? saved.error.message : 'Loading dashboard…'}</p>;

  return (
    <>
      <div className="dash-toolbar">
        <p className="muted small">
          {canEdit ? 'Drag a widget by its title to rearrange. Layout saves automatically.' : 'Viewer role: layout is read-only.'}
        </p>
        {canEdit && (
          <button className="ghost" onClick={() => setCustomizing((c) => !c)} aria-expanded={customizing}>
            {customizing ? 'Done' : 'Customize'}
          </button>
        )}
      </div>
      {customizing && (
        <div className="card customize">
          {Object.entries(WIDGETS).map(([id, w]) => (
            <label key={id} className="check">
              <input type="checkbox" checked={order.includes(id)} onChange={() => toggle(id)} /> {w.title}
            </label>
          ))}
        </div>
      )}
      <div className="grid">
        {order.filter((id) => WIDGETS[id]).map((id) => {
          const { title, Component, wide } = WIDGETS[id];
          return (
            <section
              key={id}
              className={`card widget ${wide ? 'wide' : ''} ${dragging === id ? 'dragging' : ''}`}
              onDragOver={(e) => canEdit && dragging && e.preventDefault()}
              onDrop={() => onDrop(id)}
            >
              <h2
                draggable={canEdit}
                onDragStart={() => setDragging(id)}
                onDragEnd={() => setDragging(null)}
                className={canEdit ? 'drag-handle' : ''}
              >
                {title}
              </h2>
              <Component range={range} />
            </section>
          );
        })}
      </div>
    </>
  );
}
