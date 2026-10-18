import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import { IdTokenSource } from '../src/ai/client.ts';
import { PipelineRefusal } from '../src/pipeline/driver.ts';
import { HttpPipelineDriver } from '../src/pipeline/http.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the client of the private pipeline service', () => {
  test('talks REST, carries an ID token, and maps a refusal to a sentence', async () => {
    const calls: { url: string; method: string; body: unknown; auth?: string }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('metadata.google.internal')) return new Response('id-token-123');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: href, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization });
      if (href.endsWith('/v1/repo')) return json({ rev: 'main@2', files: [{ path: 'sample-app/src/App.tsx', sha: 'a'.repeat(64), size: 10 }] });
      if (href.includes('/v1/repo/file') && !href.includes('missing')) return json({ path: 'sample-app/src/App.tsx', content: 'export {};\n' });
      if (href.includes('/v1/repo/file')) return json({ error: 'not_found', message: 'That file is not on main.' }, 404);
      if (href.endsWith('/v1/jobs') && init?.method === 'POST') return json({ job: { id: 'job-1', state: 'queued' } }, 201);
      if (href.includes('/v1/status')) return json({ enabled: true, killSwitch: false, jobsLeftToday: 3, jobsLeftThisHour: 2, concurrent: 0, maxConcurrent: 2, rolloutsLeftToday: 1, scansLeftToday: 1 });
      if (href.includes('/v1/rollouts/ro-1/step')) return json({ error: 'locked', message: 'Another rollout is still going.' }, 409);
      return json({ error: 'not_found', message: 'nope' }, 404);
    }) as unknown as typeof fetch;

    const driver = new HttpPipelineDriver({ base: 'https://pipeline.example', auth: 'google', tokens: new IdTokenSource(fetchFn), fetchFn });
    const repo = await driver.repo();
    assert.equal(repo.rev, 'main@2');
    assert.equal(await driver.readFile('sample-app/src/App.tsx'), 'export {};\n');
    assert.equal(await driver.readFile('sample-app/missing.ts'), null);
    const job = await driver.startJob({ ticket: 't-1', ticketKey: 1, kind: 'build', inputDigest: 'a'.repeat(64), files: [], startedBy: { id: 'g-1', name: 'Ada' } });
    assert.equal(job.id, 'job-1');
    const status = await driver.status('g-1');
    assert.equal(status.jobsLeftToday, 3);

    calls.length = 0;
    await assert.rejects(driver.stepRollout('ro-1', { id: 'g-1', name: 'Ada' }), (e: unknown) => {
      assert.ok(e instanceof PipelineRefusal);
      assert.equal(e.code, 'locked');
      assert.equal(e.status, 409);
      assert.match(e.message, /Another rollout/);
      return true;
    });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].auth, 'Bearer id-token-123');
  });
});
