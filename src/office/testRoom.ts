import type { ClientMsg, ServerMsg } from '../shared/workspace/protocol.ts';
import { Emitter, type ConnStatus, type RoomConnection } from './net/room.ts';

/** A room the test drives by hand: it records what the app sends and says only what the test makes it say. (Not a test file: shared by the tests.) */
export class ScriptedRoom implements RoomConnection {
  readonly kind = 'remote' as const;
  sent: ClientMsg[] = [];
  connected = true;
  private messages = new Emitter<ServerMsg>();
  private statuses = new Emitter<ConnStatus>();
  open() {}
  close() {}
  send(msg: ClientMsg) {
    if (!this.connected) return false;
    this.sent.push(msg);
    return true;
  }
  onMessage(l: (m: ServerMsg) => void) {
    return this.messages.on(l);
  }
  onStatus(l: (s: ConnStatus) => void) {
    return this.statuses.on(l);
  }
  deliver(m: ServerMsg) {
    // Like the real connection: it takes messages again once the server has welcomed the person.
    if (m.t === 'welcome') this.connected = true;
    this.messages.emit(m);
  }
  status(s: ConnStatus) {
    // And, like the real one, it can't send while it isn't connected.
    this.connected = s.state === 'online';
    this.statuses.emit(s);
  }
  last<T extends ClientMsg['t']>(t: T) {
    return this.sent.filter((m) => m.t === t).pop() as Extract<ClientMsg, { t: T }> | undefined;
  }
  all<T extends ClientMsg['t']>(t: T) {
    return this.sent.filter((m) => m.t === t) as Extract<ClientMsg, { t: T }>[];
  }
}
