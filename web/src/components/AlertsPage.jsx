import { useState } from 'react';
import { gql, useQuery } from '../api.js';

const RULES = '{ alertRules { id name condition threshold channel target cooldownMinutes enabled } }';
const HISTORY = '{ alerts(limit: 50) { id ruleName message value triggeredAt } }';
const EMPTY = { name: '', condition: 'anomaly', threshold: 3, channel: 'log', target: '', cooldownMinutes: 15 };

const describe = (r) => (r.condition === 'anomaly'
  ? `page views/min deviates from its 30-min baseline by z ≥ ${r.threshold}`
  : `page views/min ${r.condition} ${r.threshold}`);

export default function AlertsPage({ role }) {
  const rules = useQuery(RULES);
  const history = useQuery(HISTORY, {}, { pollMs: 15_000 });
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const isAdmin = role === 'admin';

  const mutate = async (query, variables) => {
    setError(null);
    try {
      await gql(query, variables);
      rules.refetch();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  const create = async (e) => {
    e.preventDefault();
    const input = { ...form, threshold: Number(form.threshold), cooldownMinutes: Number(form.cooldownMinutes), target: form.target || null };
    if (await mutate('mutation ($input: AlertRuleInput!) { createAlertRule(input: $input) { id } }', { input })) setForm(EMPTY);
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="stack">
      <section className="card">
        <h2>Alert rules</h2>
        {error && <p className="error" role="alert">{error}</p>}
        {rules.data?.alertRules.length === 0 && <p className="muted">No rules yet.</p>}
        <ul className="rules">
          {rules.data?.alertRules.map((r) => (
            <li key={r.id} className={r.enabled ? '' : 'disabled'}>
              <div>
                <strong>{r.name}</strong>
                <div className="muted small">
                  {describe(r)} · via {r.channel}{r.target ? ` (${r.target})` : ''} · cooldown {r.cooldownMinutes} min
                </div>
              </div>
              {isAdmin && (
                <div className="rule-actions">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={() => mutate('mutation ($id: ID!, $e: Boolean!) { setAlertRuleEnabled(id: $id, enabled: $e) { id } }', { id: r.id, e: !r.enabled })}
                    /> Enabled
                  </label>
                  <button className="ghost danger" onClick={() => mutate('mutation ($id: ID!) { deleteAlertRule(id: $id) }', { id: r.id })}>Delete</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {isAdmin ? (
          <form className="rule-form" onSubmit={create}>
            <h3>New rule</h3>
            <label>Name<input value={form.name} onChange={set('name')} required placeholder="Pricing traffic spike" /></label>
            <label>Condition
              <select value={form.condition} onChange={set('condition')}>
                <option value="anomaly">Anomaly (z-score)</option>
                <option value="above">Page views/min above</option>
                <option value="below">Page views/min below</option>
              </select>
            </label>
            <label>{form.condition === 'anomaly' ? 'z-score' : 'Threshold'}
              <input type="number" step="any" min="0" value={form.threshold} onChange={set('threshold')} required />
            </label>
            <label>Channel
              <select value={form.channel} onChange={set('channel')}>
                <option value="log">Server log</option>
                <option value="slack">Slack webhook</option>
                <option value="email">Email</option>
                <option value="webhook">Webhook (Zapier etc.)</option>
              </select>
            </label>
            {form.channel !== 'log' && (
              <label>{form.channel === 'email' ? 'Email address' : 'Webhook URL'}
                <input value={form.target} onChange={set('target')} required placeholder={form.channel === 'email' ? 'team@company.com' : 'https://hooks.slack.com/…'} />
              </label>
            )}
            <label>Cooldown (min)<input type="number" min="1" value={form.cooldownMinutes} onChange={set('cooldownMinutes')} /></label>
            <button className="primary">Create rule</button>
          </form>
        ) : (
          <p className="muted small">Only admins can manage alert rules.</p>
        )}
      </section>
      <section className="card">
        <h2>Recent alerts</h2>
        {history.data?.alerts.length === 0 && <p className="muted">Nothing has fired yet. Try the simulator with <code>--spike-after</code>.</p>}
        <ul className="alert-list">
          {history.data?.alerts.map((a) => (
            <li key={a.id}>
              <span className="badge" aria-label="Alert">⚠ Alert</span>
              <div>
                <strong>{a.ruleName}</strong> <span className="muted small">{new Date(a.triggeredAt).toLocaleString()}</span>
                <div>{a.message}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
