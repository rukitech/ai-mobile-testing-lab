import { useMemo, useState } from 'react';
import { api, lastLogs, useApi, useArtifactUrl } from './api.ts';
import { navigate } from './App.tsx';

// ---------- types (mirror the server's rows) ----------
interface Device {
  id: string;
  worker_id: string;
  worker_name: string;
  worker_status: string;
  platform: 'ios' | 'android';
  name: string;
  model: string;
  os_version: string;
  state: string;
  connected: number;
  serial: string | null;
  screen_w: number | null;
  screen_h: number | null;
  screen_density: number | null;
  lease_holder: string | null;
}
interface Build {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  app_id: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}
interface Suite {
  id: string;
  name: string;
  flow_yaml: string;
}
interface Task {
  id: string;
  device_name: string;
  platform: string;
  os_version: string;
  model: string;
  status: string;
  error: string | null;
  duration_ms: number | null;
  screen_w: number | null;
  screen_h: number | null;
  screen_density: number | null;
}
interface Artifact {
  id: string;
  task_id: string | null;
  kind: string;
  file_name: string;
}

const fmtBytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
const fmtTime = (s: string) => new Date(s).toLocaleString();
const fmtScreen = (w: number | null, h: number | null, d: number | null) =>
  w && h ? `${Math.round(w / (d ?? 1))}×${Math.round(h / (d ?? 1))} pt @${d}x` : '–';

function Badge({ s }: { s: string }) {
  return <span className={`badge b-${s}`}>{s}</span>;
}

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (done) setMsg({ ok: true, text: done });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return { busy, msg, run, setMsg };
}

// ---------- Overview ----------
export function OverviewPage() {
  const { data } = useApi<{
    workersOnline: number;
    workers: number;
    devicesConnected: number;
    devicesBooted: number;
    devicesLeased: number;
    runsActive: number;
    builds: number;
    recentRuns: { id: string; status: string; created_at: string; suite: string }[];
  }>('/api/overview');
  if (!data) return <p className="muted">Loading…</p>;
  const tiles: [string, string | number][] = [
    ['Workers online', `${data.workersOnline} / ${data.workers}`],
    ['Devices booted', `${data.devicesBooted} / ${data.devicesConnected}`],
    ['Devices in use', data.devicesLeased],
    ['Active runs', data.runsActive],
    ['Builds', data.builds],
  ];
  return (
    <section>
      <h1>Overview</h1>
      <div className="tiles">
        {tiles.map(([k, v]) => (
          <div className="tile" key={k}>
            <div className="tile-v">{v}</div>
            <div className="tile-k">{k}</div>
          </div>
        ))}
      </div>
      <h2>Recent runs</h2>
      <table>
        <tbody>
          {data.recentRuns.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => navigate('runs', r.id)}>
              <td>{r.suite}</td>
              <td>
                <Badge s={r.status} />
              </td>
              <td className="muted">{fmtTime(r.created_at)}</td>
            </tr>
          ))}
          {data.recentRuns.length === 0 && (
            <tr>
              <td className="muted">No runs yet. Pick devices on the Devices page and start one.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

// ---------- Devices ----------
export function DevicesPage() {
  const { data: devices } = useApi<Device[]>('/api/devices');
  const { data: builds } = useApi<Build[]>('/api/builds');
  const { data: suites } = useApi<Suite[]>('/api/suites');
  const [platform, setPlatform] = useState<'all' | 'ios' | 'android'>('all');
  const [query, setQuery] = useState('');
  const [bootedOnly, setBootedOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [suiteId, setSuiteId] = useState('');
  const act = useAction();

  const rows = useMemo(
    () =>
      (devices ?? []).filter(
        (d) =>
          d.connected &&
          (platform === 'all' || d.platform === platform) &&
          (!bootedOnly || d.state === 'booted') &&
          `${d.name} ${d.os_version} ${d.model}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [devices, platform, query, bootedOnly],
  );
  const latest = (p: string) => builds?.find((b) => b.platform === p);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const deviceAction = (d: Device, action: string, args: object = {}) =>
    act.run(`${d.id}:${action}`, async () => {
      const r = await api<{ data: { artifactId?: string; width?: number; height?: number } }>(
        'POST',
        `/api/devices/${encodeURIComponent(d.id)}/actions/${action}`,
        { args },
      );
      if (r.data?.artifactId) setShot({ id: r.data.artifactId, title: `${d.name} (${d.os_version})` });
    }, `${action} ✓ ${d.name}`);
  const [shot, setShot] = useState<{ id: string; title: string } | null>(null);

  const startRun = () =>
    act.run('run', async () => {
      const chosen = (devices ?? []).filter((d) => selected.has(d.id));
      const ios = latest('ios');
      const android = latest('android');
      const r = await api<{ id: string }>('POST', '/api/runs', {
        suiteId,
        deviceIds: chosen.map((d) => d.id),
        builds: { ios: chosen.some((d) => d.platform === 'ios') ? ios?.id : undefined, android: chosen.some((d) => d.platform === 'android') ? android?.id : undefined },
      });
      navigate('runs', r.id);
    });

  return (
    <section>
      <h1>Devices</h1>
      <div className="toolbar">
        <div className="seg">
          {(['all', 'ios', 'android'] as const).map((p) => (
            <button key={p} className={platform === p ? 'on' : ''} onClick={() => setPlatform(p)}>
              {p === 'all' ? 'All' : p === 'ios' ? 'iOS' : 'Android'}
            </button>
          ))}
        </div>
        <input placeholder="Filter: iPad, 18.5, Pixel…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={bootedOnly} onChange={(e) => setBootedOnly(e.target.checked)} /> booted only
        </label>
      </div>

      <div className={`runbar ${selected.size ? 'show' : ''}`}>
        <strong>{selected.size} selected</strong>
        <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
          <option value="">Choose a test suite…</option>
          {suites?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="muted small">
          installs the newest build per platform ({latest('ios')?.name ?? 'no iOS build'} / {latest('android')?.name ?? 'no Android build'})
        </span>
        <button className="primary" disabled={!suiteId || act.busy === 'run'} onClick={startRun}>
          Run on {selected.size} device{selected.size === 1 ? '' : 's'}
        </button>
        <button onClick={() => setSelected(new Set())}>Clear</button>
      </div>
      {act.msg && <div className={`msg ${act.msg.ok ? 'ok' : 'err'}`}>{act.msg.text}</div>}

      <table>
        <thead>
          <tr>
            <th />
            <th>Device</th>
            <th>OS</th>
            <th>Screen</th>
            <th>State</th>
            <th>Worker</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const busy = (a: string) => act.busy === `${d.id}:${a}`;
            const build = latest(d.platform);
            return (
              <tr key={d.id} className={selected.has(d.id) ? 'sel' : ''}>
                <td>
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                </td>
                <td>
                  <span className={`plat ${d.platform}`}>{d.platform === 'ios' ? 'iOS' : 'AND'}</span> {d.name}
                  {d.serial && <span className="muted small"> {d.serial}</span>}
                </td>
                <td>{d.os_version}</td>
                <td className="mono small">{fmtScreen(d.screen_w, d.screen_h, d.screen_density)}</td>
                <td>
                  <Badge s={d.state} />
                  {d.lease_holder && <span className="badge b-leased">in use</span>}
                </td>
                <td className="muted small">{d.worker_name}</td>
                <td className="actions">
                  {d.state === 'booted' ? (
                    <>
                      <button disabled={busy('screenshot')} onClick={() => deviceAction(d, 'screenshot')}>
                        Screenshot
                      </button>
                      {build && (
                        <button disabled={busy('install')} title={build.name} onClick={() => deviceAction(d, 'install', { buildId: build.id })}>
                          {busy('install') ? 'Installing…' : 'Install latest'}
                        </button>
                      )}
                      {d.platform === 'android' && (
                        <select
                          defaultValue=""
                          disabled={busy('screen-profile')}
                          onChange={(e) => {
                            if (e.target.value) deviceAction(d, 'screen-profile', { profile: e.target.value });
                            e.target.value = '';
                          }}
                        >
                          <option value="">Screen…</option>
                          <option value="phone">Phone</option>
                          <option value="tablet-7">Tablet 7"</option>
                          <option value="tablet-10">Tablet 10"</option>
                          <option value="reset">Reset</option>
                        </select>
                      )}
                      <button className="ghost" disabled={busy('shutdown')} onClick={() => deviceAction(d, 'shutdown')}>
                        Shut down
                      </button>
                    </>
                  ) : (
                    <button disabled={busy('boot') || d.state === 'booting'} onClick={() => deviceAction(d, 'boot')}>
                      {busy('boot') ? 'Booting…' : 'Boot'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shot && <ShotModal id={shot.id} title={shot.title} onClose={() => setShot(null)} />}
    </section>
  );
}

function ShotModal({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const url = useArtifactUrl(id);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <strong>{title}</strong>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {url ? <img src={url} alt={title} /> : <p className="muted">Loading…</p>}
      </div>
    </div>
  );
}

// ---------- Workers ----------
export function WorkersPage() {
  const { data } = useApi<
    { id: string; name: string; os: string; capabilities: string[]; online: boolean; last_heartbeat_at: string | null; load: { cpus: number; freeMemMb: number; freeDiskMb?: number } | null }[]
  >('/api/workers');
  return (
    <section>
      <h1>Workers</h1>
      <p className="muted">
        A worker is a machine running <code>npm run worker</code>. macOS workers provide iOS simulators and Android emulators; Windows/Linux workers provide Android only.
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>OS</th>
            <th>Capabilities</th>
            <th>Status</th>
            <th>Load</th>
            <th>Free disk</th>
            <th>Last heartbeat</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((w) => (
            <tr key={w.id}>
              <td>{w.name}</td>
              <td>{w.os === 'darwin' ? 'macOS' : w.os === 'win32' ? 'Windows' : w.os}</td>
              <td>{w.capabilities.join(', ')}</td>
              <td>
                <Badge s={w.online ? 'online' : 'offline'} />
              </td>
              <td className="mono small">{w.load ? `${w.load.cpus.toFixed(1)} · ${w.load.freeMemMb} MB RAM free` : '–'}</td>
              <td className={`mono small ${w.load?.freeDiskMb !== undefined && w.load.freeDiskMb < 8000 ? 'warn' : ''}`}>
                {w.load?.freeDiskMb !== undefined ? `${(w.load.freeDiskMb / 1024).toFixed(1)} GB` : '–'}
              </td>
              <td className="muted small">{w.last_heartbeat_at ? fmtTime(w.last_heartbeat_at) : 'never'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------- Builds ----------
export function BuildsPage() {
  const { data, reload } = useApi<Build[]>('/api/builds');
  const act = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [appId, setAppId] = useState('');
  const [name, setName] = useState('');
  const platform = file?.name.endsWith('.apk') ? 'android' : file?.name.endsWith('.zip') ? 'ios' : null;

  const upload = () =>
    act.run(
      'upload',
      async () => {
        await api('POST', '/api/builds', file!, {
          'content-type': 'application/octet-stream',
          'x-build-name': name || file!.name,
          'x-platform': platform!,
          'x-app-id': appId,
          'x-file-name': file!.name,
        });
        setFile(null);
        reload();
      },
      'Build uploaded',
    );

  const distribute = (b: Build) =>
    act.run(`dist:${b.id}`, async () => {
      const r = await api<{ results: { deviceId: string; ok: boolean; error?: string }[] }>('POST', `/api/builds/${b.id}/distribute`, {});
      const ok = r.results.filter((x) => x.ok).length;
      const bad = r.results.filter((x) => !x.ok);
      act.setMsg({
        ok: bad.length === 0,
        text: r.results.length === 0 ? `No booted ${b.platform} devices to install on.` : `Installed on ${ok}/${r.results.length} devices${bad.length ? ` - ${bad.map((x) => x.error).join('; ')}` : ''}`,
      });
    });

  return (
    <section>
      <h1>Builds</h1>
      <div className="card">
        <h2>Upload a build</h2>
        <p className="muted small">
          Android: <code>.apk</code>. iOS Simulator: a zipped <code>.app</code>. Easiest: <code>npm run lab -- build add path/to/App.app</code>, which zips it and reads the bundle id for you.
        </p>
        <div className="form-row">
          <input type="file" accept=".apk,.zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <input placeholder="App id (com.company.app)" value={appId} onChange={(e) => setAppId(e.target.value)} />
          <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={!file || !platform || !appId || act.busy === 'upload'} onClick={upload}>
            {act.busy === 'upload' ? 'Uploading…' : `Upload${platform ? ` (${platform})` : ''}`}
          </button>
        </div>
      </div>
      {act.msg && <div className={`msg ${act.msg.ok ? 'ok' : 'err'}`}>{act.msg.text}</div>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Platform</th>
            <th>App id</th>
            <th>Size</th>
            <th>sha256</th>
            <th>Uploaded</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((b) => (
            <tr key={b.id}>
              <td>{b.name}</td>
              <td>
                <span className={`plat ${b.platform}`}>{b.platform === 'ios' ? 'iOS' : 'AND'}</span>
              </td>
              <td className="mono small">{b.app_id}</td>
              <td>{fmtBytes(b.size_bytes)}</td>
              <td className="mono small">{b.sha256.slice(0, 12)}</td>
              <td className="muted small">{fmtTime(b.created_at)}</td>
              <td>
                <button disabled={act.busy === `dist:${b.id}`} onClick={() => distribute(b)}>
                  {act.busy === `dist:${b.id}` ? 'Installing…' : 'Install on all booted'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------- Suites ----------
export function SuitesPage() {
  const { data, reload } = useApi<Suite[]>('/api/suites');
  const [editing, setEditing] = useState<{ name: string; flowYaml: string } | null>(null);
  const act = useAction();
  return (
    <section>
      <h1>Test Suites</h1>
      <p className="muted">
        A suite is one Maestro flow. Use <code>appId: ${'{APP_ID}'}</code>; the lab fills it in per platform from the build.
      </p>
      <button onClick={() => setEditing({ name: '', flowYaml: 'appId: ${APP_ID}\n---\n- launchApp\n- takeScreenshot: home\n' })}>New suite</button>
      <div className="split">
        <ul className="list">
          {data?.map((s) => (
            <li key={s.id} className={editing?.name === s.name ? 'on' : ''} onClick={() => setEditing({ name: s.name, flowYaml: s.flow_yaml })}>
              {s.name}
            </li>
          ))}
        </ul>
        {editing && (
          <div className="card grow">
            <input value={editing.name} placeholder="Suite name" onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <textarea spellCheck={false} rows={18} value={editing.flowYaml} onChange={(e) => setEditing({ ...editing, flowYaml: e.target.value })} />
            <button
              className="primary"
              disabled={!editing.name}
              onClick={() =>
                act.run('save', async () => {
                  await api('POST', '/api/suites', editing);
                  reload();
                }, 'Saved')
              }
            >
              Save
            </button>
            {act.msg && <div className={`msg ${act.msg.ok ? 'ok' : 'err'}`}>{act.msg.text}</div>}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- Runs ----------
export function RunsPage() {
  const { data } = useApi<{ id: string; suite_name: string; status: string; created_at: string; task_count: number; passed_count: number }[]>('/api/runs');
  return (
    <section>
      <h1>Test Runs</h1>
      <table>
        <thead>
          <tr>
            <th>Suite</th>
            <th>Status</th>
            <th>Devices passed</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => navigate('runs', r.id)}>
              <td>{r.suite_name}</td>
              <td>
                <Badge s={r.status} />
              </td>
              <td>
                {r.passed_count} / {r.task_count}
              </td>
              <td className="muted small">{fmtTime(r.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function RunDetailPage({ id }: { id: string }) {
  const { data } = useApi<{ run: { id: string; status: string; suite_name: string; created_at: string; finished_at: string | null }; tasks: Task[]; artifacts: Artifact[] }>(`/api/runs/${id}`);
  const [label, setLabel] = useState<string>('final.png');
  if (!data) return <p className="muted">Loading…</p>;
  const shots = data.artifacts.filter((a) => a.kind === 'screenshot');
  const labels = [...new Set(shots.map((s) => s.file_name))].sort((a, b) => (a === 'final.png' ? 1 : b === 'final.png' ? -1 : a.localeCompare(b)));
  const active = !['passed', 'failed', 'error', 'cancelled'].includes(data.run.status);
  return (
    <section>
      <div className="row">
        <h1>
          {data.run.suite_name} <Badge s={data.run.status} />
        </h1>
        {active && <button onClick={() => api('POST', `/api/runs/${id}/cancel`)}>Cancel run</button>}
      </div>
      <p className="muted small">
        Started {fmtTime(data.run.created_at)}
        {data.run.finished_at && ` · finished ${fmtTime(data.run.finished_at)}`}
      </p>
      {labels.length > 0 && (
        <div className="seg">
          {labels.map((l) => (
            <button key={l} className={label === l ? 'on' : ''} onClick={() => setLabel(l)}>
              {l.replace(/\.png$/, '')}
            </button>
          ))}
        </div>
      )}
      <div className="grid">
        {data.tasks.map((t) => {
          const shot = shots.find((s) => s.task_id === t.id && s.file_name === label) ?? shots.filter((s) => s.task_id === t.id).at(-1);
          const logs = lastLogs.filter((l) => l.taskId === t.id).slice(-4);
          return (
            <div className="cell" key={t.id}>
              <div className="cell-head">
                <div>
                  <span className={`plat ${t.platform}`}>{t.platform === 'ios' ? 'iOS' : 'AND'}</span> <strong>{t.device_name}</strong>
                  <div className="muted small">
                    {t.os_version} · {fmtScreen(t.screen_w, t.screen_h, t.screen_density)}
                  </div>
                </div>
                <Badge s={t.status} />
              </div>
              <Shot id={shot?.id ?? null} status={t.status} />
              <div className="small">
                {t.duration_ms !== null && <span className="muted">{(t.duration_ms / 1000).toFixed(1)} s</span>}
                {t.error && <div className="err-text">{t.error}</div>}
                {!t.error && logs.length > 0 && t.status === 'running' && <pre className="tail">{logs.map((l) => l.message).join('\n')}</pre>}
              </div>
              <div className="links small">
                {data.artifacts
                  .filter((a) => a.task_id === t.id && a.kind !== 'screenshot')
                  .map((a) => (
                    <ArtifactLink key={a.id} a={a} />
                  ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Shot({ id, status }: { id: string | null; status: string }) {
  const url = useArtifactUrl(id);
  return <div className="shot">{url ? <img src={url} alt="" /> : <span className="muted small">{['queued', 'leasing', 'preparing', 'running'].includes(status) ? status + '…' : 'no screenshot'}</span>}</div>;
}

function ArtifactLink({ a }: { a: Artifact }) {
  const url = useArtifactUrl(a.id);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" download={a.file_name}>
      {a.kind === 'junit' ? 'JUnit report' : a.kind === 'log' ? 'Maestro log' : a.file_name}
    </a>
  ) : null;
}
