import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
let workspace: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Hi</h1></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  workspace = await mkdtemp(join(tmpdir(), 'trace-'));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workspace, { recursive: true, force: true });
});

async function run(id: string, willFail: boolean): Promise<void> {
  const runners = createRunnerRegistry();
  runners.register(createBrowserRunner('ui', { trace: true }));
  await executeRun({
    config: {
      version: '1.0',
      name: 'trace',
      runners: [{ name: 'ui', type: 'browser' }],
    } as unknown as RunOptions['config'],
    testCases: [
      {
        id,
        version: '1.0',
        name: id,
        runner: 'ui',
        steps: [
          { id: 'goto', action: 'goto', value: baseUrl },
          willFail
            ? { id: 'boom', action: 'expectSelector', target: '.not-here' }
            : { id: 'ok', action: 'expectSelector', target: 'h1' },
        ],
      },
    ] as unknown as RunOptions['testCases'],
    runners,
    workspace: {
      root: workspace,
      artifacts: join(workspace, '.artifacts'),
      temp: workspace,
      resolve: (p: string) => join(workspace, p),
    },
  });
}

describe('trace on failure', () => {
  it('writes a trace zip for a failed test', async () => {
    await run('fails', true);
    const info = await stat(join(workspace, '.artifacts', 'fails', 'trace-2.zip'));
    // a real trace zip is not empty
    expect(info.size).toBeGreaterThan(0);
  }, 60_000);

  it('does not keep a trace for a passing test', async () => {
    await run('passes', false);
    await expect(
      readFile(join(workspace, '.artifacts', 'passes', 'trace-2.zip')),
    ).rejects.toThrow();
  }, 60_000);
});
