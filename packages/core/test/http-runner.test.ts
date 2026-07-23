import { createServer, type Server } from 'node:http';


import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executeRun, createRunnerRegistry } from '../src/index.js';
import { createHttpRunner } from '../src/runners/http-runner.js';

import type { RunOptions } from '../src/types.js';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (req.url === '/missing') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"nope"}');
        return;
      }
      if (req.method === 'POST' && req.url === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"service":"api"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function run(steps: unknown[]): ReturnType<typeof executeRun> {
  const runners = createRunnerRegistry();
  runners.register(createHttpRunner('http', { baseUrl }));
  return executeRun({
    config: {
      version: '1.0',
      name: 'api',
      runners: [{ name: 'http', type: 'http' }],
    } as unknown as RunOptions['config'],
    testCases: [
      { id: 't', version: '1.0', name: 'api', runner: 'http', steps } as unknown,
    ] as unknown as RunOptions['testCases'],
    runners,
  });
}

describe('createHttpRunner', () => {
  it('requests, asserts status 200 and body content', async () => {
    const summary = await run([
      { id: '1', action: 'request', target: 'GET /health' },
      { id: '2', action: 'expectStatus', value: 200 },
      { id: '3', action: 'expectBody', value: 'service' },
    ]);
    expect(summary.status).toBe('pass');
    expect(summary.results[0]?.steps).toHaveLength(3);
  });

  it('fails when the status assertion is wrong', async () => {
    const summary = await run([
      { id: '1', action: 'request', target: 'GET /missing' },
      { id: '2', action: 'expectStatus', value: 200 },
    ]);
    expect(summary.status).toBe('fail');
    expect(summary.results[0]?.error?.message).toContain('status');
  });

  it('sends a JSON body and can assert the echoed response', async () => {
    const summary = await run([
      { id: '1', action: 'request', target: 'POST /echo', value: { hello: 'world' } },
      { id: '2', action: 'expectStatus', value: 200 },
      { id: '3', action: 'expectBody', value: 'world' },
    ]);
    expect(summary.status).toBe('pass');
  });
});
