import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canMove, gateFor, hasAcceptanceCriteria } from './gates.ts';
import type { GateInput } from './gates.ts';
import { DEFAULT_POLICY } from './types.ts';

const by = { id: 'u1', name: 'Ada' };
const art = (kind: GateInput['artifacts'][number]['kind'], over: Partial<GateInput['artifacts'][number]> = {}): GateInput['artifacts'][number] => ({ id: `a-${kind}`, kind, state: 'accepted', digest: `d-${kind}`, body: '', by, ...over });
const job = (kind: GateInput['jobs'][number]['kind'], over: Partial<GateInput['jobs'][number]> = {}): GateInput['jobs'][number] => ({ kind, state: 'passed', inputDigest: 'd-change_set', createdAt: 1, ...over });
const input = (over: Partial<GateInput>): GateInput => ({ stage: 'plan', artifacts: [], jobs: [], rollouts: [], ...over });

describe('Plan', () => {
  test('needs an accepted spec that lists what done looks like', () => {
    assert.equal(gateFor(input({})).ready, false);
    assert.equal(gateFor(input({ artifacts: [art('spec', { body: 'Just prose.' })] })).ready, false);
    assert.equal(gateFor(input({ artifacts: [art('spec', { body: '## Acceptance\n- [ ] The list filters by status' })] })).ready, true);
    assert.equal(gateFor(input({ artifacts: [art('spec', { state: 'draft', body: '- [ ] x' })] })).ready, false, 'a draft is not accepted');
  });

  test('the checklist notation is a checkbox line', () => {
    assert.equal(hasAcceptanceCriteria('- [ ] a'), true);
    assert.equal(hasAcceptanceCriteria('* [x] done'), true);
    assert.equal(hasAcceptanceCriteria('- no box'), false);
  });
});

describe('Design and Build', () => {
  test('Design needs an accepted design', () => {
    assert.equal(gateFor(input({ stage: 'design' })).ready, false);
    assert.equal(gateFor(input({ stage: 'design', artifacts: [art('design')] })).ready, true);
  });

  test('Build needs the accepted change set and a build that passed on exactly that digest', () => {
    const base = { stage: 'build' as const, artifacts: [art('change_set')] };
    assert.equal(gateFor(input(base)).ready, false);
    assert.equal(gateFor(input({ ...base, jobs: [job('build')] })).ready, true);
    assert.equal(gateFor(input({ ...base, jobs: [job('build', { inputDigest: 'older-digest' })] })).ready, false, 'a build of another change set does not count');
    assert.equal(gateFor(input({ ...base, jobs: [job('build', { state: 'failed' })] })).ready, false);
    const running = gateFor(input({ ...base, jobs: [job('build', { state: 'running' })] }));
    assert.equal(running.checks.find((c) => c.id === 'build')?.detail, 'Still running.');
  });

  test('the newest job on the digest decides', () => {
    const jobs = [job('build', { state: 'failed', createdAt: 1 }), job('build', { createdAt: 2 })];
    assert.equal(gateFor(input({ stage: 'build', artifacts: [art('change_set')], jobs })).ready, true);
    const worse = [job('build', { createdAt: 1 }), job('build', { state: 'failed', createdAt: 2 })];
    assert.equal(gateFor(input({ stage: 'build', artifacts: [art('change_set')], jobs: worse })).ready, false);
  });
});

describe('Test', () => {
  const base = { stage: 'test' as const, artifacts: [art('change_set')] };
  const green = [job('unit', { summary: { coveragePct: 82 } }), job('e2e')];

  test('needs unit tests, coverage over the policy and end-to-end tests, all on the accepted change set', () => {
    assert.equal(gateFor(input({ ...base, jobs: green })).ready, true);
    assert.equal(gateFor(input({ ...base, jobs: [job('unit', { summary: { coveragePct: 82 } })] })).ready, false);
    const low = gateFor(input({ ...base, jobs: [job('unit', { summary: { coveragePct: 40 } }), job('e2e')] }));
    assert.equal(low.ready, false);
    assert.equal(low.checks.find((c) => c.id === 'coverage')?.detail, 'It is 40%.');
  });

  test('the policy moves the line', () => {
    const jobs = [job('unit', { summary: { coveragePct: 60 } }), job('e2e')];
    assert.equal(gateFor(input({ ...base, jobs })).ready, false);
    assert.equal(gateFor(input({ ...base, jobs, policy: { ...DEFAULT_POLICY, coverageMin: 50 } })).ready, true);
  });
});

describe('Release', () => {
  const base = { stage: 'release' as const, artifacts: [art('change_set'), art('release_pack')], actor: { id: 'u2', role: 'owner' } };
  const jobs = [job('release_build'), job('scan', { summary: { scanSeverity: 'LOW' } })];

  test('needs a release pack, a release image, a clean scan and an approver with the right role', () => {
    assert.equal(gateFor(input({ ...base, jobs })).ready, true);
    assert.equal(gateFor(input({ ...base, jobs: [job('release_build')] })).ready, false, 'no scan yet');
    assert.equal(gateFor(input({ ...base, jobs: [job('release_build'), job('scan', { summary: { scanSeverity: 'HIGH' } })] })).ready, false);
    assert.equal(gateFor(input({ ...base, jobs, actor: { id: 'u2', role: 'member' } })).ready, false);
  });

  test('a policy that does not require a scan lets a release through without one', () => {
    assert.equal(gateFor(input({ ...base, jobs: [job('release_build')], policy: { ...DEFAULT_POLICY, scanRequired: false } })).ready, true);
  });

  test('separation of duties keeps the author from approving their own release, when the policy asks', () => {
    const policy = { ...DEFAULT_POLICY, separationOfDuties: true };
    assert.equal(gateFor(input({ ...base, jobs, policy, actor: { id: 'u1', role: 'owner' } })).ready, false);
    assert.equal(gateFor(input({ ...base, jobs, policy, actor: { id: 'u2', role: 'owner' } })).ready, true);
  });
});

describe('Deploy and moving', () => {
  test('Deploy is ready only when the production rollout is complete', () => {
    assert.equal(gateFor(input({ stage: 'deploy' })).ready, false);
    assert.equal(gateFor(input({ stage: 'deploy', rollouts: [{ service: 'production', state: 'rolled_back', createdAt: 1 }] })).ready, false);
    assert.equal(gateFor(input({ stage: 'deploy', rollouts: [{ service: 'production', state: 'complete', createdAt: 1 }] })).ready, true);
    assert.equal(gateFor(input({ stage: 'deploy', rollouts: [{ service: 'staging', state: 'complete', createdAt: 1 }] })).ready, false, 'staging does not count');
  });

  test('a ticket goes forward one stage when the gate is ready, and back to any earlier stage', () => {
    const ready = gateFor(input({ stage: 'design', artifacts: [art('design')] }));
    assert.deepEqual(canMove('design', 'build', ready), { ok: true });
    assert.equal(canMove('design', 'test', ready).ok, false);
    assert.deepEqual(canMove('design', 'plan', gateFor(input({ stage: 'design' }))), { ok: true });
    const blocked = canMove('design', 'build', gateFor(input({ stage: 'design' })));
    assert.equal(blocked.ok, false);
    assert.equal(canMove('design', 'design', ready).ok, false);
  });

  test('done has no next stage', () => {
    const gate = gateFor(input({ stage: 'done' }));
    assert.equal(gate.next, null);
    assert.equal(gate.ready, false);
  });
});
