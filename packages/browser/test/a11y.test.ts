import { createServer, type Server } from 'node:http';

import { createRunnerRegistry, executeRun } from '@test-orchestrator/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBrowserRunner } from '../src/browser-runner.js';

import type { RunOptions, StepResult } from '@test-orchestrator/core';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;

// A clean page and a page with real, axe-detectable violations: an image with
// no alt text, and a control with no accessible name.
const CLEAN = `<!doctype html><html lang="en"><head><title>Clean</title></head>
  <body><main><h1>Hello</h1><p>All good here.</p>
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="a dot" />
  </main></body></html>`;

const BROKEN = `<!doctype html><html><head><title>Broken</title></head>
  <body>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />
    <div role="button"></div>
  </body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/broken' ? BROKEN : CLEAN);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function a11y(path: string, value?: unknown): Promise<StepResult> {
  const runners = createRunnerRegistry();
  runners.register(createBrowserRunner('ui'));
  const summary = await executeRun({
    config: {
      version: '1.0',
      name: 'a11y',
      runners: [{ name: 'ui', type: 'browser' }],
    } as unknown as RunOptions['config'],
    testCases: [
      {
        id: 'a',
        version: '1.0',
        name: 'a11y',
        runner: 'ui',
        steps: [
          { id: 'goto', action: 'goto', value: `${baseUrl}${path}` },
          { id: 'a11y', action: 'expectA11y', ...(value === undefined ? {} : { value }) },
        ],
      },
    ] as unknown as RunOptions['testCases'],
    runners,
  });
  return summary.results[0]?.steps.find((s) => s.stepId === 'a11y') as StepResult;
}

describe('expectA11y', () => {
  it('passes a page with no serious violations', async () => {
    const step = await a11y('/clean');
    expect(step.status).toBe('pass');
    expect(step.output).toContain('no critical/serious');
  }, 60_000);

  it('fails a page with real violations and names the rules', async () => {
    const step = await a11y('/broken');
    expect(step.status).toBe('fail');
    expect(step.error?.message).toContain('accessibility violation');
    // image-alt is a serious rule axe will flag on the alt-less image
    expect(step.error?.message).toMatch(/image-alt|button-name/);
  }, 60_000);

  it('can be narrowed to only critical', async () => {
    // most of the broken page's issues are 'serious', so critical-only may pass
    const step = await a11y('/broken', 'critical');
    expect(step.output ?? step.error?.message).toContain('critical');
  }, 60_000);
});
