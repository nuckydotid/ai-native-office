import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_ROOM } from './shared/workspace/layout.ts';
import { STAGES, WORK_STAGES, firstPageOf, isWorkStage, nextAction, stageLabel, stageOf, stageStates, ticketStage, type FlowData, type TicketLite } from './flow.ts';

const ticket = (over: Partial<TicketLite>): TicketLite => ({ id: `t${over.key ?? 1}`, key: 1, title: 'A ticket', status: 'todo', ...over });

const data = (over: Partial<FlowData>): FlowData => ({
  boardKnown: true,
  tickets: [],
  me: 'g-ada',
  unread: 0,
  ...over,
});

test('the sidebar is the pipeline, then Tools', () => {
  assert.deepEqual(STAGES.map((s) => s.id), ['plan', 'design', 'build', 'test', 'release', 'deploy', 'tools']);
  assert.deepEqual(STAGES.map((s) => s.label), ['Plan', 'Design', 'Build', 'Test', 'Release', 'Deploy', 'Tools']);
  assert.deepEqual(STAGES.find((s) => s.id === 'tools')?.pages.map((p) => p.id), ['docs', 'agents', 'integrations', 'environments', 'activity']);
  assert.deepEqual([...WORK_STAGES], STAGES.filter((s) => s.id !== 'tools').map((s) => s.id));
});

test('pages belong to stages', () => {
  assert.equal(stageOf('plan'), 'plan');
  assert.equal(stageOf('deploy'), 'deploy');
  assert.equal(stageOf('docs'), 'tools');
  assert.equal(stageOf('activity'), 'tools');
  assert.equal(firstPageOf('tools'), 'docs');
  assert.equal(firstPageOf('build'), null);
  assert.equal(isWorkStage('test'), true);
  assert.equal(isWorkStage('tools'), false);
  assert.equal(stageLabel('done'), 'Done');
  assert.equal(stageLabel('release'), 'Release');
});

test('every stage page stands in one of the office’s rooms', () => {
  for (const stage of WORK_STAGES) assert.ok(['plan', 'progress', 'review'].includes(PAGE_ROOM[stage]), `${stage} has a room`);
  assert.equal(PAGE_ROOM.plan, PAGE_ROOM.design, 'planning and design share the Plan Room');
  assert.equal(PAGE_ROOM.build, 'progress', 'building happens in the lobby, among the desks');
});

test('a ticket’s stage is its own, or the one its status implies', () => {
  assert.equal(ticketStage({ status: 'todo', stage: 'design' }), 'design');
  assert.equal(ticketStage({ status: 'todo' }), 'plan');
  assert.equal(ticketStage({ status: 'in_progress' }), 'build');
  assert.equal(ticketStage({ status: 'review' }), 'release');
  assert.equal(ticketStage({ status: 'done' }), 'done');
  assert.equal(ticketStage({ status: 'odd' }), 'plan');
});

test('no stage is ever locked, and each line counts the tickets in it', () => {
  const empty = stageStates(data({ tickets: [] }));
  for (const stage of WORK_STAGES) assert.equal(empty[stage].line, 'No tickets');
  const states = stageStates(data({ tickets: [ticket({ key: 1, stage: 'plan' }), ticket({ key: 2, stage: 'plan' }), ticket({ key: 3, stage: 'test' }), ticket({ key: 4, status: 'done', stage: 'done' })] }));
  assert.equal(states.plan.line, '2 tickets');
  assert.equal(states.plan.count, 2);
  assert.equal(states.test.line, '1 ticket');
  assert.equal(states.deploy.line, 'No tickets');
  assert.equal(states.tools.line, 'Docs · Agents · more');
  assert.equal(stageStates(data({ boardKnown: false })).build.line, '', 'an unreadable board claims nothing');
});

test('tickets made before the pipeline are counted where their status puts them', () => {
  const states = stageStates(data({ tickets: [ticket({ key: 1 }), ticket({ key: 2, status: 'in_progress' }), ticket({ key: 3, status: 'review' })] }));
  assert.equal(states.plan.count, 1);
  assert.equal(states.build.count, 1);
  assert.equal(states.release.count, 1);
});

test('the next step starts a ticket, then carries the one furthest along', () => {
  assert.match(nextAction(data({ tickets: [] })).title, /Plan your first ticket/);
  const one = nextAction(data({ tickets: [ticket({ key: 12, title: 'Dark mode', stage: 'build', status: 'in_progress', assignee: 'g-ada' })] }));
  assert.equal(one.title, 'Continue #12 Dark mode');
  assert.deepEqual(one.target, { stage: 'build', page: 'build', ticket: 't12' });
  assert.match(one.detail, /Developer Agent/);
  const far = nextAction(data({ tickets: [ticket({ key: 1, stage: 'plan' }), ticket({ key: 2, stage: 'release', status: 'review' }), ticket({ key: 3, stage: 'design', status: 'in_progress' })] }));
  assert.equal(far.target.stage, 'release', 'the ticket closest to shipping comes first');
  const idle = nextAction(data({ tickets: [ticket({ status: 'done', stage: 'done' })] }));
  assert.match(idle.title, /Plan the next work/);
});

test('the next step prefers my own ticket over anyone else’s', () => {
  const tickets = [
    ticket({ key: 5, title: 'Theirs', stage: 'deploy', status: 'review', assignee: 'g-bob' }),
    ticket({ key: 6, title: 'Mine', stage: 'design', status: 'in_progress', assignee: 'g-ada' }),
  ];
  assert.equal(nextAction(data({ tickets })).title, 'Continue #6 Mine');
  assert.equal(nextAction(data({ tickets: [tickets[0]] })).title, 'Continue #5 Theirs', 'with none of mine, the furthest one is still useful');
});
