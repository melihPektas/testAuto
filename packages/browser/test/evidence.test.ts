import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunnerRegistry, executeRun } from '@test-orchestrator/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBrowserRunner } from '../src/browser-runner.js';

import type { RunOptions } from '@test-orchestrator/core';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;
let artifacts: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/blank') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>nothing</title></head><body></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<html><head><title>Sign in</title></head><body>
        <h1>Sign in</h1>
        <p class="error-message">Invalid email or password.</p>
      </body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  artifacts = await mkdtemp(join(tmpdir(), 'evidence-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function runFailing(target: string, path = '/'): Promise<Record<string, unknown>> {
  const runners = createRunnerRegistry();
  runners.register(createBrowserRunner('ui'));
  const summary = await executeRun({
    config: {
      version: '1.0',
      name: 'evidence',
      runners: [{ name: 'ui', type: 'browser' }],
    } as unknown as RunOptions['config'],
    testCases: [
      {
        id: 'login-check',
        version: '1.0',
        name: 'looks for a welcome message',
        runner: 'ui',
        steps: [
          { id: 'goto', action: 'goto', value: `${baseUrl}${path}` },
          { id: 'welcome', action: 'expectSelector', target },
        ],
      },
    ] as unknown as RunOptions['testCases'],
    runners,
    workspace: {
      root: artifacts,
      artifacts,
      temp: artifacts,
      resolve: (p: string) => join(artifacts, p),
    },
  });
  const failing = summary.results[0]?.steps.find((s) => s.status === 'fail');
  return (failing?.evidence ?? {}) as Record<string, unknown>;
}

describe('failure evidence', () => {
  it('records what the page showed instead of what the step wanted', async () => {
    const evidence = await runFailing('.welcome-message');
    expect(evidence['title']).toBe('Sign in');
    expect(evidence['targetCount']).toBe(0);
    // the whole point: the page is telling us why
    expect(evidence['similarSelectors']).toContain('.error-message');
    expect(String(evidence['excerpt'])).toContain('Invalid email or password');
  }, 60_000);

  it('shows when a page rendered essentially nothing', async () => {
    const evidence = await runFailing('.anything', '/blank');
    expect(evidence['bodyChars']).toBe(0);
  }, 60_000);

  it('writes a screenshot and a readable evidence file', async () => {
    const evidence = await runFailing('.welcome-message');
    expect(String(evidence['screenshot'])).toMatch(/\.png$/);

    const files = await readdir(join(artifacts, 'login-check'));
    expect(files.some((f) => f.endsWith('.png'))).toBe(true);

    const jsonFile = files.find((f) => f.endsWith('.json'));
    expect(jsonFile).toBeDefined();
    const saved = JSON.parse(
      await readFile(join(artifacts, 'login-check', jsonFile ?? ''), 'utf8'),
    ) as Record<string, unknown>;
    expect(saved['url']).toContain(baseUrl);
  }, 60_000);
});
