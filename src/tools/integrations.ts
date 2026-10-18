// Which Google services and partner tools the pipeline uses, and what is true of each right now. Pure and unit-tested, so the page
// can never claim a connection that is not there: a partner tool that needs a key or a repository says so.

export type IntegrationStatus = 'on' | 'standin' | 'needs_setup' | 'planned';

export interface Integration {
  id: string;
  name: string;
  /** What it does for the team, in a sentence. */
  does: string;
  group: 'google' | 'partner';
  status: IntegrationStatus;
  /** The honest detail: what runs, or what is missing. */
  detail: string;
}

export const STATUS_LABEL: Record<IntegrationStatus, string> = {
  on: 'Connected',
  standin: 'Local stand-in',
  needs_setup: 'Needs a key or a repository',
  planned: 'Not built yet',
};

export const STATUS_COLOR: Record<IntegrationStatus, 'success' | 'warning' | 'default'> = { on: 'success', standin: 'warning', needs_setup: 'default', planned: 'default' };

/** What the pipeline says about itself: `null` when the server runs without it. */
export type PipelineSeen = { driver: 'fake' | 'http' } | null;

export function integrationsFor(seen: PipelineSeen): Integration[] {
  const real = seen?.driver === 'http';
  const live = (on: string, off: string): Pick<Integration, 'status' | 'detail'> =>
    seen === null ? { status: 'planned', detail: 'The delivery pipeline is switched off on this server.' } : real ? { status: 'on', detail: on } : { status: 'standin', detail: off };
  return [
    { id: 'gemini', name: 'Gemini on the Agent Platform', group: 'google', does: 'Ten AI colleagues draft specs, designs, code, tests and release notes.', status: 'on', detail: 'Runs in the agent service with its own service account; the browser holds no key.' },
    { id: 'adk', name: 'Agent Development Kit', group: 'google', does: 'Each colleague is a small graph of steps: research, analysis, then a written answer with a schema.', status: 'on', detail: 'ADK 2.x graph workflows in the agent service.' },
    { id: 'firestore', name: 'Firestore', group: 'google', does: 'Vector search over the team’s docs and tickets; the pipeline’s own state.', status: 'on', detail: 'Knowledge index in Firestore; pipeline state in its own database when the pipeline service is connected.' },
    { id: 'cloudbuild', name: 'Cloud Build', group: 'google', does: 'Builds the sample app and runs its unit and end-to-end tests with the network switched off.', ...live('Real builds, started only when a person presses Run.', 'Simulated jobs in the web service: no build minutes are spent.') },
    { id: 'storage', name: 'Cloud Storage', group: 'google', does: 'Keeps the sources of each job, its reports and the change sets that were shipped.', ...live('A private bucket, emptied by the nightly reset.', 'Nothing is stored: the stand-in keeps jobs in memory.') },
    { id: 'registry', name: 'Artifact Registry', group: 'google', does: 'Keeps the release images the rollout deploys.', ...live('A repository for the sample app’s images.', 'No images are built by the stand-in.') },
    { id: 'run', name: 'Cloud Run', group: 'google', does: 'Hosts the sample app: staging, then production in steps, with a rollback to the previous revision.', ...live('Revisions and traffic splits on two real services.', 'The stand-in moves a pretend traffic split.') },
    { id: 'monitoring', name: 'Cloud Monitoring and Error Reporting', group: 'google', does: 'Corroborate the canary’s own measurements with request counts, latency and grouped errors.', status: 'planned', detail: 'The canary judges from requests the pipeline sends itself; reading Monitoring next to it is a later step.' },
    { id: 'supply', name: 'Artifact Analysis and Binary Authorization', group: 'google', does: 'Scan the release image and sign it only after a person approves.', status: 'planned', detail: 'The release gate has a scan step; the signed attestation is a later step.' },
    { id: 'jules', name: 'Jules', group: 'partner', does: 'Could take a ticket and open a pull request in a real repository.', status: 'needs_setup', detail: 'Needs a connected GitHub repository. The demo’s code lives in a virtual branch, not in Git.' },
    { id: 'stitch', name: 'Stitch', group: 'partner', does: 'Could draw screens from a description, as another source for the Design stage.', status: 'needs_setup', detail: 'Needs an API key from its owner. The Designer Agent writes the prototypes in the meantime.' },
    { id: 'codeassist', name: 'Gemini Code Assist', group: 'partner', does: 'Could review a change in a pull request.', status: 'needs_setup', detail: 'Needs a connected repository. The Reviewer Agent reviews change sets in the meantime.' },
  ];
}
