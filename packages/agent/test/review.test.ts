import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  changesetFromGithub,
  changesetFromGitlab,
  changesetFromNumstat,
  jiraTrigger,
} from '../src/changeset.js';
import { combineSurfaces, planReview, ruleForFile } from '../src/review.js';

import type { AddressInfo } from 'node:net';

describe('ruleForFile', () => {
  const cases: [string, string][] = [
    ['src/components/LoginForm.tsx', 'ui'],
    ['app/pages/checkout.jsx', 'ui'],
    ['styles/theme.scss', 'ui'],
    ['web/views/cart.vue', 'ui'],
    ['api/routes/products.ts', 'backend'],
    ['src/controllers/order-controller.ts', 'backend'],
    ['server/models/user.ts', 'backend'],
    ['db/migrations/003_add_index.sql', 'backend'],
    ['prisma/schema.prisma', 'backend'],
    ['README.md', 'neither'],
    ['pnpm-lock.yaml', 'neither'],
    ['src/components/LoginForm.test.tsx', 'neither'],
    ['.github/workflows/ci.yml', 'neither'],
  ];

  for (const [path, surface] of cases) {
    it(`calls ${path} ${surface}`, () => {
      expect(ruleForFile(path)?.surface).toBe(surface);
    });
  }

  it('leaves a genuinely ambiguous path for the model', () => {
    expect(ruleForFile('src/lib/format-price.ts')).toBeUndefined();
  });
});

describe('combineSurfaces', () => {
  it('is both when ui and backend both appear', () => {
    expect(combineSurfaces(['ui', 'backend', 'neither'])).toBe('both');
  });
  it('ignores neither', () => {
    expect(combineSurfaces(['ui', 'neither', 'neither'])).toBe('ui');
    expect(combineSurfaces(['neither'])).toBe('neither');
  });
  it('treats a single both as both', () => {
    expect(combineSurfaces(['both', 'neither'])).toBe('both');
  });
});

describe('planReview', () => {
  it('settles a clear diff with no model call', async () => {
    let called = false;
    const plan = await planReview(
      [{ path: 'src/components/Nav.tsx' }, { path: 'api/routes/auth.ts' }, { path: 'README.md' }],
      // an unreachable model — proving the rules never reached for it
      {
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'mock',
        timeoutMs: 500,
      },
    );
    called = plan.files.some((f) => f.source === 'model');
    expect(called).toBe(false);
    expect(plan.surface).toBe('both');
    expect(plan.files.find((f) => f.path === 'README.md')?.surface).toBe('neither');
  });

  it('keeps the input order', async () => {
    const plan = await planReview([{ path: 'api/routes/a.ts' }, { path: 'src/pages/b.tsx' }]);
    expect(plan.files.map((f) => f.path)).toEqual(['api/routes/a.ts', 'src/pages/b.tsx']);
  });
});

describe('planReview with a model for the ambiguous files', () => {
  let server: Server;
  let baseUrl: string;
  let reply = '';

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
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends only the ambiguous paths to the model and uses its verdict', async () => {
    reply = JSON.stringify([
      { path: 'src/lib/pricing.ts', surface: 'both', reason: 'used by a form and an endpoint' },
    ]);
    const plan = await planReview(
      [{ path: 'src/components/Cart.tsx' }, { path: 'src/lib/pricing.ts' }],
      { baseUrl, model: 'mock', timeoutMs: 5000 },
    );
    const pricing = plan.files.find((f) => f.path === 'src/lib/pricing.ts');
    expect(pricing?.source).toBe('model');
    expect(pricing?.surface).toBe('both');
    expect(plan.surface).toBe('both');
  });

  it('defaults an unclassifiable file to both rather than dropping it', async () => {
    reply = 'the model is confused and returns prose';
    const plan = await planReview([{ path: 'src/lib/mystery.ts' }], {
      baseUrl,
      model: 'mock',
      timeoutMs: 5000,
    });
    expect(plan.files[0]?.surface).toBe('both');
    expect(plan.files[0]?.reason).toContain('to be safe');
  });
});

describe('changeset parsing', () => {
  it('reads git --numstat, keeping churn', () => {
    const cs = changesetFromNumstat('12\t3\tsrc/a.ts\n0\t0\tREADME.md', 'my change');
    expect(cs.files).toEqual([
      { path: 'src/a.ts', churn: 15 },
      { path: 'README.md', churn: 0 },
    ]);
    expect(cs.title).toBe('my change');
  });

  it('reads a gitlab changes payload and skips deletions', () => {
    const cs = changesetFromGitlab({
      title: 'Add checkout',
      changes: [
        { new_path: 'api/routes/checkout.ts', old_path: 'api/routes/checkout.ts' },
        { new_path: 'old.ts', old_path: 'old.ts', deleted_file: true },
        { new_path: 'src/pages/Checkout.tsx', old_path: 'src/pages/OldName.tsx' },
      ],
    });
    expect(cs.files.map((f) => f.path)).toEqual([
      'api/routes/checkout.ts',
      'src/pages/Checkout.tsx',
    ]);
    expect(cs.title).toBe('Add checkout');
  });

  it('reads a github files payload and skips removed files', () => {
    const cs = changesetFromGithub([
      { filename: 'src/App.tsx', status: 'modified', changes: 8 },
      { filename: 'gone.ts', status: 'removed', changes: 4 },
    ]);
    expect(cs.files).toEqual([{ path: 'src/App.tsx', churn: 8 }]);
  });

  it('pulls the issue and any links out of a jira webhook', () => {
    const trigger = jiraTrigger({
      issue: {
        key: 'SHOP-42',
        fields: {
          summary: 'Broken checkout',
          status: { name: 'In Review' },
          description: 'See the MR at https://gitlab.com/acme/shop/-/merge_requests/17 please',
        },
      },
    });
    expect(trigger.issueKey).toBe('SHOP-42');
    expect(trigger.status).toBe('In Review');
    expect(trigger.links).toContain('https://gitlab.com/acme/shop/-/merge_requests/17');
  });
});
