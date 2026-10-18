import type { FirestoreClient } from './google.ts';

/** Where the pipeline keeps its state. Every test uses the memory one; Cloud Run uses Firestore's `pipeline` database. */
export interface StateStore {
  get<T>(collection: string, id: string): Promise<T | null>;
  set(collection: string, id: string, value: unknown): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  list<T>(collection: string): Promise<{ id: string; value: T }[]>;
  clear(collection: string): Promise<void>;
}

export class MemoryStateStore implements StateStore {
  private data = new Map<string, Map<string, unknown>>();

  private group(collection: string) {
    let group = this.data.get(collection);
    if (!group) {
      group = new Map();
      this.data.set(collection, group);
    }
    return group;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const value = this.group(collection).get(id);
    return value === undefined ? null : (structuredClone(value) as T);
  }

  async set(collection: string, id: string, value: unknown): Promise<void> {
    this.group(collection).set(id, structuredClone(value));
  }

  async delete(collection: string, id: string): Promise<void> {
    this.group(collection).delete(id);
  }

  async list<T>(collection: string): Promise<{ id: string; value: T }[]> {
    return [...this.group(collection)].map(([id, value]) => ({ id, value: structuredClone(value) as T }));
  }

  async clear(collection: string): Promise<void> {
    this.data.delete(collection);
  }
}

export class FirestoreStateStore implements StateStore {
  constructor(private client: FirestoreClient) {}

  get<T>(collection: string, id: string) {
    return this.client.get<T>(`${collection}/${id}`);
  }

  async set(collection: string, id: string, value: unknown) {
    await this.client.set(`${collection}/${id}`, value);
  }

  async delete(collection: string, id: string) {
    await this.client.delete(`${collection}/${id}`);
  }

  list<T>(collection: string) {
    return this.client.list<T>(collection);
  }

  clear(collection: string) {
    return this.client.clear(collection);
  }
}
