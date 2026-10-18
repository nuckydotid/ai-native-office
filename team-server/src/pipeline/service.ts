import { createHash, randomBytes } from 'node:crypto';
import type { Collab } from '../collab.ts';
import type { CollabStore } from '../collab-store.ts';
import { OFFICE_ID } from '../store.ts';
import type { Issue } from '../shared/board/types.ts';
import { canMove, gateFor } from '../shared/pipeline/gates.ts';
import type { Gate } from '../shared/pipeline/gates.ts';
import { denyScan } from '../shared/pipeline/protocol.ts';
import { DEFAULT_POLICY, PIPELINE_LIMITS, stageIndex } from '../shared/pipeline/types.ts';
import type { RunArtifactLine, RunTicket } from '../shared/ai/types.ts';
import type { Artifact, ArtifactAuthor, ArtifactDraft, AuditEvent, Environment, Job, JobKind, PipelinePolicy, PipelineStage, Rollout } from '../shared/pipeline/types.ts';
import type { WorkspaceRole } from '../shared/workspace/types.ts';
import { PipelineRefusal } from './driver.ts';
import type { PipelineDriver } from './driver.ts';

/** A refusal the routes turn into a status and a sentence. */
export class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 429 | 503 = 400,
  ) {
    super(message);
  }
}

/** Who is asking, as the server knows them. */
export interface Actor {
  uid: string;
  name: string;
  role: WorkspaceRole;
}

/** The sha256 an approval binds to: what the artifact is, not when it was made or who made it. */
export function digestOf(d: Pick<ArtifactDraft, 'kind' | 'title' | 'body' | 'files'>): string {
  return createHash('sha256')
    .update(JSON.stringify([d.kind, d.title, d.body, (d.files ?? []).map((f) => [f.path, f.op, f.role, f.content, f.baseSha])]))
    .digest('hex');
}

const isActive = (state: Job['state']) => state === 'queued' || state === 'running';
const canApprove = (a: Actor) => a.role === 'owner' || a.role === 'admin';

/**
 * The delivery pipeline as the web service runs it: the artifacts agents propose and people accept, the gates between stages, the audit
 * trail, and the buttons that start real work. The work itself (builds, tests, rollouts) is the driver's. Every rule here is decided on the
 * server, so every window sees the same answer.
 */
export class Pipeline {
  /** Told after every change (ticket ids, or job and rollout ids), so connected pages read again. Never throws. */
  onChange?: (ids: string[]) => void;
  private policy: PipelinePolicy = { ...DEFAULT_POLICY };

  constructor(
    private collab: Collab,
    private store: CollabStore,
    readonly driver: PipelineDriver,
    private now: () => number = Date.now,
  ) {}

  private changed(ids: string[]) {
    try {
      this.onChange?.(ids);
    } catch {
      // A listener that fails must not fail the change that was already saved.
    }
  }

  private newId(prefix: string) {
    return `${prefix}-${this.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  }

  getPolicy(): PipelinePolicy {
    return { ...this.policy, rolloutPlan: [...this.policy.rolloutPlan] };
  }

  /** Replaces the thresholds the gates read. The routes allow owners and admins only. */
  setPolicy(p: PipelinePolicy) {
    this.policy = { ...p, rolloutPlan: [...p.rolloutPlan] };
  }

  /* ───────────── helpers ───────────── */

  /** A ticket by id or number, and in the pipeline. */
  private async ticket(idOrKey: string): Promise<Issue & { pipeline: NonNullable<Issue['pipeline']> }> {
    let issue: Issue | null = null;
    try {
      issue = await this.collab.issue(OFFICE_ID, idOrKey);
    } catch {
      const key = Number(idOrKey);
      if (Number.isInteger(key)) issue = (await this.collab.board(OFFICE_ID)).issues.find((i) => i.key === key) ?? null;
    }
    if (!issue) throw new PipelineError('not_found', 'That ticket is not on the board.', 404);
    if (!issue.pipeline) throw new PipelineError('not_pipeline', 'This ticket is not in the delivery pipeline.', 409);
    return issue as Issue & { pipeline: NonNullable<Issue['pipeline']> };
  }

  async audit(by: { uid: string; name: string; role: string }, action: string, detail: string, ticket?: string, ref?: string) {
    const event: AuditEvent = { id: this.newId('au'), at: this.now(), by: { id: by.uid, name: by.name, role: by.role }, action, detail, ...(ticket ? { ticket } : {}), ...(ref ? { ref } : {}) };
    await this.store.appendAudit(OFFICE_ID, event, PIPELINE_LIMITS.audit);
  }

  async auditTrail(limit = 100): Promise<AuditEvent[]> {
    return this.store.listAudit(OFFICE_ID, Math.min(limit, PIPELINE_LIMITS.audit));
  }

  /** What a pipeline run is told about its ticket: where it stands and what the pipeline already holds (the bodies are read through tools). */
  async ticketContext(idOrKey: string): Promise<{ ticket: RunTicket; artifacts: RunArtifactLine[] } | null> {
    let issue;
    try {
      issue = await this.ticket(idOrKey);
    } catch {
      return null;
    }
    const artifacts = (await this.store.listArtifacts(OFFICE_ID, issue.id)).filter((a) => a.state !== 'superseded' && a.state !== 'rejected');
    return {
      ticket: { id: issue.id, key: issue.key, title: issue.title, body: issue.body.slice(0, 4000), stage: issue.pipeline.stage },
      artifacts: artifacts.slice(-20).map((a) => ({ id: a.id, kind: a.kind, state: a.state, version: a.version, title: a.title })),
    };
  }

  /* ───────────── artifacts ───────────── */

  async artifacts(ticket?: string): Promise<Artifact[]> {
    return this.store.listArtifacts(OFFICE_ID, ticket);
  }

  async artifact(id: string): Promise<Artifact> {
    const a = await this.store.getArtifact(OFFICE_ID, id);
    if (!a) throw new PipelineError('not_found', 'That artifact is not here.', 404);
    return a;
  }

  /** The newest accepted change set of a ticket, with its files. */
  private async acceptedChangeSet(ticketId: string): Promise<Artifact | null> {
    return (await this.store.listArtifacts(OFFICE_ID, ticketId)).filter((a) => a.kind === 'change_set' && a.state === 'accepted').at(-1) ?? null;
  }

  /** A change set must be clean (nothing AI-written code may not do) and written against the trunk as it is now. */
  private async checkChangeSet(files: NonNullable<Artifact['files']>) {
    const found = denyScan(files);
    if (found.length) {
      const f = found[0];
      throw new PipelineError('denied', `A change set cannot use ${f.rule} (${f.path}, line ${f.line}).`, 400);
    }
    const { files: repo } = await this.driver.repo();
    const shas = new Map(repo.map((r) => [r.path, r.sha]));
    for (const f of files) {
      const current = shas.get(f.path) ?? null;
      const stale = f.op === 'delete' ? current === null || f.baseSha !== current : f.baseSha !== current;
      if (stale) throw new PipelineError('stale', `${f.path} changed on main since this change set was written. Ask the Developer Agent to start again from the current code.`, 409);
    }
  }

  /** Keeps what an agent (or a person) proposes as a draft. Idempotent: the same content for the same ticket is the same artifact. */
  async submit(ticketId: string, by: ArtifactAuthor, draft: ArtifactDraft, runId?: string): Promise<Artifact> {
    const issue = await this.ticket(ticketId);
    const existing = await this.store.listArtifacts(OFFICE_ID, issue.id);
    const digest = digestOf(draft);
    const same = existing.find((a) => a.kind === draft.kind && a.digest === digest && (a.state === 'draft' || a.state === 'accepted'));
    if (same) return same;
    if (existing.length >= PIPELINE_LIMITS.artifactsPerTicket) throw new PipelineError('full', `This ticket already has ${PIPELINE_LIMITS.artifactsPerTicket} artifacts.`, 409);
    if (draft.kind === 'change_set') await this.checkChangeSet(draft.files ?? []);
    const version = 1 + Math.max(0, ...existing.filter((a) => a.kind === draft.kind).map((a) => a.version));
    const artifact: Artifact = {
      id: this.newId('ar'), ticket: issue.id, ticketKey: issue.key, kind: draft.kind, version, digest, title: draft.title, body: draft.body,
      ...(draft.files ? { files: draft.files } : {}), ...(draft.meta ? { meta: draft.meta } : {}),
      state: 'draft', by, ...(runId ? { runId } : {}), createdAt: this.now(),
    };
    // A newer draft of the same kind replaces the older drafts (an accepted one stays until a newer one is accepted).
    for (const older of existing.filter((a) => a.kind === draft.kind && a.state === 'draft')) await this.store.putArtifact(OFFICE_ID, { ...older, state: 'superseded' });
    await this.store.putArtifact(OFFICE_ID, artifact);
    await this.audit({ uid: by.id, name: by.name, role: by.agent ? 'agent' : 'member' }, 'artifact.draft', `${by.name} proposed ${draft.kind.replace('_', ' ')} v${version}: ${draft.title}`, issue.id, artifact.id);
    this.changed([issue.id]);
    return artifact;
  }

  /** A person accepts or rejects exactly this draft. */
  async decide(id: string, who: Actor, decision: 'accepted' | 'rejected'): Promise<Artifact> {
    const a = await this.artifact(id);
    if (a.state !== 'draft') throw new PipelineError('decided', 'That artifact has already been decided.', 409);
    if (decision === 'accepted') {
      // A change set is checked again at the moment it is accepted: the trunk may have moved since it was written.
      if (a.kind === 'change_set') await this.checkChangeSet(a.files ?? []);
      for (const older of (await this.store.listArtifacts(OFFICE_ID, a.ticket)).filter((x) => x.kind === a.kind && x.state === 'accepted')) await this.store.putArtifact(OFFICE_ID, { ...older, state: 'superseded' });
    }
    const next: Artifact = { ...a, state: decision, decidedBy: who.uid, decidedAt: this.now() };
    await this.store.putArtifact(OFFICE_ID, next);
    await this.audit(who, decision === 'accepted' ? 'artifact.accept' : 'artifact.reject', `${who.name} ${decision} ${a.kind.replace('_', ' ')} v${a.version}`, a.ticket, a.id);
    this.changed([a.ticket]);
    return next;
  }

  /** "No UI change": a person's own accepted design artifact, so the Design gate has something to bind to. */
  async acceptNoUi(ticketId: string, who: Actor): Promise<Artifact> {
    const draft = await this.submit(ticketId, { id: who.uid, name: who.name }, { kind: 'design', title: 'No UI change', body: 'This ticket changes no screen, so there is nothing to design.', meta: { noUi: true } });
    return draft.state === 'accepted' ? draft : this.decide(draft.id, who, 'accepted');
  }

  /* ───────────── gates and stages ───────────── */

  private async gateOf(issue: Issue & { pipeline: NonNullable<Issue['pipeline']> }, actor?: Actor): Promise<Gate> {
    const [artifacts, jobs, rollouts] = await Promise.all([this.store.listArtifacts(OFFICE_ID, issue.id), this.driver.listJobs(issue.id), this.driver.listRollouts(issue.id)]);
    return gateFor({ stage: issue.pipeline.stage, artifacts, jobs, rollouts, policy: this.policy, ...(actor ? { actor: { id: actor.uid, role: actor.role } } : {}) });
  }

  async gate(ticketId: string, actor?: Actor): Promise<{ stage: PipelineStage; gate: Gate }> {
    const issue = await this.ticket(ticketId);
    return { stage: issue.pipeline.stage, gate: await this.gateOf(issue, actor) };
  }

  /** Approve & advance (forward one stage when the gate is ready) or send a ticket back to an earlier stage. */
  async advance(ticketId: string, who: Actor, to: PipelineStage): Promise<Issue> {
    const issue = await this.ticket(ticketId);
    const from = issue.pipeline.stage;
    const verdict = canMove(from, to, await this.gateOf(issue, who));
    if (!verdict.ok) throw new PipelineError('gate', verdict.reason, 409);
    const forward = stageIndex(to) > stageIndex(from);
    // Shipping moves the trunk: the ticket remembers the revision its work became part of.
    const rev = to === 'done' ? (await this.driver.repo()).rev : undefined;
    const next = await this.collab.setStage(OFFICE_ID, who.uid, issue.id, to, rev);
    await this.audit(who, forward ? 'ticket.advance' : 'ticket.back', `${who.name} moved #${issue.key} from ${from} to ${to}`, issue.id);
    this.changed([issue.id]);
    return next;
  }

  /* ───────────── jobs ───────────── */

  async jobs(ticket?: string): Promise<Job[]> {
    return this.driver.listJobs(ticket);
  }

  async job(id: string): Promise<Job> {
    const j = await this.driver.getJob(id);
    if (!j) throw new PipelineError('not_found', 'That job is not here.', 404);
    return j;
  }

  async jobLog(id: string, from: number) {
    const log = await this.driver.jobLog(id, from);
    if (!log) throw new PipelineError('not_found', 'That job is not here.', 404);
    return log;
  }

  private refuse(e: unknown): never {
    if (e instanceof PipelineRefusal) throw new PipelineError(e.code, e.message, e.status);
    throw e;
  }

  /** A person presses a button that starts real work. What may start now is decided here, from the ticket's stage and what already passed. */
  async startJob(ticketId: string, who: Actor, kind: JobKind): Promise<Job> {
    if (!(['build', 'unit', 'e2e', 'release_build', 'scan', 'explore'] as JobKind[]).includes(kind)) throw new PipelineError('bad_kind', 'That kind of job is started another way.');
    const issue = await this.ticket(ticketId);
    const set = await this.acceptedChangeSet(issue.id);
    if (!set?.files) throw new PipelineError('no_change_set', 'Accept a change set first: there is nothing to run yet.', 409);
    const stage = issue.pipeline.stage;
    const at = stageIndex(stage);
    const jobs = await this.driver.listJobs(issue.id);
    const onDigest = (k: JobKind) => jobs.filter((j) => j.kind === k && j.inputDigest === set.digest).sort((a, b) => a.createdAt - b.createdAt).at(-1);
    const passed = (k: JobKind) => onDigest(k)?.state === 'passed';
    if (kind === 'build' && at < stageIndex('build')) throw new PipelineError('stage', 'The build runs once the ticket is in Build.', 409);
    if ((kind === 'unit' || kind === 'e2e' || kind === 'explore') && !(stage === 'build' || stage === 'test')) throw new PipelineError('stage', 'Tests run while the ticket is in Build or Test.', 409);
    if (kind === 'release_build') {
      if (stage !== 'release') throw new PipelineError('stage', 'The release image is built while the ticket is in Release.', 409);
      if (!(passed('unit') && passed('e2e'))) throw new PipelineError('tests', 'Run the unit and end-to-end tests on this change set first.', 409);
    }
    if (kind === 'scan' && (stage !== 'release' || !passed('release_build'))) throw new PipelineError('stage', 'Scan the release image after it is built, in Release.', 409);
    const running = onDigest(kind);
    if (running && isActive(running.state)) throw new PipelineError('running', 'That job is already running on this change set.', 409);
    let job: Job;
    try {
      job = await this.driver.startJob({
        ticket: issue.id, ticketKey: issue.key, kind, inputDigest: set.digest, files: set.files, startedBy: { id: who.uid, name: who.name },
        ...(kind === 'release_build' ? { approval: { by: who.uid, at: this.now(), digest: set.digest } } : {}),
      });
    } catch (e) {
      this.refuse(e);
    }
    await this.audit(who, 'job.start', `${who.name} started ${kind.replace('_', ' ')} on #${issue.key}`, issue.id, job.id);
    this.changed([issue.id]);
    return job;
  }

  async cancelJob(id: string, who: Actor): Promise<Job> {
    const job = await this.driver.cancelJob(id);
    if (!job) throw new PipelineError('not_found', 'That job is not here.', 404);
    await this.audit(who, 'job.cancel', `${who.name} cancelled ${job.kind.replace('_', ' ')}`, job.ticket, job.id);
    this.changed([job.ticket]);
    return job;
  }

  /* ───────────── rollouts ───────────── */

  async rollouts(ticket?: string): Promise<Rollout[]> {
    return this.driver.listRollouts(ticket);
  }

  async startRollout(ticketId: string, who: Actor, service: Environment): Promise<Rollout> {
    if (!canApprove(who)) throw new PipelineError('forbidden', 'Only an owner or an admin starts a rollout.', 403);
    const issue = await this.ticket(ticketId);
    if (issue.pipeline.stage !== 'deploy') throw new PipelineError('stage', 'Rollouts start while the ticket is in Deploy.', 409);
    const set = await this.acceptedChangeSet(issue.id);
    if (!set) throw new PipelineError('no_change_set', 'There is no accepted change set to ship.', 409);
    const jobs = await this.driver.listJobs(issue.id);
    const build = jobs.filter((j) => j.kind === 'release_build' && j.inputDigest === set.digest && j.state === 'passed' && j.imageDigest).at(-1);
    if (!build?.imageDigest) throw new PipelineError('no_image', 'Build the release image first.', 409);
    if (this.policy.scanRequired && !jobs.some((j) => j.kind === 'scan' && j.inputDigest === set.digest && j.state === 'passed')) throw new PipelineError('no_scan', 'The release image has not passed its scan.', 409);
    let rollout: Rollout;
    try {
      rollout = await this.driver.startRollout({
        ticket: issue.id,
        ticketKey: issue.key,
        service,
        imageDigest: build.imageDigest,
        inputDigest: set.digest,
        plan: this.policy.rolloutPlan,
        thresholds: {
          errorRateMax: this.policy.errorRateMax,
          p95MsMax: this.policy.p95MsMax,
          scanRequired: this.policy.scanRequired,
          scanMaxSeverity: this.policy.scanMaxSeverity,
        },
        startedBy: { id: who.uid, name: who.name },
      });
    } catch (e) {
      this.refuse(e);
    }
    await this.audit(who, 'rollout.start', `${who.name} started the ${service} rollout of #${issue.key}`, issue.id, rollout.id);
    this.changed([issue.id]);
    return rollout;
  }

  async stepRollout(id: string, who: Actor): Promise<Rollout> {
    if (!canApprove(who)) throw new PipelineError('forbidden', 'Only an owner or an admin moves traffic.', 403);
    let rollout: Rollout;
    try {
      rollout = await this.driver.stepRollout(id, { id: who.uid, name: who.name });
    } catch (e) {
      this.refuse(e);
    }
    const check = rollout.checks.at(-1);
    if (rollout.state === 'rolled_back') await this.audit(who, 'rollout.rolled_back', `Traffic went back to ${rollout.previous ?? 'the previous revision'}: ${check?.reason ?? 'a check failed'}`, rollout.ticket, rollout.id);
    else await this.audit(who, 'rollout.step', `${who.name} moved ${rollout.service} to ${rollout.trafficPct}% (${rollout.state})`, rollout.ticket, rollout.id);
    this.changed([rollout.ticket]);
    return rollout;
  }

  async rollback(id: string, who: Actor): Promise<Rollout> {
    if (!canApprove(who)) throw new PipelineError('forbidden', 'Only an owner or an admin rolls back.', 403);
    let rollout: Rollout;
    try {
      rollout = await this.driver.rollback(id, { id: who.uid, name: who.name });
    } catch (e) {
      this.refuse(e);
    }
    await this.audit(who, 'rollout.rollback', `${who.name} rolled ${rollout.service} back to ${rollout.previous ?? 'the previous revision'}`, rollout.ticket, rollout.id);
    this.changed([rollout.ticket]);
    return rollout;
  }

  async status(uid: string) {
    return { driver: this.driver.kind, policy: this.getPolicy(), ...(await this.driver.status(uid)) };
  }

  /** The nightly reset: artifacts and the audit trail go with the rest of the workspace (`clearAll`); the driver puts Google's side back. */
  async reset() {
    await this.driver.reset();
  }
}

