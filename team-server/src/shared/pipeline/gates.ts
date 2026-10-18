// Copied from Worktrees Studio (src/shared/pipeline) by `npm run sync-core`. Do not edit here.
import { DEFAULT_POLICY, SCAN_SEVERITIES, nextStage, stageIndex } from './types.ts';
import type { Artifact, ArtifactKind, Job, JobKind, PipelinePolicy, PipelineStage, Rollout } from './types.ts';

/** What a gate reads. Plain data, so the same rules run in the web service, in the pipeline service and in a test. */
export interface GateInput {
  stage: PipelineStage;
  artifacts: Pick<Artifact, 'id' | 'kind' | 'state' | 'digest' | 'body' | 'meta' | 'by'>[];
  jobs: Pick<Job, 'kind' | 'state' | 'inputDigest' | 'imageDigest' | 'summary' | 'createdAt'>[];
  rollouts: Pick<Rollout, 'service' | 'state' | 'createdAt'>[];
  policy?: PipelinePolicy;
  /** Who presses Approve & advance. */
  actor?: { id: string; role: string };
}

export interface GateCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface Gate {
  stage: PipelineStage;
  next: PipelineStage | null;
  ready: boolean;
  checks: GateCheck[];
}

const accepted = (a: GateInput['artifacts'], kind: ArtifactKind) => a.filter((x) => x.kind === kind && x.state === 'accepted').at(-1);

/** The newest job of a kind that ran on this exact digest. A job for an older change set never counts. */
function latestJob(jobs: GateInput['jobs'], kind: JobKind, digest: string | undefined) {
  if (!digest) return undefined;
  return jobs.filter((j) => j.kind === kind && j.inputDigest === digest).sort((a, b) => a.createdAt - b.createdAt).at(-1);
}

const jobCheck = (id: string, label: string, job: ReturnType<typeof latestJob>, whenMissing: string): GateCheck => {
  if (!job) return { id, label, ok: false, detail: whenMissing };
  if (job.state === 'passed') return { id, label, ok: true };
  if (job.state === 'queued' || job.state === 'running') return { id, label, ok: false, detail: 'Still running.' };
  return { id, label, ok: false, detail: job.state === 'failed' ? 'It failed. Fix it and run it again.' : `It ${job.state.replace('_', ' ')}.` };
};

/** A spec lists what done looks like: at least one checkbox line. */
export const hasAcceptanceCriteria = (body: string): boolean => /^\s*[-*]\s+\[[ xX]\]\s+\S/m.test(body);

const severityRank = (s: string | undefined) => Math.max(0, SCAN_SEVERITIES.indexOf((s ?? 'NONE') as (typeof SCAN_SEVERITIES)[number]));

/** The rules for leaving a stage. Pure: the answer depends only on the input. */
export function gateFor(input: GateInput): Gate {
  const policy = input.policy ?? DEFAULT_POLICY;
  const { stage, artifacts, jobs } = input;
  const checks: GateCheck[] = [];
  const set = accepted(artifacts, 'change_set');

  switch (stage) {
    case 'plan': {
      const spec = accepted(artifacts, 'spec');
      checks.push({ id: 'spec', label: 'A spec is accepted', ok: !!spec, detail: spec ? undefined : 'Ask the Planner Agent for a spec and accept it.' });
      checks.push({ id: 'criteria', label: 'It lists what done looks like', ok: !!spec && hasAcceptanceCriteria(spec.body), detail: spec ? 'Add acceptance criteria as a checklist.' : undefined });
      break;
    }
    case 'design': {
      const design = accepted(artifacts, 'design');
      checks.push({ id: 'design', label: 'A design is accepted (or this has no UI)', ok: !!design, detail: design ? undefined : 'Ask the Designer Agent, or accept “No UI change”.' });
      break;
    }
    case 'build': {
      checks.push({ id: 'change_set', label: 'A change set is accepted', ok: !!set, detail: set ? undefined : 'Ask the Developer Agent for a change set and accept it.' });
      checks.push(jobCheck('build', 'The build passes on that change set', latestJob(jobs, 'build', set?.digest), 'Run the build.'));
      break;
    }
    case 'test': {
      const unit = latestJob(jobs, 'unit', set?.digest);
      checks.push(jobCheck('unit', 'Unit tests pass', unit, 'Run the unit tests.'));
      const coverage = unit?.state === 'passed' ? unit.summary?.coveragePct : undefined;
      checks.push({
        id: 'coverage',
        label: `Coverage is at least ${policy.coverageMin}%`,
        ok: typeof coverage === 'number' && coverage >= policy.coverageMin,
        detail: typeof coverage === 'number' ? `It is ${coverage}%.` : 'No coverage was reported yet.',
      });
      checks.push(jobCheck('e2e', 'End-to-end tests pass', latestJob(jobs, 'e2e', set?.digest), 'Run the end-to-end tests.'));
      break;
    }
    case 'release': {
      const pack = accepted(artifacts, 'release_pack');
      checks.push({ id: 'release_pack', label: 'A release pack is accepted', ok: !!pack, detail: pack ? undefined : 'Ask the Release Agent for a release pack and accept it.' });
      const release = latestJob(jobs, 'release_build', set?.digest);
      checks.push(jobCheck('release_build', 'The release image is built', release, 'Build the release image.'));
      if (policy.scanRequired) {
        const scan = latestJob(jobs, 'scan', set?.digest);
        const worst = scan?.summary?.scanSeverity;
        const clean = scan?.state === 'passed' && severityRank(worst) <= severityRank(policy.scanMaxSeverity);
        checks.push({
          id: 'scan',
          label: `The scan finds nothing worse than ${policy.scanMaxSeverity.toLowerCase()}`,
          ok: clean,
          detail: !scan ? 'Run the vulnerability scan.' : scan.state !== 'passed' ? 'The scan has not passed.' : clean ? undefined : `It found ${String(worst).toLowerCase()} issues.`,
        });
      }
      const canApprove = input.actor ? input.actor.role === 'owner' || input.actor.role === 'admin' : true;
      checks.push({ id: 'approver', label: 'An owner or admin approves', ok: canApprove, detail: canApprove ? undefined : 'Only an owner or an admin can approve a release.' });
      if (policy.separationOfDuties && input.actor && set) {
        const same = set.by.id === input.actor.id;
        checks.push({ id: 'four_eyes', label: 'Someone other than the author approves', ok: !same, detail: same ? 'The author of the change set cannot approve its release.' : undefined });
      }
      break;
    }
    case 'deploy': {
      const rollout = input.rollouts.filter((r) => r.service === 'production').sort((a, b) => a.createdAt - b.createdAt).at(-1);
      const detail = !rollout ? 'Start the rollout.' : rollout.state === 'rolled_back' ? 'The last rollout was rolled back.' : rollout.state === 'complete' ? undefined : 'The rollout is not at 100% yet.';
      checks.push({ id: 'rollout', label: 'The rollout reaches 100% and stays healthy', ok: rollout?.state === 'complete', detail });
      break;
    }
    default:
      break;
  }
  return { stage, next: nextStage(stage), ready: checks.length > 0 && checks.every((c) => c.ok), checks };
}

/** Whether a ticket may move from `from` to `to`: forward one stage when its gate is ready, or back to any earlier stage. */
export function canMove(from: PipelineStage, to: PipelineStage, gate: Gate): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: false, reason: 'The ticket is already there.' };
  if (stageIndex(to) < stageIndex(from)) return { ok: true };
  if (to !== gate.next) return { ok: false, reason: 'A ticket moves one stage at a time.' };
  return gate.ready ? { ok: true } : { ok: false, reason: gate.checks.find((c) => !c.ok)?.detail ?? 'Not everything for this stage is done yet.' };
}
