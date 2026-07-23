import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authorTestsForPage } from '../src/author.js';
import { readAuthorCache, signPage } from '../src/cache.js';

import type { DiscoveredPage } from '@test-orchestrator/browser';
import type { AddressInfo } from 'node:net';

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

const validReply = JSON.stringify([
  {
    id: 'search-products',
    version: '1.0',
    name: 'Search for a product',
    steps: [{ action: 'goto', value: 'https://shop.test/products' }, { action: 'audit' }],
  },
]);

describe('signPage', () => {
  it('is stable for the same page, model and count', () => {
    expect(signPage(page, 'qwen', 3)).toBe(signPage(page, 'qwen', 3));
  });

  it('changes when the model, the count or the page changes', () => {
    const base = signPage(page, 'qwen', 3);
    expect(signPage(page, 'llama', 3)).not.toBe(base);
    expect(signPage(page, 'qwen', 5)).not.toBe(base);
    expect(signPage({ ...page, title: 'Different' }, 'qwen', 3)).not.toBe(base);
  });
});

describe('author caching', () => {
  let server: Server;
  let baseUrl: string;
  let calls = 0;
  let dir: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.on('data', () => {
        // drain
      });
      req.on('end', () => {
        calls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: validReply } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    dir = await mkdtemp(join(tmpdir(), 'author-cache-'));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const author = (cacheDir?: string): ReturnType<typeof authorTestsForPage> =>
    authorTestsForPage(page, {
      baseUrl,
      model: 'mock',
      timeoutMs: 5000,
      ...(cacheDir !== undefined ? { cacheDir } : {}),
    });

  it('calls the model when there is no cache dir', async () => {
    calls = 0;
    await author();
    await author();
    expect(calls).toBe(2);
  });

  it('calls the model once, then serves the cache', async () => {
    const cacheDir = join(dir, 'run1');
    calls = 0;
    const first = await author(cacheDir);
    expect(first.accepted).toHaveLength(1);
    expect(calls).toBe(1);

    const second = await author(cacheDir);
    expect(second.accepted).toHaveLength(1);
    expect(second.raw).toBe('(from cache)');
    // the model was not called again
    expect(calls).toBe(1);
  });

  it('re-validates the cache, treating a tampered entry as a miss', async () => {
    const cacheDir = join(dir, 'run2');
    await author(cacheDir);
    // corrupt the single cache file with a schema-invalid case
    const files = await readdir(cacheDir);
    await writeFile(
      join(cacheDir, files[0] ?? ''),
      JSON.stringify([{ id: 'x', bogus: true }]),
      'utf8',
    );

    calls = 0;
    const result = await author(cacheDir);
    // the tampered cache was rejected, so the model ran again
    expect(calls).toBe(1);
    expect(result.accepted).toHaveLength(1);
  });

  it('readAuthorCache returns undefined for a missing key', async () => {
    expect(await readAuthorCache(dir, 'does-not-exist')).toBeUndefined();
  });
});
