// The app's flow rules, pure and unit-tested: which page is open, where each ticket stands, and the one next step.
// Everything the sidebar and the stage panel's next-step card show comes from here — see docs/flow.md.
// What lets a ticket leave a stage (its gate) is `src/shared/pipeline/gates.ts`, which the web service runs too.

import type { PipelineStage } from './shared/pipeline/types.ts';

/** The six stages a ticket walks through, left to right in the sidebar. */
export type WorkStage = Exclude<PipelineStage, 'done'>;
export type StageId = WorkStage | 'tools';
export type ToolPage = 'docs' | 'agents' | 'integrations' | 'environments' | 'activity';
export type PageId = WorkStage | ToolPage;

export const WORK_STAGES: readonly WorkStage[] = ['plan', 'design', 'build', 'test', 'release', 'deploy'];
export const isWorkStage = (id: string): id is WorkStage => (WORK_STAGES as readonly string[]).includes(id);

/** The sidebar, in order, with the sub-tabs under the page that has more than one view. */
export const STAGES: { id: StageId; label: string; pages: { id: PageId; label: string }[] }[] = [
  { id: 'plan', label: 'Plan', pages: [] },
  { id: 'design', label: 'Design', pages: [] },
  { id: 'build', label: 'Build', pages: [] },
  { id: 'test', label: 'Test', pages: [] },
  { id: 'release', label: 'Release', pages: [] },
  { id: 'deploy', label: 'Deploy', pages: [] },
  {
    id: 'tools',
    label: 'Tools',
    pages: [
      { id: 'docs', label: 'Docs' },
      { id: 'agents', label: 'Agents' },
      { id: 'integrations', label: 'Integrations' },
      { id: 'environments', label: 'Environments' },
      { id: 'activity', label: 'Activity' },
    ],
  },
];

export const stageOf = (page: PageId): StageId => (STAGES.find((s) => s.pages.some((p) => p.id === page))?.id ?? (page as StageId));
export const firstPageOf = (stage: StageId): PageId | null => STAGES.find((s) => s.id === stage)?.pages[0]?.id ?? null;
export const stageLabel = (stage: PipelineStage): string => (stage === 'done' ? 'Done' : (STAGES.find((s) => s.id === stage)?.label ?? stage));

export interface TicketLite {
  id: string;
  key: number;
  title: string;
  status: 'todo' | 'in_progress' | 'review' | 'done' | string;
  /** Where the ticket is in the delivery pipeline. Absent on a ticket made before the pipeline: its status stands in. */
  stage?: PipelineStage;
  assignee?: string | null;
}

const FROM_STATUS: Record<string, PipelineStage> = { todo: 'plan', in_progress: 'build', review: 'release', done: 'done' };

/** The stage a ticket is in: its own, or the one its status implies for a ticket that has none. */
export const ticketStage = (t: Pick<TicketLite, 'status' | 'stage'>): PipelineStage => t.stage ?? FROM_STATUS[t.status] ?? 'plan';

export interface FlowData {
  /** The board snapshot could be read. When it could not, no line claims a count. */
  boardKnown: boolean;
  tickets: TicketLite[];
  /** The signed-in person's uid (from the board snapshot). */
  me: string | null;
  unread: number;
}

export interface StageState {
  id: StageId;
  /** How many tickets are in the stage (0 for Tools). */
  count: number;
  /** One line of state for the sidebar. */
  line: string;
}

/** Every stage's sidebar line. No stage is ever locked: a stage page with nothing in it says what to do instead. */
export function stageStates(data: FlowData): Record<StageId, StageState> {
  const counts = new Map<PipelineStage, number>();
  for (const t of data.tickets) counts.set(ticketStage(t), (counts.get(ticketStage(t)) ?? 0) + 1);
  const states = {} as Record<StageId, StageState>;
  for (const id of WORK_STAGES) {
    const count = counts.get(id) ?? 0;
    states[id] = { id, count, line: !data.boardKnown ? '' : count === 0 ? 'No tickets' : `${count} ${count === 1 ? 'ticket' : 'tickets'}` };
  }
  states.tools = { id: 'tools', count: 0, line: 'Docs · Agents · more' };
  return states;
}

export interface NextAction {
  title: string;
  detail: string;
  /** Where the one button goes, and the ticket it selects there. */
  target: { stage: StageId; page: PageId; ticket?: string };
}

/** What a person does in each stage, in one sentence. */
export const STAGE_HINT: Record<WorkStage, string> = {
  plan: 'Ask the Planner Agent for a spec and accept it.',
  design: 'Ask the Designer Agent for a design, or accept “No UI change”.',
  build: 'Ask the Developer Agent for a change set, accept it and run the build.',
  test: 'Run the unit and end-to-end tests; the QA Agent can add more.',
  release: 'Build the release image, scan it and approve the pack.',
  deploy: 'Roll it out to production, step by step, and watch the checks.',
};

/** The single next step: start a ticket, or carry the one furthest along (mine first) through its stage. */
export function nextAction(data: FlowData): NextAction {
  if (data.boardKnown && data.tickets.length === 0) {
    return { title: 'Plan your first ticket', detail: 'Write down what you want to build; the Planner Agent can turn it into a spec.', target: { stage: 'plan', page: 'plan' } };
  }
  const open = data.tickets.filter((t) => ticketStage(t) !== 'done');
  const furthest = (list: TicketLite[]) => [...list].sort((a, b) => WORK_STAGES.indexOf(ticketStage(b) as WorkStage) - WORK_STAGES.indexOf(ticketStage(a) as WorkStage) || a.key - b.key)[0];
  const pick = furthest(open.filter((t) => data.me && t.assignee === data.me)) ?? furthest(open);
  if (pick) {
    const stage = ticketStage(pick) as WorkStage;
    return { title: `Continue #${pick.key} ${pick.title}`, detail: STAGE_HINT[stage], target: { stage, page: stage, ticket: pick.id } };
  }
  return { title: 'Plan the next work', detail: 'Add a ticket in Plan when you are ready.', target: { stage: 'plan', page: 'plan' } };
}
