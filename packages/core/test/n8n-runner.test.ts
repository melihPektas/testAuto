import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createN8nRunner } from '../src/runners/n8n-runner.js';

import type { RunContext, Step } from '../src/types.js';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;
let lastBody = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      lastBody = body;
      if (req.url === '/webhook/ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"received":true}');
      } else {
        res.writeHead(500);
        res.end('boom');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ctxFor(action: string | undefined, value?: unknown): RunContext {
  const step = action === undefined ? undefined : ({ action, value } as Step);
  return {
    config: { version: '1.0', name: 't', runners: [{ name: 'n8n', type: 'n8n' }] },
    testCase: { id: 't', version: '1.0', name: 't', steps: [{ action: 'x' }] },
    step,
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
  };
}

describe('createN8nRunner', () => {
  it('has the n8n runner shape', () => {
    const runner = createN8nRunner('wf', { baseUrl });
    expect(runner.kind).toBe('runner');
    expect(runner.type).toBe('n8n');
  });

  it('passes when the webhook responds 2xx and forwards the value as body', async () => {
    const runner = createN8nRunner('wf', { baseUrl });
    const result = await runner.runStep(ctxFor('ok', { hello: 'world' }));
    expect(result.status).toBe('pass');
    expect(result.output).toContain('received');
    expect(JSON.parse(lastBody)).toEqual({ hello: 'world' });
  });

  it('fails when the webhook responds non-2xx', async () => {
    const runner = createN8nRunner('wf', { baseUrl });
    const result = await runner.runStep(ctxFor('missing'));
    expect(result.status).toBe('fail');
    expect(result.error?.message).toContain('HTTP 500');
  });

  it('fails when there is no action', async () => {
    const runner = createN8nRunner('wf', { baseUrl });
    const result = await runner.runStep(ctxFor(undefined));
    expect(result.status).toBe('fail');
    expect(result.error?.message).toContain('no action');
  });
});
