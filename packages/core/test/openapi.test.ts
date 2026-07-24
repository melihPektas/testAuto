import { describe, expect, it } from 'vitest';

import { mutateBody, mutationsFor } from '../src/openapi/fuzz.js';
import { generateApiTests } from '../src/openapi/generate.js';
import { parseSpec, sampleFor } from '../src/openapi/spec.js';

const spec = {
  openapi: '3.0.0',
  info: { title: 'Shop API', version: '1.2.0' },
  servers: [{ url: 'https://api.shop.test/v1' }],
  security: [{ bearer: [] }],
  paths: {
    '/products': {
      get: {
        operationId: 'listProducts',
        parameters: [
          { name: 'category', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: {
          200: {
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createProduct',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } },
        },
        responses: { 201: {} },
      },
    },
    '/products/{id}': {
      parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
      get: {
        operationId: 'getProduct',
        responses: {
          200: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } },
          },
          404: {},
        },
      },
      delete: { operationId: 'deleteProduct', responses: { 204: {} } },
    },
  },
  components: {
    schemas: {
      Product: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string', example: 'Blue mug' },
          price: { type: 'number' },
          related: { $ref: '#/components/schemas/Product' },
        },
      },
    },
  },
};

describe('parseSpec', () => {
  const api = parseSpec(spec);

  it('reads the operations, including ones declared per path', () => {
    expect(api.title).toBe('Shop API');
    expect(api.serverUrl).toBe('https://api.shop.test/v1');
    expect(api.operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual([
      'delete /products/{id}',
      'get /products',
      'get /products/{id}',
      'post /products',
    ]);
  });

  it('treats a path parameter as required even when the spec forgets to say so', () => {
    const op = api.operations.find((o) => o.path === '/products/{id}' && o.method === 'get');
    expect(op?.parameters[0]?.required).toBe(true);
  });

  it('resolves $ref so a validator never sees one', () => {
    const op = api.operations.find((o) => o.operationId === 'getProduct');
    const schema = op?.responseSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.['name']).toEqual({ type: 'string', example: 'Blue mug' });
  });

  it('survives a schema that references itself', () => {
    const op = api.operations.find((o) => o.operationId === 'getProduct');
    expect(op?.responseSchema).toBeDefined();
  });

  it('records the declared success codes', () => {
    expect(api.operations.find((o) => o.operationId === 'createProduct')?.successStatuses).toEqual([
      201,
    ]);
    expect(api.operations.find((o) => o.operationId === 'deleteProduct')?.successStatuses).toEqual([
      204,
    ]);
  });

  it('builds a request body from the schema, preferring its examples', () => {
    const op = api.operations.find((o) => o.operationId === 'createProduct');
    expect(op?.requestBody).toMatchObject({ name: 'Blue mug' });
  });
});

describe('sampleFor', () => {
  it('prefers what the spec says over anything invented', () => {
    expect(sampleFor({ type: 'string', example: 'exact' })).toBe('exact');
    expect(sampleFor({ type: 'string', enum: ['a', 'b'] })).toBe('a');
    expect(sampleFor({ type: 'integer', minimum: 7 })).toBe(7);
  });

  it('derives something plausible from type and format', () => {
    expect(sampleFor({ type: 'string', format: 'email' })).toBe('test@example.com');
    expect(sampleFor({ type: 'string' }, 'userId')).toBe('1');
    expect(sampleFor({ type: 'boolean' })).toBe(true);
  });
});

describe('generateApiTests', () => {
  it('leaves out anything that changes server state, by default', () => {
    const { cases, skipped } = generateApiTests(parseSpec(spec));
    const names = cases.map((c) => c.name).join('\n');
    expect(names).not.toContain('POST');
    expect(names).not.toContain('DELETE');
    expect(skipped.map((s) => s.operation).sort()).toEqual([
      'DELETE /products/{id}',
      'POST /products',
    ]);
    expect(skipped[0]?.reason).toContain('changes server state');
  });

  it('includes them only when asked explicitly', () => {
    const { cases, skipped } = generateApiTests(parseSpec(spec), { includeWrites: true });
    expect(skipped).toHaveLength(0);
    expect(cases.map((c) => c.name).join('\n')).toContain('POST /products');
  });

  it('asserts the documented status and the response schema', () => {
    const { cases } = generateApiTests(parseSpec(spec));
    const happy = JSON.parse(cases[0]?.content ?? '{}') as { steps: { action: string }[] };
    expect(happy.steps.map((s) => s.action)).toEqual(['request', 'expectStatus', 'expectSchema']);
  });

  it('fills required query parameters into the request', () => {
    const { cases } = generateApiTests(parseSpec(spec));
    const happy = JSON.parse(cases[0]?.content ?? '{}') as { steps: { target?: string }[] };
    expect(happy.steps[0]?.target).toContain('category=test');
  });

  it('writes a negative case that drops a required parameter', () => {
    const { cases } = generateApiTests(parseSpec(spec));
    const negative = cases.find((c) => c.name.includes('without the required'));
    expect(negative).toBeDefined();
    const parsed = JSON.parse(negative?.content ?? '{}') as {
      steps: { target?: string; value?: unknown }[];
    };
    expect(parsed.steps[0]?.target).not.toContain('category=');
    expect(parsed.steps[1]?.value).toEqual(['4xx']);
  });

  it('checks that a secured operation refuses an anonymous call', () => {
    const { cases } = generateApiTests(parseSpec(spec));
    const unauth = cases.find((c) => c.name.includes('without credentials'));
    const parsed = JSON.parse(unauth?.content ?? '{}') as {
      steps: { action: string; value?: unknown }[];
    };
    // no Authorization header is set on this one, that is the point
    expect(parsed.steps.some((s) => s.action === 'setHeader')).toBe(false);
    expect(parsed.steps[1]?.value).toEqual([401, 403]);
  });

  it('names the token variable rather than carrying a token', () => {
    const { cases } = generateApiTests(parseSpec(spec), { authEnv: 'SHOP_API_TOKEN' });
    const happy = JSON.parse(cases[0]?.content ?? '{}') as {
      steps: { action: string; value?: unknown }[];
    };
    expect(happy.steps[0]).toMatchObject({
      action: 'setHeader',
      value: 'Bearer ${SHOP_API_TOKEN}',
    });
  });

  it('can stick to happy paths when that is all you want', () => {
    const { cases } = generateApiTests(parseSpec(spec), { happyPathOnly: true });
    expect(cases.every((c) => !c.name.includes('without'))).toBe(true);
  });
});

describe('stateful chains', () => {
  it('does not build a chain without --include-writes', () => {
    const { cases } = generateApiTests(parseSpec(spec));
    expect(cases.some((c) => c.name.includes('lifecycle'))).toBe(false);
  });

  it('links create → read → delete, carrying the created id', () => {
    const { cases } = generateApiTests(parseSpec(spec), { includeWrites: true });
    const chain = cases.find((c) => c.name.includes('lifecycle'));
    expect(chain).toBeDefined();
    const parsed = JSON.parse(chain?.content ?? '{}') as {
      steps: { id: string; action: string; target?: string; value?: unknown }[];
    };
    const actions = parsed.steps.map((s) => s.action);
    expect(actions).toEqual([
      'request',
      'expectStatusIn',
      'capture',
      'request',
      'expectStatus',
      'request',
      'expectStatusIn',
    ]);
    // the create posts to the collection
    expect(parsed.steps[0]?.target).toBe('POST /products');
    // the id is captured, then used — it did not exist until create returned it
    expect(parsed.steps[2]?.target).toBe('id = id');
    expect(parsed.steps[3]?.target).toBe('GET /products/${id}');
    expect(parsed.steps[5]?.target).toBe('DELETE /products/${id}');
  });
});

describe('schema-derived fuzzing', () => {
  it('derives invalid values from what the schema declares', () => {
    const numeric = mutationsFor({ type: 'integer', minimum: 1, maximum: 10 }, 'page');
    const labels = numeric.map((m) => m.label);
    expect(labels).toContain('page as a string');
    expect(labels).toContain('page below minimum');
    expect(labels).toContain('page above maximum');
    expect(numeric.find((m) => m.label === 'page below minimum')?.value).toBe(0);
  });

  it('includes the empty string, the most commonly unguarded case', () => {
    const labels = mutationsFor({ type: 'string' }, 'q').map((m) => m.label);
    expect(labels).toContain('q empty');
    expect(labels).toContain('q very long');
  });

  it('breaks an enum and a format', () => {
    expect(mutationsFor({ type: 'string', enum: ['a'] }, 'sort')[0]?.label).toContain(
      'outside its enum',
    );
    expect(mutationsFor({ type: 'string', format: 'email' }, 'to').map((m) => m.label)).toContain(
      'to with a malformed email',
    );
  });

  it('mutates one body field and leaves the rest alone', () => {
    expect(mutateBody({ a: 1, b: 'keep' }, 'a', 'broken')).toEqual({ a: 'broken', b: 'keep' });
  });

  it('generates nothing extra unless asked', () => {
    const { cases } = generateApiTests(parseSpec(spec));
    expect(cases.some((c) => c.name.includes('must not 5xx'))).toBe(false);
  });

  it('asserts only that the server does not 5xx', () => {
    const { cases } = generateApiTests(parseSpec(spec), { fuzz: true });
    const fuzzed = cases.filter((c) => c.name.includes('must not 5xx'));
    expect(fuzzed.length).toBeGreaterThan(0);
    const parsed = JSON.parse(fuzzed[0]?.content ?? '{}') as {
      steps: { action: string; value?: unknown }[];
    };
    // accepting or rejecting bad input are both fine; crashing is not
    expect(parsed.steps.at(-1)).toMatchObject({ action: 'expectStatusIn', value: ['2xx', '4xx'] });
  });

  it('respects the per-operation cap', () => {
    const { cases } = generateApiTests(parseSpec(spec), { fuzz: true, maxFuzzPerOperation: 1 });
    const perOp = cases.filter(
      (c) => c.name.startsWith('GET /products ') && c.name.includes('5xx'),
    );
    expect(perOp.length).toBeLessThanOrEqual(1);
  });
});

describe('body fuzzing from the schema', () => {
  it('mutates each body field using its own declared type', () => {
    const { cases } = generateApiTests(parseSpec(spec), {
      fuzz: true,
      includeWrites: true,
      maxFuzzPerOperation: 20,
    });
    const bodyCases = cases.filter((c) => c.name.startsWith('POST /products with'));
    const names = bodyCases.map((c) => c.name).join('\n');
    // price is a number in the schema, name is a string — different mutations
    expect(names).toContain('price as a string');
    expect(names).toContain('name empty');
  });

  it('leaves the other fields intact so a failure names one field', () => {
    const { cases } = generateApiTests(parseSpec(spec), {
      fuzz: true,
      includeWrites: true,
      maxFuzzPerOperation: 20,
    });
    const one = cases.find((c) => c.name.includes('price as a string'));
    const parsed = JSON.parse(one?.content ?? '{}') as {
      steps: { value?: Record<string, unknown> }[];
    };
    const body = parsed.steps[0]?.value;
    expect(body?.['price']).toBe('not-a-number');
    // the valid example value for name survives
    expect(body?.['name']).toBe('Blue mug');
  });

  it('drops a required field to see whether that crashes the server', () => {
    const { cases } = generateApiTests(parseSpec(spec), {
      fuzz: true,
      includeWrites: true,
      maxFuzzPerOperation: 30,
    });
    const dropped = cases.find((c) => c.name.includes('without "id"'));
    expect(dropped).toBeDefined();
    const parsed = JSON.parse(dropped?.content ?? '{}') as {
      steps: { value?: Record<string, unknown> }[];
    };
    expect(parsed.steps[0]?.value).not.toHaveProperty('id');
    expect(parsed.steps[0]?.value).toHaveProperty('name');
  });
});
