import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

const TOKEN_KEY = 'lab.token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode: token lives for this tab only */
  }
  memToken = t;
}
let memToken = getToken();

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isBlob = body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${memToken}`, ...(body !== undefined && !isBlob ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json.message ?? json.error ?? `HTTP ${res.status}`);
  return json as T;
}

// ---------- live events: one socket, a version counter components subscribe to ----------
type Listener = () => void;
let version = 0;
let connected = false;
const listeners = new Set<Listener>();
const bump = () => {
  version++;
  listeners.forEach((l) => l());
};
export const lastLogs: { taskId: string; message: string; level: string }[] = [];

// Live Wall frames bypass the global version counter: they arrive every ~1.5 s
// per device and must not make every other page refetch.
const frameListeners = new Set<(deviceId: string, at: number) => void>();
export function onFrame(fn: (deviceId: string, at: number) => void): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

export function connectLive() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/dashboard`);
  let timer: number | undefined;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: memToken }));
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'ready') {
      connected = true;
      bump();
      return;
    }
    if (e.type === 'live.frame') {
      frameListeners.forEach((l) => l(e.deviceId, e.at));
      return;
    }
    if (e.type === 'task.log') {
      lastLogs.push({ taskId: e.taskId, message: e.message, level: e.level });
      if (lastLogs.length > 2000) lastLogs.splice(0, lastLogs.length - 2000);
    }
    // Coalesce bursts (Maestro output) into one refresh.
    clearTimeout(timer);
    timer = window.setTimeout(bump, 300);
  };
  ws.onclose = () => {
    connected = false;
    bump();
    setTimeout(connectLive, 3000);
  };
}

export function useLiveVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}
export const isLive = () => connected;

/** Fetches `path`, refetching whenever a live event arrives. */
export function useApi<T>(path: string | null): { data: T | undefined; error: string | null; reload: () => void } {
  const v = useLiveVersion();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api<T>('GET', path)
      .then((d) => alive && pathRef.current === path && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, v, n]);
  return { data, error, reload };
}

export const authHeader = () => ({ authorization: `Bearer ${memToken}` });

/** <img> can't send a bearer header, so artifacts are fetched as blobs. */
export function useArtifactUrl(id: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let revoked = false;
    let obj: string | null = null;
    fetch(`/api/artifacts/${id}`, { headers: { authorization: `Bearer ${memToken}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && !revoked) setUrl((obj = URL.createObjectURL(b)));
      });
    return () => {
      revoked = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [id]);
  return url;
}
