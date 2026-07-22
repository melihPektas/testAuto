import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executeRun, createRunnerRegistry } from '@test-orchestrator/core';
import type { RunOptions } from '@test-orchestrator/core';

import { createBrowserRunner } from '../src/browser-runner.js';
import { createUrlGenerator } from '../src/url-generator.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><head><title>gone</title></head><body>nope</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>welcome friend</p></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function run(steps: unknown[]): Promise<RunOptions extends never ? never : Awaited<ReturnType<typeof executeRun>>> {
  const runners = createRunnerRegistry();
  runners.register(createBrowserRunner('browser'));
  return executeRun({
    config: { version: '1.0', name: 'ui', runners: [{ name: 'browser', type: 'browser' }] } as unknown as RunOptions['config'],
    testCases: [
      { id: 't', version: '1.0', name: 'ui', runner: 'browser', steps } as unknown,
    ] as unknown as RunOptions['testCases'],
    runners,
  });
}

describe('createBrowserRunner', () => {
  it('passes a full UI smoke against a live page', async () => {
    const summary = await run([
      { id: '1', action: 'goto', value: baseUrl },
      { id: '2', action: 'expectStatus', value: 200 },
      { id: '3', action: 'expectTitle', value: 'Test Page' },
      { id: '4', action: 'expectSelector', target: 'h1' },
      { id: '5', action: 'expectText', value: 'welcome friend' },
    ]);
    expect(summary.status).toBe('pass');
    expect(summary.results[0]?.steps).toHaveLength(5);
  });

  it('fails when the status assertion is wrong', async () => {
    const summary = await run([
      { id: '1', action: 'goto', value: `${baseUrl}/missing` },
      { id: '2', action: 'expectStatus', value: 200 },
    ]);
    expect(summary.status).toBe('fail');
    expect(summary.results[0]?.error?.message).toContain('status');
  });

  it('fails when a selector is missing', async () => {
    const summary = await run([
      { id: '1', action: 'goto', value: baseUrl },
      { id: '2', action: 'expectSelector', target: '.does-not-exist' },
    ]);
    expect(summary.status).toBe('fail');
  });
});

describe('createUrlGenerator', () => {
  it('produces a UI smoke test-case for a url', async () => {
    const gen = createUrlGenerator();
    const suite = await gen.generate({
      config: { version: '1.0', name: 'g', runners: [] } as unknown as never,
      env: {},
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child() {
          return this;
        },
      },
      signal: new AbortController().signal,
      workspace: { root: '.', artifacts: '.', temp: '.', resolve: (p) => p },
      options: { url: 'https://example.com' },
    });
    expect(suite.files).toHaveLength(1);
    const parsed = JSON.parse(suite.files[0]?.content ?? '{}') as {
      runner: string;
      steps: { action: string }[];
    };
    expect(parsed.runner).toBe('browser');
    expect(parsed.steps.map((s) => s.action)).toEqual([
      'goto',
      'expectStatus',
      'expectTitle',
      'expectSelector',
    ]);
  });
});
