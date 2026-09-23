import { useEffect, useState } from 'react';
import { loadSession, saveSession } from './api.js';
import Login from './components/Login.jsx';
import Dashboard from './components/Dashboard.jsx';
import AlertsPage from './components/AlertsPage.jsx';
import InstallPage from './components/InstallPage.jsx';

const RANGES = [
  ['LAST_HOUR', 'Last hour'],
  ['LAST_24H', 'Last 24 hours'],
  ['LAST_7D', 'Last 7 days'],
  ['LAST_30D', 'Last 30 days'],
];
const TABS = [['dashboard', 'Dashboard'], ['alerts', 'Alerts'], ['install', 'Install']];

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [tab, setTab] = useState('dashboard');
  const [range, setRange] = useState('LAST_7D');

  useEffect(() => {
    const logout = () => {
      saveSession(null);
      setSession(null);
    };
    window.addEventListener('graphpulse:logout', logout);
    return () => window.removeEventListener('graphpulse:logout', logout);
  }, []);

  if (!session) {
    return <Login onLogin={(s) => { saveSession(s); setSession(s); }} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <circle cx="8" cy="22" r="5" /><circle cx="24" cy="10" r="5" /><path d="M8 22 24 10" />
          </svg>
          GraphPulse
          <span className="tenant">{session.tenant?.name}</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        <div className="topbar-right">
          {tab === 'dashboard' && (
            <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Date range">
              {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          )}
          <span className="who">{session.user.email} · {session.user.role}</span>
          <button className="ghost" onClick={() => window.dispatchEvent(new Event('graphpulse:logout'))}>Log out</button>
        </div>
      </header>
      <main>
        {tab === 'dashboard' && <Dashboard range={range} role={session.user.role} />}
        {tab === 'alerts' && <AlertsPage role={session.user.role} />}
        {tab === 'install' && <InstallPage apiKey={session.tenant?.apiKey} />}
      </main>
    </div>
  );
}
