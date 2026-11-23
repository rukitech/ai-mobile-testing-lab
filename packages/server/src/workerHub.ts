import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { type CommandName, type Platform, LabError, PROTOCOL_VERSION, WorkerToServer } from '@lab/shared';
import type { Registry } from './registry.ts';
import type { EventBus } from './events.ts';
import { signWorkerToken } from './auth.ts';

interface Pending {
  workerId: string;
  resolve: (data: unknown) => void;
  reject: (err: LabError) => void;
  onEvent?: (level: string, message: string) => void;
  timer: NodeJS.Timeout;
}

interface Conn {
  socket: WebSocket;
  tokenExp: number; // epoch seconds
}

export interface SendOptions {
  deviceKey?: string;
  platform?: Platform;
  timeoutMs?: number;
  onEvent?: (level: string, message: string) => void;
}

/** Live worker sockets + request/response correlation for commands. */
export class WorkerHub {
  private readonly conns = new Map<string, Conn>();
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly registry: Registry,
    private readonly bus: EventBus,
    private readonly secret: string,
    private readonly tokenTtlSeconds: number,
    private readonly log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void },
  ) {}

  isOnline(workerId: string): boolean {
    return this.conns.has(workerId);
  }

  attach(workerId: string, tokenExp: number, socket: WebSocket): void {
    // A reconnect replaces a stale socket for the same worker.
    this.conns.get(workerId)?.socket.close(4000, 'replaced by a newer connection');
    const conn: Conn = { socket, tokenExp };
    this.conns.set(workerId, conn);
    this.registry.setWorkerStatus(workerId, 'online');
    this.bus.emit({ type: 'worker.updated', workerId });

    socket.on('message', (raw) => {
      if (Date.now() / 1000 >= conn.tokenExp) {
        socket.close(4001, 'token expired');
        return;
      }
      let frame;
      try {
        frame = WorkerToServer.parse(JSON.parse(String(raw)));
      } catch (e) {
        this.log.warn({ workerId, err: String(e) }, 'dropped invalid worker frame');
        return;
      }
      this.handle(workerId, conn, frame);
    });
    socket.on('close', () => {
      if (this.conns.get(workerId)?.socket !== socket) return; // replaced
      this.conns.delete(workerId);
      this.registry.setWorkerStatus(workerId, 'offline');
      for (const [id, p] of this.pending) {
        if (p.workerId !== workerId) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new LabError('WORKER_LOST', 'worker disconnected while the command was running'));
      }
      this.bus.emit({ type: 'worker.updated', workerId });
      this.bus.emit({ type: 'device.updated' });
    });
  }

  private handle(workerId: string, conn: Conn, frame: WorkerToServer): void {
    switch (frame.type) {
      case 'hello':
        if (frame.workerId !== workerId) {
          conn.socket.close(4003, 'workerId mismatch');
          return;
        }
        if (frame.version !== PROTOCOL_VERSION) this.log.warn({ workerId, version: frame.version }, 'protocol version mismatch');
        return;
      case 'heartbeat':
        this.registry.heartbeat(workerId, frame.load);
        this.bus.emit({ type: 'worker.updated', workerId });
        return;
      case 'devices.report':
        this.registry.syncDevices(workerId, frame.devices);
        this.bus.emit({ type: 'device.updated' });
        return;
      case 'token.refresh': {
        const { token, expiresAt } = signWorkerToken(this.secret, workerId, this.tokenTtlSeconds);
        conn.tokenExp = Math.floor(Date.parse(expiresAt) / 1000);
        conn.socket.send(JSON.stringify({ type: 'token.refreshed', token, expiresAt }));
        return;
      }
      case 'command.event': {
        const p = this.pending.get(frame.commandId);
        if (p && p.workerId === workerId) p.onEvent?.(frame.level, frame.message);
        return;
      }
      case 'command.result': {
        const p = this.pending.get(frame.commandId);
        if (!p || p.workerId !== workerId) return;
        clearTimeout(p.timer);
        this.pending.delete(frame.commandId);
        if (frame.ok) p.resolve(frame.data);
        else p.reject(new LabError(frame.error?.code ?? 'EXEC_FAILED', frame.error?.message ?? 'command failed'));
        return;
      }
    }
  }

  send(workerId: string, name: CommandName, args: unknown, opts: SendOptions = {}): Promise<unknown> {
    const conn = this.conns.get(workerId);
    if (!conn) return Promise.reject(new LabError('WORKER_LOST', 'worker is offline'));
    const commandId = randomUUID();
    const timeoutMs = opts.timeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(new LabError('TIMEOUT', `${name} timed out after ${timeoutMs} ms`));
      }, timeoutMs + 5_000); // worker enforces timeoutMs itself; this is the backstop
      this.pending.set(commandId, { workerId, resolve, reject, onEvent: opts.onEvent, timer });
      conn.socket.send(
        JSON.stringify({ type: 'command', commandId, name, platform: opts.platform, deviceKey: opts.deviceKey, args, timeoutMs }),
      );
    });
  }

  closeAll(): void {
    for (const c of this.conns.values()) c.socket.close(1001, 'server shutting down');
  }
}
