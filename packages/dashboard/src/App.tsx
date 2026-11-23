import { useEffect, useState } from 'react';
import { connectLive, getToken, isLive, setToken, useLiveVersion } from './api.ts';
import { LiveWallPage } from './livewall.tsx';
import { BuildsPage, DevicesPage, OverviewPage, RunDetailPage, RunsPage, SuitesPage, WorkersPage } from './pages.tsx';

type Route = { page: string; id?: string };

const NAV: { page: string; label: string; phase?: number }[] = [
  { page: 'overview', label: 'Overview' },
  { page: 'live', label: 'Live Wall' },
  { page: 'devices', label: 'Devices' },
  { page: 'workers', label: 'Workers' },
  { page: 'builds', label: 'Builds' },
  { page: 'suites', label: 'Test Suites' },
  { page: 'runs', label: 'Test Runs' },
  { page: 'agents', label: 'AI Agents', phase: 3 },
  { page: 'visual', label: 'Visual Regression', phase: 5 },
  { page: 'issues', label: 'Issues', phase: 5 },
  { page: 'repairs', label: 'Repair History', phase: 6 },
  { page: 'settings', label: 'Settings' },
];

function parseHash(): Route {
  const [page = 'overview', id] = location.hash.replace(/^#\/?/, '').split('/');
  return { page: page || 'overview', id };
}

export function navigate(page: string, id?: string) {
  location.hash = `/${page}${id ? `/${id}` : ''}`;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  useLiveVersion();
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  if (!getToken() || route.page === 'settings') return <Settings />;

  const planned = NAV.find((n) => n.page === route.page && n.phase);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Mobile Testing Lab
          <span className={`live ${isLive() ? 'on' : ''}`} title={isLive() ? 'live updates connected' : 'live updates disconnected'} />
        </div>
        <nav>
          {NAV.map((n) => (
            <a key={n.page} href={`#/${n.page}`} className={route.page === n.page ? 'active' : ''}>
              {n.label}
              {n.phase && <span className="phase">P{n.phase}</span>}
            </a>
          ))}
        </nav>
      </aside>
      <main>
        {route.page === 'overview' && <OverviewPage />}
        {route.page === 'live' && <LiveWallPage />}
        {route.page === 'devices' && <DevicesPage />}
        {route.page === 'workers' && <WorkersPage />}
        {route.page === 'builds' && <BuildsPage />}
        {route.page === 'suites' && <SuitesPage />}
        {route.page === 'runs' && (route.id ? <RunDetailPage id={route.id} /> : <RunsPage />)}
        {planned && (
          <section>
            <h1>{planned.label}</h1>
            <p className="muted">Planned for Phase {planned.phase}. See ROADMAP.md for scope and the integration seams it plugs into.</p>
          </section>
        )}
      </main>
    </div>
  );
}

function Settings() {
  const [value, setValue] = useState(getToken());
  return (
    <div className="center">
      <form
        className="card narrow"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value.trim());
          connectLive();
          navigate('overview');
        }}
      >
        <h1>Settings</h1>
        <label>
          Dashboard token
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="LAB_DASHBOARD_TOKEN from .env" autoFocus />
        </label>
        <p className="muted small">Stored in this browser only. The server never puts it in a URL.</p>
        <button className="primary" disabled={!value.trim()}>
          Save
        </button>
      </form>
    </div>
  );
}
