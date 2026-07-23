import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRunnerRegistry, executeRun } from '../src/index.js';
import { createHttpRunner } from '../src/runners/http-runner.js';

import type { RunOptions, StepResult } from '../src/types.js';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;
let lastAuth: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    lastAuth = req.headers['authorization'];
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/product') return json(200, { id: '1', name: 'Blue mug', price: 12.5 });
    if (req.url === '/bad-shape') return json(200, { id: 1 });
    if (req.url === '/not-json') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('plain text');
    }
    if (req.url === '/whoami') return json(200, { auth: lastAuth ?? null });
    if (req.url === '/teapot') return json(418, { error: 'no coffee' });
    return json(404, { error: 'nope' });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const productSchema = {
  type: 'object',
  required: ['id', 'name', 'price'],
  properties: { id: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' } },
};

async function run(steps: unknown[], env: Record<string, string> = {}): Promise<StepResult[]> {
  const runners = createRunnerRegistry();
  runners.register(createHttpRunner('api', { baseUrl }));
  const summary = await executeRun({
    config: {
      version: '1.0',
      name: 'api',
      runners: [{ name: 'api', type: 'http' }],
    } as unknown as RunOptions['config'],
    testCases: [
      { id: 't', version: '1.0', name: 'api test', runner: 'api', steps },
    ] as unknown as RunOptions['testCases'],
    runners,
    env,
  });
  return [...(summary.results[0]?.steps ?? [])];
}

describe('expectSchema', () => {
  it('passes when the response matches', async () => {
    const steps = await run([
      { id: 'call', action: 'request', target: 'GET /product' },
      { id: 'schema', action: 'expectSchema', value: productSchema },
    ]);
    expect(steps.every((s) => s.status === 'pass')).toBe(true);
  });

  it('fails, with the reason, when it does not', async () => {
    const steps = await run([
      { id: 'call', action: 'request', target: 'GET /bad-shape' },
      { id: 'schema', action: 'expectSchema', value: productSchema },
    ]);
    expect(steps[1]?.status).toBe('fail');
    expect(steps[1]?.error?.message).toContain('must have required property');
  });

  it('says so plainly when the body is not JSON at all', async () => {
    const steps = await run([
      { id: 'call', action: 'request', target: 'GET /not-json' },
      { id: 'schema', action: 'expectSchema', value: productSchema },
    ]);
    expect(steps[1]?.error?.message).toContain('not JSON');
  });
});

describe('expectStatusIn', () => {
  it('accepts a family such as 4xx', async () => {
    const steps = await run([
      { id: 'call', action: 'request', target: 'GET /missing' },
      { id: 'status', action: 'expectStatusIn', value: ['4xx'] },
    ]);
    expect(steps[1]?.status).toBe('pass');
  });

  it('accepts an explicit list', async () => {
    const steps = await run([
      { id: 'call', action: 'request', target: 'GET /teapot' },
      { id: 'status', action: 'expectStatusIn', value: [418, 200] },
    ]);
    expect(steps[1]?.status).toBe('pass');
  });

  it('fails when nothing matches', async () => {
    const steps = await run([
      { id: 'call', action: 'request', target: 'GET /product' },
      { id: 'status', action: 'expectStatusIn', value: ['5xx'] },
    ]);
    expect(steps[1]?.error?.message).toContain('expected status in [5xx] but got 200');
  });
});

describe('setHeader', () => {
  it('expands ${VAR} from the environment, so the file holds no token', async () => {
    const steps = await run(
      [
        { id: 'auth', action: 'setHeader', target: 'Authorization', value: 'Bearer ${SHOP_TOKEN}' },
        { id: 'call', action: 'request', target: 'GET /whoami' },
        { id: 'body', action: 'expectBody', value: 'Bearer real-secret' },
      ],
      { SHOP_TOKEN: 'real-secret' },
    );
    expect(steps.every((s) => s.status === 'pass')).toBe(true);
  });

  it('never echoes the value it just set', async () => {
    const steps = await run(
      [{ id: 'auth', action: 'setHeader', target: 'Authorization', value: 'Bearer ${SHOP_TOKEN}' }],
      { SHOP_TOKEN: 'real-secret' },
    );
    expect(steps[0]?.output).toBe('set Authorization');
    expect(JSON.stringify(steps[0])).not.toContain('real-secret');
  });
});

describe('evidence on an api failure', () => {
  it('records the request, the status and a slice of the body', async () => {
    const steps = await run([
      { id: 'call', action: 'request', target: 'GET /teapot' },
      { id: 'status', action: 'expectStatus', value: 200 },
    ]);
    const evidence = (steps[1]?.evidence ?? {}) as Record<string, unknown>;
    expect(String(evidence['request'])).toContain('GET ');
    expect(evidence['status']).toBe(418);
    expect(String(evidence['excerpt'])).toContain('no coffee');
  });
});
