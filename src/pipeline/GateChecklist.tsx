import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react';
import { stageLabel } from '../flow.ts';
import type { Gate, GateCheck } from '../shared/pipeline/gates.ts';
import { PIPELINE_STAGES, stageIndex } from '../shared/pipeline/types.ts';
import type { PipelineStage } from '../shared/pipeline/types.ts';
import { Hint, StatusTimeline, type TimelineItem } from '../ui';
import { ArrowRight, Undo2 } from '../ui/lucide';

/** A check that is not met yet is waiting (a job is running), failed (a job did not pass), or simply not done. */
function itemOf(check: GateCheck): TimelineItem {
  const running = /running/i.test(check.detail ?? '');
  const failed = !check.ok && /failed|timed out|cancelled|has not passed|found .* issues|rolled back/i.test(check.detail ?? '');
  return { id: check.id, label: check.label, detail: check.ok ? undefined : check.detail, status: check.ok ? 'done' : running ? 'active' : failed ? 'failed' : 'todo' };
}

/**
 * What stands between a ticket and the next stage, in the gate's own words, and the one button that moves it. The rules are the
 * shared gates (`gateFor`), the same ones the web service enforces when the button is pressed: the checklist can never promise more
 * than the server will allow.
 */
export function GateChecklist({
  stage,
  gate,
  busy,
  onAdvance,
  onBack,
}: {
  stage: PipelineStage;
  gate: Gate;
  busy: boolean;
  onAdvance: (to: PipelineStage) => void;
  onBack: (to: PipelineStage) => void;
}) {
  const next = gate.next;
  const earlier = PIPELINE_STAGES.filter((s) => stageIndex(s) < stageIndex(stage));
  const blocker = gate.checks.find((c) => !c.ok);
  const label = next === 'done' ? 'Approve & finish' : next ? `Approve & advance to ${stageLabel(next)}` : 'Done';
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-medium bg-default-50 p-3">
      <p className="text-small font-semibold">{gate.ready ? `Ready to leave ${stageLabel(stage)}` : `To leave ${stageLabel(stage)}`}</p>
      <StatusTimeline aria-label={`What ${stageLabel(stage)} needs`} items={gate.checks.map(itemOf)} />
      {next ? (
        <div className="flex flex-wrap items-center gap-2">
          <Hint label={blocker?.detail ?? blocker?.label ?? ''} isHidden={gate.ready}>
            <Button color="primary" size="sm" isDisabled={!gate.ready} isLoading={busy} endContent={<ArrowRight size={14} />} onPress={() => onAdvance(next)}>
              {label}
            </Button>
          </Hint>
          {earlier.length > 0 && (
            <Dropdown>
              <DropdownTrigger>
                <Button size="sm" variant="flat" startContent={<Undo2 size={14} />}>
                  Send back
                </Button>
              </DropdownTrigger>
              <DropdownMenu aria-label="Send the ticket back to an earlier stage" onAction={(key) => onBack(key as PipelineStage)}>
                {earlier.map((s) => (
                  <DropdownItem key={s}>{stageLabel(s)}</DropdownItem>
                ))}
              </DropdownMenu>
            </Dropdown>
          )}
        </div>
      ) : (
        <p className="text-tiny text-foreground-500">This ticket is done.</p>
      )}
    </div>
  );
}
