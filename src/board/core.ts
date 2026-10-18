import type { BoardPerson, Issue, IssuePriority, IssueStatus } from '../shared/board/types.ts';

/** What the screens call each status; the ids stay the protocol's. */
export const STATUS_LABELS: Record<IssueStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'In review',
  done: 'Done',
};

export const PRIORITY_META: Record<IssuePriority, { label: string; color: 'default' | 'primary' | 'warning' | 'danger' }> = {
  low: { label: 'Low', color: 'default' },
  medium: { label: 'Medium', color: 'primary' },
  high: { label: 'High', color: 'warning' },
  urgent: { label: 'Urgent', color: 'danger' },
};

/** The tickets of one page, in board order (lower `order` first, ties by id). */
export function column(issues: Issue[], status: IssueStatus): Issue[] {
  return issues
    .filter((i) => i.status === status)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const assigneeName = (people: BoardPerson[], uid: string | null) => (uid ? (people.find((p) => p.uid === uid)?.name ?? 'Someone who left the team') : null);

/** Whether a pull request is open (or a draft) — what the In Review page lists. */
export const prOpen = (issue: Pick<Issue, 'pr' | 'prInfo'>): boolean => !!issue.pr && (!issue.prInfo || issue.prInfo.state === 'open' || issue.prInfo.state === 'draft');
