import { Button, Chip } from '@heroui/react';
import type { Environment, Rollout, RolloutState } from '../shared/pipeline/types.ts';
import { Hint, StatusTimeline, TrafficBar, type TimelineItem, type TrafficSegment } from '../ui';
import { Rocket, Undo2 } from '../ui/lucide';
import { usePipeline } from './store.ts';

const STATE_LABEL: Record<RolloutState, string> = {
  candidate: 'Candidate',
  canary: 'Canary',
  promoting: 'Promoting',
  complete: 'Complete',
  rolled_back: 'Rolled back',
  paused: 'Paused',
  failed: 'Failed',
};
const STATE_TONE: Record<RolloutState, 'default' | 'primary' | 'success' | 'warning' | 'danger'> = {
  candidate: 'default',
  canary: 'primary',
  promoting: 'primary',
  complete: 'success',
  rolled_back: 'danger',
  paused: 'warning',
  failed: 'danger',
};

const ENV_LABEL: Record<Environment, string> = { staging: 'Staging', production: 'Production' };

/** The traffic split of a rollout: the new revision against the one it replaces. */
export function splitOf(r: Rollout): TrafficSegment[] {
  const rest = Math.max(0, 100 - r.trafficPct);
  const out: TrafficSegment[] = [{ id: 'new', label: r.revision, percent: r.trafficPct, color: r.state === 'rolled_back' ? 'danger' : 'primary' }];
  if (rest > 0 || r.state === 'rolled_back') out.push({ id: 'old', label: r.previous ?? 'previous revision', percent: r.state === 'rolled_back' ? 100 : rest, color: 'default' });
  return out;
}

/** One reading per traffic step the plan lists: done with what was measured, failed with why, or still ahead. */
export function stepsOf(r: Rollout): TimelineItem[] {
  return r.plan.map((percent, i) => {
    const check = r.checks.find((c) => c.percent === percent);
    const status: TimelineItem['status'] = check ? (check.ok ? 'done' : 'failed') : r.state === 'rolled_back' || r.state === 'failed' ? 'todo' : i === r.step + 1 ? 'active' : 'todo';
    const detail = check
      ? check.ok
        ? `${check.requests} requests · ${(check.errorRate * 100).toFixed(1)}% errors · p95 ${Math.round(check.p95Ms)} ms`
        : (check.reason ?? 'A check failed.')
      : i === r.step + 1 && (r.state === 'candidate' || r.state === 'canary')
        ? 'Next step'
        : undefined;
    return { id: `${r.id}-${percent}`, label: `${percent}% of traffic`, detail, status };
  });
}

/**
 * A rollout in the open: where the traffic is, what each step measured, and the buttons for the next step and the way back. Whether
 * a step is healthy is decided by thresholds (the policy), never by a model; the Release Agent only writes it up.
 */
export function RolloutView({ rollout, canAct, nextPercent }: { rollout: Rollout; canAct: boolean; nextPercent: number | undefined }) {
  const busy = usePipeline((s) => s.busy);
  const step = busy.includes(`step:${rollout.id}`);
  const back = busy.includes(`rollback:${rollout.id}`);
  const live = rollout.state === 'candidate' || rollout.state === 'canary';
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-medium bg-default-50 p-3">
      <div className="flex items-center gap-2">
        <span className="text-small font-semibold">{ENV_LABEL[rollout.service]}</span>
        <Chip size="sm" variant="flat" color={STATE_TONE[rollout.state]}>
          {STATE_LABEL[rollout.state]}
        </Chip>
      </div>
      <TrafficBar label={`${ENV_LABEL[rollout.service]} traffic`} segments={splitOf(rollout)} />
      {rollout.service === 'production' && <StatusTimeline aria-label="Traffic steps" items={stepsOf(rollout)} />}
      {rollout.state === 'rolled_back' && <p className="text-tiny text-danger">Traffic went back to {rollout.previous ?? 'the previous revision'}. The new revision serves nothing.</p>}
      {live && rollout.service === 'production' && (
        <div className="flex flex-wrap items-center gap-2">
          <Hint label="Only an owner or an admin moves traffic" isHidden={canAct}>
            <Button size="sm" color="primary" isDisabled={!canAct || nextPercent === undefined} isLoading={step} startContent={!step ? <Rocket size={14} /> : undefined} onPress={() => void usePipeline.getState().stepRollout(rollout.id)}>
              {nextPercent !== undefined ? `Move to ${nextPercent}%` : 'No more steps'}
            </Button>
          </Hint>
          <Button size="sm" variant="flat" color="danger" isDisabled={!canAct} isLoading={back} startContent={!back ? <Undo2 size={14} /> : undefined} onPress={() => void usePipeline.getState().rollback(rollout.id)}>
            Roll back
          </Button>
        </div>
      )}
    </div>
  );
}
