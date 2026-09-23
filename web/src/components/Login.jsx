import { useState } from 'react';
import { login } from '../api.js';

const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);

export default function Login({ onLogin }) {
  // Pre-fill the demo login only when running locally.
  const [email, setEmail] = useState(isLocal ? 'admin@demo.local' : '');
  const [password, setPassword] = useState(isLocal ? 'graphpulse' : '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(email, password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>GraphPulse</h1>
        <p className="muted">Graph-powered web &amp; product analytics</p>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {isLocal && <p className="muted small">Demo users: admin@, analyst@, viewer@demo.local, password <code>graphpulse</code></p>}
      </form>
    </div>
  );
}
