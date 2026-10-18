import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config.ts';

const keep = { ...process.env };
afterEach(() => {
  for (const key of ['PIPELINE_ENABLED', 'PIPELINE_DRIVER', 'PIPELINE_SERVICE_URL']) {
    if (keep[key] === undefined) delete process.env[key];
    else process.env[key] = keep[key];
  }
});

describe('the pipeline switches', () => {
  test('the pipeline is off unless it is switched on', () => {
    delete process.env.PIPELINE_ENABLED;
    process.env.PIPELINE_SERVICE_URL = 'https://studio-pipeline-abc-as.a.run.app';
    const cfg = loadConfig();
    expect(cfg.pipelineEnabled).toBe(false);
    expect(cfg.pipelineDriver).toBe('off');
  });

  test('with a service address it talks to the service; without one it uses the in-process stand-in', () => {
    process.env.PIPELINE_ENABLED = '1';
    process.env.PIPELINE_SERVICE_URL = 'https://studio-pipeline-abc-as.a.run.app/some/path';
    const real = loadConfig();
    expect(real.pipelineDriver).toBe('http');
    expect(real.pipelineServiceUrl).toBe('https://studio-pipeline-abc-as.a.run.app');
    delete process.env.PIPELINE_SERVICE_URL;
    expect(loadConfig().pipelineDriver).toBe('fake');
  });

  test('the driver can be named, and an unknown name falls back to the service address when there is one', () => {
    process.env.PIPELINE_ENABLED = 'true';
    process.env.PIPELINE_DRIVER = 'fake';
    process.env.PIPELINE_SERVICE_URL = 'https://studio-pipeline-abc-as.a.run.app';
    expect(loadConfig().pipelineDriver).toBe('fake');
    process.env.PIPELINE_DRIVER = 'nonsense';
    expect(loadConfig().pipelineDriver).toBe('http');
  });
});
