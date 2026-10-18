import type { TicketPipeline } from '../pipeline/types.ts';

/**
 * The board: issues for one project, the Jira-shaped half of collaboration. The team server stores and validates them;
 * the studio's Plan / In Progress / In Review pages read and write them over REST (`/board`).
 */

/** Where a ticket stands: to do (Plan), being worked on (assigned), with a pull request (In Review), or done. */
export const ISSUE_STATUSES = ['todo', 'in_progress', 'review', 'done'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export interface Issue {
  id: string;
  /** The number people say (`#12`), unique on the board. 0 on a ticket saved before numbers existed: the server numbers those. */
  key: number;
  /** One line: what needs doing. */
  title: string;
  /** What it means, in Markdown. */
  body: string;
  status: IssueStatus;
  priority: IssuePriority;
  /** uid of the person it is for, or null (nobody yet). In Progress requires one. */
  assignee: string | null;
  labels: string[];
  /** Story points; 0 means not estimated. */
  points: number;
  /** Sort key inside a status column: lower comes first, ties break by id. */
  order: number;
  /** Docs (page ids) the work draws on. */
  docs: string[];
  /** The worktree tab working on it, the branch it works on, and the pull request when there is one. */
  thread: string | null;
  branch: string | null;
  /** The pull request's address. */
  pr: string | null;
  /** What the pull request is now, as the owner's app last read it from GitHub (`pr` has its address). */
  prInfo?: PullRequestInfo | null;
  /** Links the work draws on, and pictures (asset ids on this team server). Absent on a ticket from a server older than version 6. */
  links?: IssueLink[];
  images?: string[];
  /** Every worktree tab that has worked on it, oldest first (`thread` is the current one): its chat is the ticket's history. */
  threads?: string[];
  /** What happened to it, newest last (written by the server). */
  activity?: IssueEvent[];
  /**
   * Where the ticket is in the delivery pipeline. Present on a ticket made while the pipeline is on; the stage decides `status`
   * (see `statusForStage`) and changes only through the server's `advanceStage`, never through an edit.
   */
  pipeline?: TicketPipeline;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

export interface IssueLink {
  url: string;
  title: string;
}

export const PR_STATES = ['draft', 'open', 'merged', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

export interface PullRequestInfo {
  number: number;
  title: string;
  state: PrState;
  updatedAt: number;
}

export interface IssueEvent {
  at: number;
  by: string;
  kind: 'created' | 'status' | 'work' | 'pr' | 'edit';
  text: string;
}

/** Who an issue can be assigned to. Names only: the members routes are the only place emails are read out, and only to admins. */
export interface BoardPerson {
  uid: string;
  name: string;
}

export interface BoardSnapshot {
  issues: Issue[];
  people: BoardPerson[];
  /** The signed-in person, so a screen can tell their own issues from everyone else's. */
  you: string;
  /** The founder and admins may delete anyone's issue; the server decides, the screen only hides what would be refused. */
  canModerate: boolean;
}

export const BOARD_LIMITS = {
  title: 200,
  body: 8000,
  label: 40,
  labels: 8,
  /** 0 means not estimated. */
  pointsMax: 100,
  /** Per project. */
  issues: 500,
  /** Ids the app is expected to send back (a uid). */
  id: 160,
  /** Docs linked to one issue, and the longest branch name and pull request address kept on one. */
  docs: 10,
  branch: 100,
  pr: 300,
  /** Links, pictures, tabs and history kept on one issue, a link's title, and a picture's size. */
  links: 10,
  linkTitle: 80,
  linkUrl: 300,
  images: 10,
  threads: 10,
  activity: 50,
  imageBytes: 1024 * 1024,
  projectImageBytes: 50 * 1024 * 1024,
  projectImages: 200,
  /** Sort keys stay well inside a double. */
  order: 1e15,
} as const;
