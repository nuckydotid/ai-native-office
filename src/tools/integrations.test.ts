import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrationsFor } from './integrations.ts';

const status = (list: ReturnType<typeof integrationsFor>, id: string) => list.find((i) => i.id === id)?.status;

test('with the real pipeline the build, storage, registry and Cloud Run are connected', () => {
  const list = integrationsFor({ driver: 'http' });
  for (const id of ['cloudbuild', 'storage', 'registry', 'run']) assert.equal(status(list, id), 'on', id);
});

test('with the stand-in the same services say so, never connected', () => {
  const list = integrationsFor({ driver: 'fake' });
  for (const id of ['cloudbuild', 'storage', 'registry', 'run']) assert.equal(status(list, id), 'standin', id);
});

test('with no pipeline none of them claims anything', () => {
  const list = integrationsFor(null);
  for (const id of ['cloudbuild', 'storage', 'registry', 'run']) assert.equal(status(list, id), 'planned', id);
});

test('partner tools are never shown as connected without a key or a repository', () => {
  for (const seen of [null, { driver: 'fake' as const }, { driver: 'http' as const }]) {
    const list = integrationsFor(seen);
    for (const i of list.filter((x) => x.group === 'partner')) assert.equal(i.status, 'needs_setup', i.name);
  }
});

test('every entry says what it does and what is true of it', () => {
  const list = integrationsFor({ driver: 'http' });
  assert.equal(new Set(list.map((i) => i.id)).size, list.length);
  for (const i of list) {
    assert.ok(i.does.length > 10, i.id);
    assert.ok(i.detail.length > 10, i.id);
  }
});
