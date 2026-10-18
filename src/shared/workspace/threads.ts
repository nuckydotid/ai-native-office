import type { ThreadError, ThreadState } from './types.ts';

export const THREAD_LIMITS = {
  name: 40,
  branch: 100,
  step: 120,
  error: 300,
  purpose: 600,
  docs: 10,
  /** Live (not done or archived) tabs one person may have, and all together on a server. */
  perOwner: 8,
  total: 100,
} as const;

export const THREAD_STATES: readonly ThreadState[] = ['creating', 'failed', 'intake', 'planned', 'running', 'review', 'done', 'archived'];
export const THREAD_ERRORS: readonly ThreadError[] = [
  'disk_full', 'branch_exists', 'branch_checked_out', 'path_exists', 'not_git', 'no_commits', 'git_lock', 'permission_denied',
  'agy_missing', 'agy_signed_out', 'timeout', 'cancelled', 'unknown',
];

const NEXT: Record<ThreadState, readonly ThreadState[]> = {
  creating: ['intake', 'failed', 'archived'],
  failed: ['creating', 'archived'],
  intake: ['planned', 'running', 'review', 'done', 'archived'],
  planned: ['intake', 'running', 'archived'],
  running: ['review', 'intake', 'done', 'archived'],
  review: ['running', 'intake', 'done', 'archived'],
  done: ['review', 'archived'],
  archived: [],
};

/** Whether a tab may go from one state to another (staying put is always fine: only its step or name changed). */
export function canTransition(from: ThreadState, to: ThreadState): boolean {
  return from === to || NEXT[from].includes(to);
}

/** A tab that still counts against the owner's limit. */
export const isLive = (s: ThreadState) => s !== 'done' && s !== 'archived';

/** Where the Board ticket goes when the tab reaches this state (`null`: leave it where it is). */
export function ticketStatusFor(s: ThreadState): 'in_progress' | 'review' | 'done' | null {
  if (s === 'running') return 'in_progress';
  if (s === 'review') return 'review';
  if (s === 'done') return 'done';
  return null;
}

/**
 * A name Git accepts for a branch, narrowed to what the app creates: letters, digits and `. _ - /`, no `..`, no `@{`, not starting
 * or ending with a separator, not ending in `.lock`. (The app never passes it through a shell, but keeps it plain anyway.)
 */
export function validBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length < 1 || name.length > THREAD_LIMITS.branch) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (/[./]$/.test(name) || name.endsWith('.lock')) return false;
  return !name.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'));
}

/** A short, plain slug for a folder or branch part: `Fix the login bug!` becomes `fix-the-login-bug`. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'work';
}

/** The branch a new tab suggests, from its name (and the ticket key when it starts from one). */
export function suggestBranch(name: string, ticketKey?: number | null): string {
  const slug = slugify(name, 36);
  return ticketKey ? `work/${ticketKey}-${slug}` : `work/${slug}`;
}

/** What a person reads for each way creating a worktree can fail. */
export const THREAD_ERROR_TEXT: Record<ThreadError, string> = {
  disk_full: 'Your Mac is out of space, so the worktree couldn’t be created. Free some space and try again.',
  branch_exists: 'A branch with that name already exists. Pick another name.',
  branch_checked_out: 'That branch is already checked out in another worktree. Pick another branch.',
  path_exists: 'There is already a folder where this worktree should go. Remove it or pick another name.',
  not_git: 'This project isn’t a Git repository yet.',
  no_commits: 'This project has no commits yet. Make a first commit, then open a worktree.',
  git_lock: 'Another Git operation is running in this project. Wait for it to finish and try again.',
  permission_denied: 'The app isn’t allowed to write there. Check the folder’s permissions and try again.',
  agy_missing: 'Antigravity (agy) isn’t installed on this Mac.',
  agy_signed_out: 'Antigravity isn’t signed in. Run agy once in a terminal, then try again.',
  timeout: 'Antigravity took too long. Try again.',
  cancelled: 'Cancelled.',
  unknown: 'The worktree couldn’t be created.',
};

/**
 * Names the reason Git (or a shell) gave for a failed `git worktree add`. Git does not say "No space left on device" when the
 * disk fills: it says it could not write a file, so those messages count as a full disk only when the disk really is nearly full.
 */
export function classifyGitFailure(output: string, opts: { lowDisk?: boolean } = {}): ThreadError {
  const text = output.toLowerCase();
  if (/no space left on device|disk quota exceeded|enospc/.test(text)) return 'disk_full';
  if (/unable to write (file|new index file|loose object)|unable to create temporary file|could not reset index file|write error/.test(text)) {
    return opts.lowDisk ? 'disk_full' : 'unknown';
  }
  if (/a branch named .* already exists/.test(text)) return 'branch_exists';
  if (/is already checked out at|is already used by worktree|already checked out/.test(text)) return 'branch_checked_out';
  if (/index\.lock|another git process/.test(text)) return 'git_lock';
  if (/not a git repository/.test(text)) return 'not_git';
  if (/already exists/.test(text)) return 'path_exists';
  if (/permission denied|operation not permitted/.test(text)) return 'permission_denied';
  return 'unknown';
}
