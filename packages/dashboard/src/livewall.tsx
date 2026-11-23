import { useEffect, useMemo, useRef, useState } from 'react';
import { api, authHeader, onFrame, useApi } from './api.ts';

interface Device {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  os_version: string;
  state: string;
  connected: number;
  screen_w: number | null;
  screen_h: number | null;
  screen_density: number | null;
  lease_holder: string | null;
  worker_name: string;
}

/**
 * Every booted device in one grid, refreshed every ~1.5 s while this page is
 * open. Frames are screenshots relayed through server memory (not video, not
 * stored). Watching works during test runs too - that is the point.
 */
export function LiveWallPage() {
  const { data: devices } = useApi<Device[]>('/api/devices?state=booted');
  const [platform, setPlatform] = useState<'all' | 'ios' | 'android'>('all');
  const [size, setSize] = useState(240);
  const [paused, setPaused] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);

  const shown = useMemo(
    () => (devices ?? []).filter((d) => d.connected && (platform === 'all' || d.platform === platform)),
    [devices, platform],
  );
  const ids = shown.map((d) => d.id).join('|');

  // Renew the watch well inside its 10 s TTL; when we stop, the server stops polling on its own.
  useEffect(() => {
    if (paused || !ids) return;
    const list = ids.split('|');
    const renew = () => void api('POST', '/api/live/watch', { deviceIds: list }).catch(() => undefined);
    renew();
    const t = setInterval(renew, 4000);
    return () => clearInterval(t);
  }, [ids, paused]);

  const focused = shown.find((d) => d.id === focus);

  return (
    <section>
      <div className="row">
        <h1>Live Wall</h1>
        <div className="toolbar" style={{ margin: 0 }}>
          <div className="seg">
            {(['all', 'ios', 'android'] as const).map((p) => (
              <button key={p} className={platform === p ? 'on' : ''} onClick={() => setPlatform(p)}>
                {p === 'all' ? 'All' : p === 'ios' ? 'iOS' : 'Android'}
              </button>
            ))}
          </div>
          <label className="check">
            Size
            <input type="range" min={160} max={420} step={20} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          </label>
          <button onClick={() => setPaused((p) => !p)}>{paused ? 'Resume' : 'Pause'}</button>
        </div>
      </div>
      <p className="muted small">
        Screenshots every ~1.5 s from every booted device, including those running a test. Boot devices on the Devices page to add them here.
      </p>
      {devices && shown.length === 0 && <p className="muted">No booted devices.</p>}
      <div className="wall" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}>
        {shown.map((d) => (
          <LiveTile key={d.id} device={d} paused={paused} onOpen={() => setFocus(d.id)} />
        ))}
      </div>
      {focused && (
        <div className="modal" onClick={() => setFocus(null)}>
          <div className="modal-body live-focus" onClick={(e) => e.stopPropagation()}>
            <LiveTile device={focused} paused={paused} large onOpen={() => setFocus(null)} />
          </div>
        </div>
      )}
    </section>
  );
}

function LiveTile({ device: d, paused, large, onOpen }: { device: Device; paused: boolean; large?: boolean; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const busy = useRef(false);
  const current = useRef<string | null>(null);

  useEffect(() => {
    const load = async () => {
      if (busy.current) return; // drop frames instead of queueing them
      busy.current = true;
      try {
        const r = await fetch(`/api/live/frames/${encodeURIComponent(d.id)}`, { headers: authHeader(), cache: 'no-store' });
        if (!r.ok) return;
        const next = URL.createObjectURL(await r.blob());
        if (current.current) URL.revokeObjectURL(current.current);
        current.current = next;
        setUrl(next);
        setAt(Number(r.headers.get('x-frame-at')) || Date.now());
      } finally {
        busy.current = false;
      }
    };
    void load(); // show the last frame right away if the server has one
    const off = onFrame((id) => {
      if (id === d.id && !paused) void load();
    });
    return off;
  }, [d.id, paused]);

  useEffect(() => () => void (current.current && URL.revokeObjectURL(current.current)), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const age = at ? Math.max(0, Math.round((now - at) / 1000)) : null;
  const stale = age !== null && age > 6;
  const testing = d.lease_holder?.startsWith('task:');
  const pt = d.screen_w && d.screen_h ? `${Math.round(d.screen_w / (d.screen_density ?? 1))}×${Math.round(d.screen_h / (d.screen_density ?? 1))}` : null;

  return (
    <div className={`live-tile ${large ? 'large' : ''}`} onClick={onOpen}>
      <div className="cell-head">
        <div>
          <span className={`plat ${d.platform}`}>{d.platform === 'ios' ? 'iOS' : 'AND'}</span> <strong>{d.name}</strong>
          <div className="muted small">
            {d.os_version}
            {pt && ` · ${pt} pt`}
          </div>
        </div>
        {testing && <span className="badge b-running">testing</span>}
      </div>
      <div className="live-screen">
        {url ? <img src={url} alt={d.name} /> : <span className="muted small">waiting for first frame…</span>}
      </div>
      <div className={`small ${stale ? 'warn' : 'muted'}`}>
        <span className={`dot ${paused || stale || age === null ? '' : 'on'}`} />
        {paused ? 'paused' : age === null ? 'connecting' : age <= 2 ? 'live' : `${age}s ago`}
      </div>
    </div>
  );
}
