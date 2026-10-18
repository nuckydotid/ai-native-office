import type { Environment } from './shared/pipeline/types.ts';
import type { DeployRequest, DeployedCandidate, RolloutDriver } from './rollouts.ts';
import type { RunService } from './google.ts';

interface FakeService {
  url: string;
  revisions: string[];
  traffic: { revision: string; percent: number; tag?: string }[];
}

/** The in-process Cloud Run, for the pipeline service's own tests and local work. It keeps revisions and traffic the way Cloud Run does. */
export class FakeRolloutDriver implements RolloutDriver {
  private services: Record<Environment, FakeService> = {
    staging: { url: 'https://northwind-portal-staging-fake.run.app', revisions: [], traffic: [] },
    production: { url: 'https://northwind-portal-fake.run.app', revisions: [], traffic: [] },
  };
  private counter = 0;

  async service(name: Environment): Promise<RunService> {
    const service = this.services[name];
    return {
      name: `projects/fake/locations/fake/services/${name === 'staging' ? 'northwind-portal-staging' : 'northwind-portal'}`,
      latestReadyRevision: service.revisions.at(-1) ? `${name === 'staging' ? 'northwind-portal-staging' : 'northwind-portal'}-${service.revisions.at(-1)}` : undefined,
      traffic: service.traffic.map((t) => ({ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: t.revision, percent: t.percent, tag: t.tag })),
      status: {
        url: service.url,
        traffic: service.traffic.map((t) => ({ revision: t.revision, percent: t.percent, tag: t.tag })),
      },
    };
  }

  async deploy(req: DeployRequest): Promise<DeployedCandidate> {
    const service = this.services[req.service];
    this.counter += 1;
    const base = req.service === 'staging' ? 'northwind-portal-staging' : 'northwind-portal';
    const revision = `${base}-${String(this.counter).padStart(5, '0')}`;
    const previous = req.previous ?? service.traffic.find((t) => t.percent >= 100)?.revision ?? service.revisions.at(-1) ?? null;
    service.revisions.push(revision);
    service.traffic = [
      { revision, percent: req.percent, ...(req.tag ? { tag: req.tag } : {}) },
      ...(previous && req.percent < 100 ? [{ revision: previous, percent: 100 - req.percent }] : []),
    ];
    return { revision, previous, url: service.url };
  }

  async setTraffic(service: Environment, revision: string, previous: string | null, percent: number, tagName?: string): Promise<void> {
    const target = this.services[service];
    target.traffic = [
      { revision, percent, ...(tagName ? { tag: tagName } : {}) },
      ...(previous && previous !== revision && percent < 100 ? [{ revision: previous, percent: 100 - percent }] : []),
    ];
  }
}
