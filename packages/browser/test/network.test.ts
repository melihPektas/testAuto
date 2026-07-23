import { createServer, type Server } from 'node:http';

import { createRunnerRegistry, executeRun } from '@test-orchestrator/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBrowserRunner } from '../src/browser-runner.js';
import { endpointOf, isApiCall, summariseNetwork } from '../src/network.js';
import { generateTestsFromObservation, groupCalls, observeApiCalls } from '../src/observe.js';

import type { NetworkCall } from '../src/network.js';
import type { RunOptions, StepResult } from '@test-orchestrator/core';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;

const PAGE = `<html><head><title>Catalogue</title></head><body>
  <ul id="items"><li>loading…</li></ul>
  <script>
    (async () => {
      const ok = await fetch('/api/items').then((r) => r.json());
      await fetch('/api/items');
      await fetch('/api/broken').catch(() => {});
      document.getElementById('items').innerHTML =
        ok.map((n) => '<li class="item">' + n + '</li>').join('');
    })();
  </script>
</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/items') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('["one","two"]');
    }
    if (req.url === '/api/broken') {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":"down"}');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = (over: Partial<NetworkCall> = {}): NetworkCall => ({
  method: 'GET',
  url: 'https://shop.test/api/products?page=1',
  status: 200,
  durationMs: 40,
  resourceType: 'fetch',
  failed: false,
  failure: undefined,
  ...over,
});

describe('network bookkeeping', () => {
  it('groups an endpoint regardless of its query string', () => {
    expect(endpointOf('https://shop.test/api/products?page=2&sort=asc')).toBe(
      'https://shop.test/api/products',
    );
  });

  it('counts only the calls that carry data', () => {
    expect(isApiCall(call({ resourceType: 'stylesheet' }))).toBe(false);
    expect(isApiCall(call({ resourceType: 'xhr' }))).toBe(true);
  });

  it('treats a 4xx, a 5xx and an outright failure alike', () => {
    const summary = summariseNetwork([
      call(),
      call({ status: 404 }),
      call({ status: 503 }),
      call({ status: undefined, failed: true, failure: 'net::ERR_CONNECTION_RESET' }),
    ]);
    expect(summary.apiCalls).toBe(4);
    expect(summary.broken).toHaveLength(3);
  });

  it('surfaces an endpoint called more than once', () => {
    const summary = summariseNetwork([
      call(),
      call({ url: 'https://shop.test/api/products?page=2' }),
    ]);
    expect(summary.repeated[0]).toEqual({
      endpoint: 'GET https://shop.test/api/products',
      count: 2,
    });
  });
});

async function run(steps: unknown[]): Promise<StepResult[]> {
  const runners = createRunnerRegistry();
  runners.register(createBrowserRunner('ui'));
  const summary = await executeRun({
    config: {
      version: '1.0',
      name: 'net',
      runners: [{ name: 'ui', type: 'browser' }],
    } as unknown as RunOptions['config'],
    testCases: [
      { id: 'net', version: '1.0', name: 'network', runner: 'ui', steps },
    ] as unknown as RunOptions['testCases'],
    runners,
  });
  return [...(summary.results[0]?.steps ?? [])];
}

describe('network assertions', () => {
  it('catches a broken API call on a page that renders perfectly well', async () => {
    const steps = await run([
      { id: 'goto', action: 'goto', value: baseUrl },
      { id: 'loaded', action: 'waitFor', target: '.item' },
      // the page is fine to look at, which is the whole point
      { id: 'text', action: 'expectText', value: 'one' },
      { id: 'net', action: 'expectNoFailedRequests' },
    ]);
    expect(steps[2]?.status).toBe('pass');
    expect(steps[3]?.status).toBe('fail');
    expect(steps[3]?.error?.message).toContain('/api/broken → 500');
  }, 60_000);

  it('carries the failed calls into the evidence', async () => {
    const steps = await run([
      { id: 'goto', action: 'goto', value: baseUrl },
      { id: 'loaded', action: 'waitFor', target: '.item' },
      { id: 'net', action: 'expectNoFailedRequests' },
    ]);
    const evidence = (steps[2]?.evidence ?? {}) as Record<string, unknown>;
    expect(evidence['apiCalls']).toBe(3);
    expect(String(evidence['failedApiCalls'])).toContain('/api/broken');
  }, 60_000);

  it('asserts an endpoint was actually reached', async () => {
    const steps = await run([
      { id: 'goto', action: 'goto', value: baseUrl },
      { id: 'loaded', action: 'waitFor', target: '.item' },
      { id: 'called', action: 'expectApiCalled', target: '/api/items' },
      { id: 'never', action: 'expectApiCalled', target: '/api/nothing-here' },
    ]);
    expect(steps[2]?.status).toBe('pass');
    expect(steps[3]?.error?.message).toContain('never called an API matching');
  }, 60_000);

  it('passes a generous latency budget and fails an impossible one', async () => {
    const generous = await run([
      { id: 'goto', action: 'goto', value: baseUrl },
      { id: 'loaded', action: 'waitFor', target: '.item' },
      { id: 'speed', action: 'expectRequestsUnder', value: 10000 },
    ]);
    expect(generous[2]?.status).toBe('pass');

    const impossible = await run([
      { id: 'goto', action: 'goto', value: baseUrl },
      { id: 'loaded', action: 'waitFor', target: '.item' },
      { id: 'speed', action: 'expectRequestsUnder', value: -1 },
    ]);
    expect(impossible[2]?.status).toBe('fail');
  }, 90_000);
});

describe('observing a page to find its endpoints', () => {
  it('reports what the page called, and how it went', async () => {
    const observation = await observeApiCalls(baseUrl, { settleMs: 1500 });
    const items = observation.endpoints.find((e) => e.endpoint.endsWith('/api/items'));
    const broken = observation.endpoints.find((e) => e.endpoint.endsWith('/api/broken'));
    expect(items?.calls).toBe(2);
    expect(items?.healthy).toBe(true);
    expect(broken?.statuses).toEqual([500]);
    expect(broken?.healthy).toBe(false);
  }, 60_000);

  it('never enshrines a broken endpoint as the expected behaviour', () => {
    const observation = {
      pageUrl: 'https://shop.test/',
      totalCalls: 2,
      endpoints: groupCalls(
        [
          call({ url: 'https://shop.test/api/ok' }),
          call({ url: 'https://shop.test/api/down', status: 500 }),
        ],
        ['https://shop.test'],
      ),
    };
    const { cases, skipped } = generateTestsFromObservation(observation);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.name).toContain('/api/ok');
    expect(skipped[0]?.endpoint).toContain('/api/down');
    expect(skipped[0]?.reason).toContain('a finding, not a baseline');
  });

  it('replays only GET, because anything else may change data', () => {
    const observation = {
      pageUrl: 'https://shop.test/',
      totalCalls: 1,
      endpoints: groupCalls(
        [call({ method: 'POST', url: 'https://shop.test/api/orders' })],
        ['https://shop.test'],
      ),
    };
    const { cases, skipped } = generateTestsFromObservation(observation);
    expect(cases).toHaveLength(0);
    expect(skipped[0]?.reason).toContain('may change data');
  });

  it('ignores third-party origins unless asked', () => {
    const grouped = groupCalls(
      [call({ url: 'https://shop.test/api/ok' }), call({ url: 'https://analytics.example/track' })],
      ['https://shop.test'],
    );
    expect(grouped).toHaveLength(1);
  });
});
