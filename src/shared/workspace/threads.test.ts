import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PROTOCOL_VERSION, parseClientMsg } from './protocol.ts';
import {
  THREAD_LIMITS, THREAD_STATES, canTransition, classifyGitFailure, isLive, slugify, suggestBranch, ticketStatusFor, validBranchName,
} from './threads.ts';

describe('worktree tab states', () => {
  test('a tab only moves forward the ways the flow allows', () => {
    assert.ok(canTransition('creating', 'intake'));
    assert.ok(canTransition('creating', 'failed'));
    assert.ok(canTransition('failed', 'creating'), 'Try again');
    assert.ok(canTransition('intake', 'planned'));
    assert.ok(canTransition('planned', 'running'));
    assert.ok(canTransition('running', 'review'));
    assert.ok(canTransition('review', 'running'), 'a follow-up');
    assert.ok(canTransition('done', 'archived'));
    assert.equal(canTransition('creating', 'running'), false, 'no agents before the worktree exists');
    assert.equal(canTransition('failed', 'running'), false);
    assert.equal(canTransition('archived', 'intake'), false);
    for (const s of THREAD_STATES) assert.ok(canTransition(s, s), 'staying put (a new step label) is always fine');
  });

  test('only open tabs count, and the ticket follows the work', () => {
    assert.equal(isLive('running'), true);
    assert.equal(isLive('failed'), true, 'a failed tab is still there to retry or remove');
    assert.equal(isLive('done'), false);
    assert.equal(isLive('archived'), false);
    assert.equal(ticketStatusFor('intake'), null);
    assert.equal(ticketStatusFor('planned'), null);
    assert.equal(ticketStatusFor('running'), 'in_progress');
    assert.equal(ticketStatusFor('review'), 'review');
    assert.equal(ticketStatusFor('done'), 'done');
  });
});

describe('branch names and slugs', () => {
  test('accepts ordinary branches and refuses what Git or a shell would trip on', () => {
    for (const ok of ['main', 'work/12-fix-login', 'feature/a.b_c-d', 'v1.2']) assert.ok(validBranchName(ok), ok);
    for (const bad of ['', '-x', '--force', 'a..b', 'a//b', 'a/', '.hidden', 'a/.b', 'x.lock', 'a b', 'a;rm', 'a$(x)', 'a@{1}', 'é', 'x'.repeat(101)]) {
      assert.equal(validBranchName(bad), false, JSON.stringify(bad));
    }
    assert.equal(validBranchName(5), false);
  });

  test('slugs are plain and never empty', () => {
    assert.equal(slugify('Fix the login bug!'), 'fix-the-login-bug');
    assert.equal(slugify('  Ünïcode — dashes  '), 'unicode-dashes');
    assert.equal(slugify('!!!'), 'work');
    assert.ok(slugify('x'.repeat(100)).length <= 40);
    assert.equal(suggestBranch('Add dark mode', 12), 'work/12-add-dark-mode');
    assert.equal(suggestBranch('Add dark mode'), 'work/add-dark-mode');
    assert.ok(validBranchName(suggestBranch('Ünïcode / slash ../..', 3)));
  });
});

describe('why creating a worktree failed', () => {
  test('a full disk is named even though Git does not say so', () => {
    // What Git printed on a 3 MB volume (a real run): no mention of "space".
    const real = "Preparing worktree (new branch 'spike')\r\nerror: unable to write file blob.bin\r\nfatal: Could not reset index file to revision 'HEAD'.\r\n";
    assert.equal(classifyGitFailure(real, { lowDisk: true }), 'disk_full');
    assert.equal(classifyGitFailure(real, { lowDisk: false }), 'unknown', 'not blamed on the disk when there is room');
    assert.equal(classifyGitFailure('fatal: write error: No space left on device'), 'disk_full');
  });

  test('the other reasons Git gives', () => {
    assert.equal(classifyGitFailure("fatal: a branch named 'work/x' already exists"), 'branch_exists');
    assert.equal(classifyGitFailure("fatal: 'work/x' is already checked out at '/Users/a/proj'"), 'branch_checked_out');
    assert.equal(classifyGitFailure("fatal: 'work/x' is already used by worktree at '/Users/a/proj'"), 'branch_checked_out');
    assert.equal(classifyGitFailure("fatal: '/Users/a/.worktrees/p/x' already exists"), 'path_exists');
    assert.equal(classifyGitFailure("fatal: Unable to create '/p/.git/index.lock': File exists."), 'git_lock');
    assert.equal(classifyGitFailure('fatal: not a git repository (or any of the parent directories): .git'), 'not_git');
    assert.equal(classifyGitFailure("fatal: could not create directory of '/x': Permission denied"), 'permission_denied');
    assert.equal(classifyGitFailure('something else'), 'unknown');
  });
});

describe('worktree messages', () => {
  const ok = (m: unknown) => parseClientMsg(JSON.stringify(m));
  test('a new tab needs a valid branch and base, and its name is cleaned', () => {
    const good = { t: 'thread.new', reqId: 'r1', room: 'z-ann', name: '  Fix login ', branch: 'work/fix-login', base: 'main' };
    const m = ok(good);
    assert.equal(m?.t, 'thread.new');
    assert.equal(m?.t === 'thread.new' ? m.name : '', 'Fix login');
    assert.equal(ok({ ...good, branch: '--force' }), null);
    assert.equal(ok({ ...good, base: 'a b' }), null);
    assert.equal(ok({ ...good, name: '   ' }), null);
    assert.equal(ok({ ...good, name: 'x'.repeat(THREAD_LIMITS.name * 3) }), null);
    assert.equal(ok({ ...good, reqId: 'has space' }), null);
  });

  test('a patch is limited to what an owner may change, and refuses anything else', () => {
    const patch = (p: unknown) => ok({ t: 'thread.patch', id: 't1', patch: p });
    assert.ok(patch({ state: 'intake', step: 'Ready', error: null }));
    assert.ok(patch({ error: { code: 'disk_full', message: 'Out of space' } }));
    assert.ok(patch({ ticket: 'i-abc-123', docs: ['p-1', 'p-2', 'p-1'] }));
    assert.equal(patch({}), null, 'an empty patch changes nothing');
    assert.equal(patch({ state: 'exploded' }), null);
    assert.equal(patch({ owner: 'someone-else' }), null, 'the owner is not changed this way');
    assert.equal(patch({ session: 'x' }), null);
    assert.equal(patch({ error: { code: 'nope', message: 'x' } }), null);
    assert.equal(patch({ docs: Array.from({ length: THREAD_LIMITS.docs + 1 }, (_, i) => `p-${i}`) }), null);
  });

  test('chat in a tab names the tab, and archiving needs an id', () => {
    const chat = ok({ t: 'chat', text: 'hello', room: 'z-ann', thread: 't1' });
    assert.equal(chat?.t === 'chat' ? chat.thread : null, 't1');
    assert.equal(ok({ t: 'chat', text: 'hello', thread: 'bad id' }), null);
    assert.equal(ok({ t: 'thread.archive', id: 't1' })?.t, 'thread.archive');
    assert.equal(ok({ t: 'thread.archive' }), null);
  });

  test('this is protocol 8', () => {
    assert.equal(PROTOCOL_VERSION, 8);
  });
});
