import { EventEmitter } from 'node:events';

export type LabEvent =
  | { type: 'worker.updated'; workerId: string }
  | { type: 'device.updated'; deviceId?: string }
  | { type: 'run.updated'; runId: string }
  | { type: 'task.updated'; runId: string; taskId: string; status: string }
  | { type: 'task.log'; runId: string; taskId: string; level: string; message: string }
  | { type: 'artifact.created'; runId?: string | null; taskId?: string | null; artifactId: string }
  | { type: 'live.frame'; deviceId: string; at: number };

/** In-process fan-out to dashboard sockets. Replaced by Redis pub/sub when the server scales out. */
export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(100);
  emit(e: LabEvent): void {
    this.emitter.emit('event', e);
  }
  on(fn: (e: LabEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
