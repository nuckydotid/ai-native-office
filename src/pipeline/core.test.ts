import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORK_STAGES } from '../flow.ts';
import type { Artifact, Job } from '../shared/pipeline/types.ts';
import { ASKS, JOBS, KINDS, artifactsOf, currentArtifact, durationText, jobActive, jobOn, shortDigest } from './core.ts';

const artifact = (over: Partial<Artifact>): Artifact => ({
  id: 'a1', ticket: 't1', ticketKey: 1, kind: 'spec', version: 1, digest: 'd'.repeat(64), title: 'A spec', body: 'x', state: 'draft',
  by: { id: 'agent:planner', name: 'Planner Agent', agent: true }, createdAt: 1, ...over,
});
const job = (over: Partial<Job>): Job => ({
  id: 'j1', ticket: 't1', kind: 'unit', state: 'passed', inputDigest: 'd1', startedBy: { id: 'u', name: 'Ada' }, logTail: '', links: [], createdAt: 1, ...over,
});

test('every stage has its buttons, its jobs and its artifact kinds', () => {
  for (const stage of WORK_STAGES) {
    assert.ok(ASKS[stage].length >= 1, `${stage} has an agent to ask`);
    assert.ok(KINDS[stage].length >= 1, `${stage} shows an artifact`);
    assert.ok(Array.isArray(JOBS[stage]));
  }
  assert.deepEqual(JOBS.test, ['unit', 'e2e']);
  assert.deepEqual(JOBS.release, ['release_build', 'scan']);
});

test('a superseded artifact is never shown, and newer comes first', () => {
  const all = [
    artifact({ id: 'a1', version: 1, state: 'superseded', createdAt: 1 }),
    artifact({ id: 'a2', version: 2, state: 'accepted', createdAt: 2 }),
    artifact({ id: 'a3', version: 3, state: 'draft', createdAt: 3 }),
    artifact({ id: 'b1', ticket: 't2', createdAt: 9 }),
  ];
  assert.deepEqual(artifactsOf(all, 't1', ['spec']).map((a) => a.id), ['a3', 'a2']);
  assert.equal(currentArtifact(all, 't1', 'spec')?.id, 'a2', 'the accepted one is what a gate reads');
  assert.equal(currentArtifact(all, 't1', 'design'), undefined);
  assert.equal(currentArtifact([artifact({ id: 'x', state: 'rejected' })], 't1', 'spec'), undefined, 'a rejected draft is not a current artifact');
});

test('a job counts only on the digest it ran on', () => {
  const jobs = [job({ id: 'old', inputDigest: 'old', createdAt: 5 }), job({ id: 'mine', inputDigest: 'd1', createdAt: 2 }), job({ id: 'mine2', inputDigest: 'd1', createdAt: 3, state: 'failed' })];
  assert.equal(jobOn(jobs, 't1', 'unit', 'd1')?.id, 'mine2');
  assert.equal(jobOn(jobs, 't1', 'e2e', 'd1'), undefined);
  assert.equal(jobOn(jobs, 't1', 'unit', undefined), undefined);
  assert.equal(jobActive({ state: 'running' }), true);
  assert.equal(jobActive({ state: 'passed' }), false);
});

test('durations and digests read short', () => {
  assert.equal(durationText(3000), '3 s');
  assert.equal(durationText(80_000), '1 min 20 s');
  assert.equal(durationText(120_000), '2 min');
  assert.equal(durationText(undefined), '');
  assert.equal(shortDigest('abcdef0123456789'), 'abcdef01');
});
