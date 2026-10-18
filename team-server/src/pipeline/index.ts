import type { Config } from '../config.ts';
import { IdTokenSource } from '../ai/client.ts';
import type { PipelineDriver } from './driver.ts';
import { FakePipelineDriver } from './fake.ts';
import { HttpPipelineDriver } from './http.ts';

/**
 * The driver the configuration asks for: the in-process stand-in for local work and tests, or the client of the private pipeline
 * service. `PIPELINE_DRIVER` decides; without an address the stand-in is used (the routes then say the pipeline is not connected).
 */
export function createPipelineDriver(cfg: Pick<Config, 'pipelineDriver' | 'pipelineServiceUrl' | 'agentServiceAuth'>): PipelineDriver {
  if (cfg.pipelineDriver === 'http') {
    if (!cfg.pipelineServiceUrl) throw new Error('PIPELINE_DRIVER=http needs PIPELINE_SERVICE_URL');
    return new HttpPipelineDriver({ base: cfg.pipelineServiceUrl, auth: cfg.agentServiceAuth === 'none' ? 'none' : 'google', tokens: new IdTokenSource() });
  }
  return new FakePipelineDriver();
}
