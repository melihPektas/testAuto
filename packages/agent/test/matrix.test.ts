import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateMatrixCases, planMatrix } from '../src/matrix.js';

import type { MatrixPlan } from '../src/matrix.js';
import type { DiscoveredPage } from '@test-orchestrator/browser';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;
let reply = '';

const page: DiscoveredPage = {
  url: 'https://shop.test/products',
  title: 'All products',
  status: 200,
  links: [
    'https://shop.test/category/dresses',
    'https://shop.test/category/shirts',
    'https://shop.test/brand/acme',
  ],
  headings: ['All products'],
  repeated: [{ selector: '.card', count: 24 }],
  forms: [
    {
      index: 1,
      action: '/search',
      method: 'get',
      fields: [{ name: 'q', type: 'text', required: false }],
      hasSubmit: true,
    },
  ],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on('data', () => {
      // drain
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

const plan = (): ReturnType<typeof planMatrix> =>
  planMatrix(page, { baseUrl, model: 'mock', timeoutMs: 5000 });

describe('planMatrix', () => {
  it('keeps only urls that were actually seen on the page', async () => {
    reply = JSON.stringify({
      resultSelector: '.card',
      search: { input: '#q', submit: '#go', terms: ['dress'] },
      filters: [
        {
          axis: 'category',
          values: [
            { label: 'Dresses', url: 'https://shop.test/category/dresses' },
            // invented — never appeared in page.links
            { label: 'Shoes', url: 'https://shop.test/category/shoes' },
          ],
        },
      ],
    });
    const result = await plan();
    expect(result.plan?.filters[0]?.values).toHaveLength(1);
    expect(result.plan?.filters[0]?.values[0]?.label).toBe('Dresses');
    expect(result.rejected.join(' ')).toContain('invented url');
  });

  it('drops a search axis with no terms but keeps the filters', async () => {
    reply = JSON.stringify({
      resultSelector: '.card',
      search: { input: '#q', terms: [] },
      filters: [
        { axis: 'brand', values: [{ label: 'Acme', url: 'https://shop.test/brand/acme' }] },
      ],
    });
    const result = await plan();
    expect(result.plan?.search).toBeUndefined();
    expect(result.plan?.filters).toHaveLength(1);
  });

  it('returns no plan when nothing is usable', async () => {
    reply = JSON.stringify({ resultSelector: '.card', search: null, filters: [] });
    const result = await plan();
    expect(result.plan).toBeUndefined();
    expect(result.rejected.join(' ')).toContain('no usable axes');
  });

  it('reports an unreachable model instead of throwing', async () => {
    const result = await planMatrix(page, {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'mock',
      timeoutMs: 5000,
    });
    expect(result.plan).toBeUndefined();
    expect(result.rejected[0]).toContain('failed');
  });
});

describe('generateMatrixCases', () => {
  const full: MatrixPlan = {
    resultSelector: '.card',
    search: { input: '#q', submit: '#go', terms: ['dress', 'shirt'] },
    filters: [
      {
        axis: 'category',
        values: [
          { label: 'Dresses', url: 'https://shop.test/category/dresses' },
          { label: 'Shirts', url: 'https://shop.test/category/shirts' },
        ],
      },
      { axis: 'brand', values: [{ label: 'Acme', url: 'https://shop.test/brand/acme' }] },
    ],
  };

  it('expands every combination of the axes', () => {
    const cases = generateMatrixCases(full, page.url);
    // (no category | 2) x (no brand | 1) x (no term | 2) = 18, minus the one
    // combination where nothing at all is applied
    expect(cases).toHaveLength(17);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('honours the limit', () => {
    expect(generateMatrixCases(full, page.url, { limit: 5 })).toHaveLength(5);
  });

  it('asserts that results actually came back', () => {
    const [first] = generateMatrixCases(full, page.url);
    const actions = first?.steps.map((s) => (s as { action: string }).action) ?? [];
    expect(actions[0]).toBe('goto');
    expect(actions).toContain('expectMinCount');
  });

  it('searches on top of a filter rather than replacing it', () => {
    const cases = generateMatrixCases(full, page.url);
    const combined = cases.find((c) => c.name.includes('Dresses') && c.name.includes('search'));
    expect(combined).toBeDefined();
    const steps = (combined?.steps ?? []) as { action: string; value?: unknown }[];
    expect(steps[0]?.value).toBe('https://shop.test/category/dresses');
    expect(steps.some((s) => s.action === 'fill')).toBe(true);
  });

  it('works with filters only when the page has no search', () => {
    const cases = generateMatrixCases({ resultSelector: '.card', filters: full.filters }, page.url);
    expect(cases.length).toBeGreaterThan(0);
    expect(
      cases.every((c) => c.steps.every((s) => (s as { action: string }).action !== 'fill')),
    ).toBe(true);
  });
});
