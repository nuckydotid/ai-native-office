import type { ClientMsg, ServerMsg } from '../../shared/workspace/protocol.ts';

export type ConnState = 'connecting' | 'online' | 'reconnecting' | 'failed' | 'closed';

export interface ConnStatus {
  state: ConnState;
  /** A sentence for the person when something went wrong. */
  message?: string;
  /** Round trip to the team server, in milliseconds. */
  latencyMs?: number;
  /** The server's own reason code when it turned the person away (`update_required`, `removed`, ...). */
  code?: string;
}

/**
 * Where the office comes from. The team server and the offline practice office speak the same messages, so the rest of
 * the app does not care which one it is talking to.
 */
export interface RoomConnection {
  readonly kind: 'local' | 'remote';
  open(): void;
  close(): void;
  /** Returns false when the message could not be sent (not connected). */
  send(msg: ClientMsg): boolean;
  onMessage(listener: (msg: ServerMsg) => void): () => void;
  onStatus(listener: (status: ConnStatus) => void): () => void;
}

/** Listener bookkeeping shared by both rooms. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value: T) {
    for (const listener of [...this.listeners]) listener(value);
  }
}
