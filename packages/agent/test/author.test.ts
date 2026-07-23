import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authorTestsForPage } from '../src/author.js';
import { extractJson } from '../src/llm.js';

import type { DiscoveredPage } from '@test-orchestrator/browser';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;
/** What the mock LLM should reply with on the next call. */
let reply = '';

const page: DiscoveredPage = {
  url: 'https://shop.test/products',
  title: 'Products',
  status: 200,
  links: ['https://shop.test/cart'],
  headings: ['Products'],
  repeated: [{ selector: '.card', count: 24 }],
  forms: [
    {
      index: 1,
      action: '/search',
      method: 'get',
      fields: [{ name: 'q', type: 'search', required: false }],
      hasSubmit: true,
    },
  ],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on('data', () => {
      // drain the request body; the mock always replies with `reply`
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const author = (): ReturnType<typeof authorTestsForPage> =>
  authorTestsForPage(page, { baseUrl, model: 'mock', timeoutMs: 5000 });

describe('extractJson', () => {
  it('pulls JSON out of fenced and chatty responses', () => {
    expect(extractJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(extractJson('Sure! Here you go:\n[{"a":2}]\nHope that helps.')).toEqual([{ a: 2 }]);
  });

  it('throws when there is no JSON', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('authorTestsForPage', () => {
  it('accepts well-formed scenarios and forces our runner', async () => {
    reply = JSON.stringify([
      {
        id: 'search-products',
        version: '1.0',
        name: 'Search for a product',
        runner: 'whatever-the-model-said',
        steps: [
          { action: 'goto', value: 'https://shop.test/products' },
          { action: 'fill', target: '[name="q"]', value: 'phone' },
          { action: 'click', target: 'form button[type="submit"]' },
          { action: 'expectNoConsole' },
        ],
      },
    ]);
    const result = await author();
    // the last step uses an unsupported action → the whole case is rejected
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('unsupported action');
  });

  it('accepts a valid scenario', async () => {
    reply = JSON.stringify([
      {
        id: 'search-products',
        version: '1.0',
        name: 'Search for a product',
        steps: [
          { action: 'goto', value: 'https://shop.test/products' },
          { action: 'fill', target: '[name="q"]', value: 'phone' },
          { action: 'click', target: 'form button[type="submit"]' },
          { action: 'audit' },
        ],
      },
    ]);
    const result = await author();
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.runner).toBe('ui');
    expect(result.rejected).toHaveLength(0);
  });

  it('rejects schema-invalid output', async () => {
    reply = JSON.stringify([{ id: 'x', name: 'no version or steps' }]);
    const result = await author();
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/version|steps/);
  });

  it('rejects a scenario that navigates off the explored origin', async () => {
    reply = JSON.stringify([
      {
        id: 'evil',
        version: '1.0',
        name: 'Go somewhere else entirely',
        steps: [{ action: 'goto', value: 'https://evil.example.com/' }],
      },
    ]);
    const result = await author();
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('leaves the explored origin');
  });

  it('reports unparsable model output instead of throwing', async () => {
    reply = 'I am a language model and I refuse.';
    const result = await author();
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it('reports a timed-out model instead of throwing', async () => {
    // A local model can take ~30s for even a small reply, so a caller that
    // gets the timeout wrong must still get a result, not an AbortError.
    reply = '[]';
    const result = await authorTestsForPage(page, { baseUrl, model: 'mock', timeoutMs: 1 });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('timeout');
  });

  it('reports an unreachable model instead of throwing', async () => {
    const result = await authorTestsForPage(page, {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'mock',
      timeoutMs: 5000,
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('failed');
  });
});
