import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Chip, Listbox, ListboxItem, Spinner, Tab, Tabs, Tooltip } from '@heroui/react';
import type { Project } from '../project.ts';
import type { AuthUser } from '../auth';
import { Hammer, FlaskConical, Kanban, Package, Palette, Rocket, Wrench } from '../ui';
import { useNav } from '../sync/nav.ts';
import { firstPageOf, isWorkStage, stageOf, stageStates, STAGES, ticketStage, type PageId, type StageId, type WorkStage } from '../flow.ts';
import { useFlowData } from '../flowData.ts';
import { useBoard } from '../board/store.ts';
import { usePipeline } from '../pipeline/store.ts';
import { PAGE_ROOM } from '../shared/workspace/layout.ts';

// The agents page is a form with a live preview of the character: load it only when the person first opens it.
const AgentsView = lazy(() => import('../agents/AgentsView').then((m) => ({ default: m.AgentsView })));
// The office brings a graphics engine with it: load it only when the person first opens a stage page.
const OfficeView = lazy(() => import('../office/OfficeView').then((m) => ({ default: m.OfficeView })));
const StagePanel = lazy(() => import('../pipeline/StagePanel').then((m) => ({ default: m.StagePanel })));
const DocsView = lazy(() => import('../docs/DocsView').then((m) => ({ default: m.DocsView })));
const IntegrationsView = lazy(() => import('../tools/IntegrationsView').then((m) => ({ default: m.IntegrationsView })));
const EnvironmentsView = lazy(() => import('../tools/EnvironmentsView').then((m) => ({ default: m.EnvironmentsView })));
const ActivityView = lazy(() => import('../tools/ActivityView').then((m) => ({ default: m.ActivityView })));

/** True on a phone-sized screen (below Tailwind's `sm`), where the ticket panel and the office cannot sit side by side. */
function useNarrow(): boolean {
  const query = '(max-width: 639px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const change = () => setNarrow(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return narrow;
}

/** The icon of each sidebar stage. */
const STAGE_ICON: Record<StageId, ReactNode> = {
  plan: <Kanban size={18} />,
  design: <Palette size={18} />,
  build: <Hammer size={18} />,
  test: <FlaskConical size={18} />,
  release: <Package size={18} />,
  deploy: <Rocket size={18} />,
  tools: <Wrench size={18} />,
};

const FIRST_PAGES: Record<StageId, PageId> = { plan: 'plan', design: 'design', build: 'build', test: 'test', release: 'release', deploy: 'deploy', tools: 'docs' };

const Loading = ({ what, hidden = '' }: { what: string; hidden?: string }) => (
  <div className={`flex flex-1 items-center justify-center gap-2 text-small text-foreground-500 ${hidden}`}>
    <Spinner size="sm" /> Opening {what}…
  </div>
);

/**
 * The open workspace: a sidebar that is the delivery pipeline (Plan, Design, Build, Test, Release, Deploy) and Tools (Docs, Agents,
 * Integrations, Environments, Activity). The six stage pages share one workbench, the stage panel beside the office; the rules
 * are in `src/flow.ts` and the gates in `src/shared/pipeline/gates.ts`.
 */
export function ProjectShell({ project, user }: { project: Project; user?: AuthUser }) {
  const [stage, setStage] = useState<StageId>('plan');
  /** The page each stage shows; remembered while the project is open. */
  const [pages, setPages] = useState<Record<StageId, PageId>>(FIRST_PAGES);
  /** Pages that have been opened once stay mounted, so drafts, logs and agent runs survive a trip elsewhere. */
  // (The demo opens on Plan, so the first thing in the window is the ticket panel and the office, not an empty page.)
  const [opened, setOpened] = useState<Partial<Record<PageId, true>>>({ plan: true });
  /** The stage the workbench is showing; it keeps its value while Tools shows. */
  const [workStage, setWorkStage] = useState<WorkStage>('plan');

  // The demo is meant to be opened on a phone too: there the ticket panel and the office take turns instead of sharing the width.
  const narrow = useNarrow();
  const split = narrow;
  const [pane, setPane] = useState<'board' | 'office'>('board');

  const flow = useFlowData();
  const states = useMemo(() => stageStates(flow), [flow]);
  const unread = flow.unread;

  /** Opens one page: its stage comes forward, the sub-tab is set, and the page is mounted from now on. */
  const showPage = (page: PageId) => {
    setOpened((all) => ({ ...all, [page]: true }));
    setPages((all) => ({ ...all, [stageOf(page)]: page }));
    setStage(stageOf(page));
    if (isWorkStage(page)) setWorkStage(page);
  };

  /** Goes to a stage: its remembered page, or the first one. */
  const showStage = (id: StageId) => showPage(pages[id] ?? firstPageOf(id) ?? FIRST_PAGES[id]);

  /** A "Go" button or a link to a ticket: the stage it is in comes forward with the ticket open. */
  const showTicket = (page: PageId, ticket?: string) => {
    showPage(page);
    if (ticket) usePipeline.getState().select(ticket);
  };

  // A link from one page to another (a ticket to its doc, a doc to its ticket): open the page it points at.
  const target = useNav((s) => s.target);
  useEffect(() => {
    if (!target) return;
    if (target.page === 'board') {
      // The ticket's stage decides the page it belongs to.
      const issue = useBoard.getState().snapshot?.issues.find((i) => i.id === target.issue || String(i.key) === target.issue);
      const at = issue ? ticketStage({ status: issue.status, stage: issue.pipeline?.stage }) : 'plan';
      showTicket(at === 'done' ? 'deploy' : at, issue?.id);
    } else {
      showPage('docs');
    }
    useNav.getState().clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handlers only set state
  }, [target]);

  const activePage = pages[stage];
  const stageInfo = STAGES.find((s) => s.id === stage);
  const showTabs = (stageInfo?.pages.length ?? 0) > 1;
  const onWork = isWorkStage(stage);
  const workOpened = onWork || Object.keys(opened).some((p) => isWorkStage(p));

  const visible = (page: PageId) => stage === stageOf(page) && activePage === page;
  const hidden = (page: PageId) => (visible(page) ? '' : 'hidden');

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="relative z-10 hidden w-56 shrink-0 flex-col justify-between bg-content1 p-3 shadow-medium sm:flex" aria-label="Project pages">
        <div className="flex flex-col gap-4">
          <div className="px-2 pt-1">
            <Tooltip content={project.name} placement="right" delay={400}>
              <p className="truncate text-small font-semibold">{project.name}</p>
            </Tooltip>
            <p className="truncate text-tiny text-foreground-400">Demo workspace</p>
          </div>
          <Listbox
            aria-label="Project pages"
            variant="flat"
            color="primary"
            selectionMode="single"
            disallowEmptySelection
            itemClasses={{ base: 'data-[selected=true]:bg-primary/20 data-[selected=true]:text-primary' }}
            selectedKeys={[stage]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (STAGES.some((s) => s.id === next)) showStage(next as StageId);
            }}
          >
            {STAGES.map((s) => {
              const state = states[s.id];
              return (
                <ListboxItem
                  key={s.id}
                  startContent={STAGE_ICON[s.id]}
                  hideSelectedIcon
                  textValue={s.label}
                  description={state.line || undefined}
                  endContent={
                    // Messages that arrive while Tools covers the office are counted on the stage the person will come back to.
                    s.id === workStage && !onWork && unread > 0 ? (
                      <Chip size="sm" color="primary" variant="solid" aria-label={`${unread} unread messages`} classNames={{ base: 'h-5 min-w-5 px-1', content: 'px-0 text-tiny' }}>
                        {unread > 99 ? '99+' : unread}
                      </Chip>
                    ) : undefined
                  }
                >
                  {s.label}
                </ListboxItem>
              );
            })}
          </Listbox>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="overflow-x-auto bg-content1 px-4 py-2 shadow-small sm:hidden">
          {/* The sidebar is hidden on a narrow screen: the stages are tabs across the top instead (seven, so they scroll). */}
          <Tabs size="sm" aria-label="Project pages" selectedKey={stage} onSelectionChange={(key) => showStage(key as StageId)} classNames={{ tabList: 'h-8', tab: 'h-7 px-2 text-tiny', cursor: 'rounded-small' }}>
            {STAGES.map((s) => (
              <Tab key={s.id} title={s.label} />
            ))}
          </Tabs>
        </div>
        {showTabs && (
          <div className="flex items-center gap-2 overflow-x-auto bg-content1 px-3 pt-2">
            <Tabs
              size="sm"
              aria-label={`${stageInfo?.label ?? ''} pages`}
              selectedKey={activePage}
              onSelectionChange={(key) => showPage(key as PageId)}
              classNames={{ tabList: 'h-7', tab: 'h-6 px-2 text-tiny', cursor: 'rounded-small' }}
            >
              {(stageInfo?.pages ?? []).map((p) => (
                <Tab key={p.id} title={p.label} />
              ))}
            </Tabs>
          </div>
        )}

        {/* The six stage pages share one workbench: the stage panel beside the office, which keeps running while Tools shows. */}
        {workOpened && (
          <div className={`min-h-0 flex-1 ${onWork ? 'flex' : 'hidden'} ${split ? 'flex-col' : ''}`}>
            {split && (
              <div className="bg-content1 px-3 pb-2">
                <Tabs size="sm" fullWidth aria-label="Tickets or office" selectedKey={pane} onSelectionChange={(key) => setPane(key as 'board' | 'office')} classNames={{ tabList: 'h-8', tab: 'h-7 px-2 text-tiny', cursor: 'rounded-small' }}>
                  <Tab key="board" title="Tickets" />
                  <Tab key="office" title="Office and chat" />
                </Tabs>
              </div>
            )}
            {/* Side by side, the wrappers are not boxes at all (`contents`); on a phone each one fills the screen in its turn. */}
            <div className={split ? (pane === 'board' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden') : 'contents'}>
              <Suspense fallback={<div className="flex w-full shrink-0 items-center justify-center gap-2 bg-content1 text-small text-foreground-500 shadow-small sm:w-[26rem]"><Spinner size="sm" /> Opening the tickets…</div>}>
                <StagePanel
                  project={project}
                  stage={workStage}
                  onGo={(_stage, page, ticket) => showTicket(page, ticket)}
                  onMoved={(to, ticket) => (to === 'done' ? usePipeline.getState().select(null) : showTicket(to, ticket))}
                />
              </Suspense>
            </div>
            <div className={split ? (pane === 'office' ? 'flex min-h-0 min-w-0 flex-1' : 'hidden') : 'contents'}>
              <Suspense fallback={<div className="flex flex-1 items-center justify-center gap-2 text-small text-foreground-500"><Spinner size="sm" /> Opening the office…</div>}>
                <OfficeView project={project} user={user} visible={onWork && (!split || pane === 'office')} page={PAGE_ROOM[workStage]} />
              </Suspense>
            </div>
          </div>
        )}

        {opened.docs && (
          <Suspense fallback={<Loading what="the docs" hidden={hidden('docs')} />}>
            <DocsView project={project} visible={visible('docs')} />
          </Suspense>
        )}
        {opened.agents && (
          <Suspense fallback={<Loading what="the agents" hidden={hidden('agents')} />}>
            <AgentsView project={project} visible={visible('agents')} />
          </Suspense>
        )}
        {opened.integrations && (
          <Suspense fallback={<Loading what="the integrations" hidden={hidden('integrations')} />}>
            <IntegrationsView visible={visible('integrations')} />
          </Suspense>
        )}
        {opened.environments && (
          <Suspense fallback={<Loading what="the environments" hidden={hidden('environments')} />}>
            <EnvironmentsView visible={visible('environments')} />
          </Suspense>
        )}
        {opened.activity && (
          <Suspense fallback={<Loading what="the activity" hidden={hidden('activity')} />}>
            <ActivityView visible={visible('activity')} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
