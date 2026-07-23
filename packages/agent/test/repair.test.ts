import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyRepair, proposeRepair, repairIsSafe } from '../src/repair.js';

import type { Repair } from '../src/repair.js';
import type { Failure, Triage } from '../src/triage.js';
import type { TestCase } from '@test-orchestrator/schema';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;
let reply = '';

const testCase = {
  id: 'login',
  version: '1.0',
  name: 'User logs in',
  runner: 'ui',
  steps: [
    { id: 'goto', action: 'goto', value: 'https://shop.test/login' },
    { id: 'fill', action: 'fill', target: '#email', value: 'ada@example.com' },
    { id: 'submit', action: 'click', target: 'button[type="submit"]' },
    { id: 'welcome', action: 'waitFor', target: '.welcome-message' },
  ],
} as unknown as TestCase;

const failure: Failure = {
  testCaseId: 'login',
  testCaseName: 'User logs in',
  stepNumber: 4,
  action: 'waitFor',
  target: '.welcome-message',
  message: 'waitForSelector: Timeout 5000ms exceeded',
  evidence: {
    url: 'https://shop.test/account',
    excerpt: 'Account Welcome, ada@example.com!',
    targetCount: 0,
    similarSelectors: ['.welcome-banner'],
  },
};

const triage = (over: Partial<Triage> = {}): Triage => ({
  testCaseId: 'login',
  verdict: 'test-bug',
  confidence: 'high',
  reason: 'the selector is stale',
  source: 'model',
  ...over,
});

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

const propose = (f: Failure = failure, t: Triage = triage()): ReturnType<typeof proposeRepair> =>
  proposeRepair(testCase, f, t, { baseUrl, model: 'mock', timeoutMs: 5000 });

describe('what a repair refuses to touch', () => {
  it('never repairs a product bug — that would hide a real defect', async () => {
    const p = await propose(failure, triage({ verdict: 'product-bug' }));
    expect(p.repair).toBeUndefined();
    expect(p.declined).toContain('only a test-bug');
  });

  it('never repairs an environment failure', async () => {
    const p = await propose(failure, triage({ verdict: 'environment' }));
    expect(p.repair).toBeUndefined();
  });

  it('never repairs bad test data — it will not invent credentials', async () => {
    const p = await propose(failure, triage({ verdict: 'test-data' }));
    expect(p.repair).toBeUndefined();
    expect(p.declined).toContain('only a test-bug');
  });

  it('will not act on a low-confidence verdict', async () => {
    const p = await propose(failure, triage({ confidence: 'low' }));
    expect(p.declined).toContain('not confident');
  });

  it('will not touch a selector that actually matched something', async () => {
    const p = await propose({ ...failure, evidence: { ...failure.evidence, targetCount: 3 } });
    expect(p.declined).toContain('not stale');
  });

  it('declines when the page offered nothing to point at', async () => {
    const p = await propose({
      ...failure,
      evidence: { url: 'x', targetCount: 0, similarSelectors: [] },
    });
    expect(p.declined).toContain('no replacement selector');
  });
});

describe('what a repair accepts from the model', () => {
  it('accepts a candidate the page really has', async () => {
    reply = JSON.stringify({ to: '.welcome-banner', rationale: 'the success banner was renamed' });
    const p = await propose();
    expect(p.repair?.from).toBe('.welcome-message');
    expect(p.repair?.to).toBe('.welcome-banner');
    expect(p.repair?.stepIndex).toBe(3);
  });

  it('rejects a selector the model made up', async () => {
    reply = JSON.stringify({ to: '.totally-invented', rationale: 'trust me' });
    const p = await propose();
    expect(p.repair).toBeUndefined();
    expect(p.declined).toContain('invented a selector');
  });

  it('accepts the model declining to guess', async () => {
    reply = JSON.stringify({ to: null, rationale: 'nothing means the same thing' });
    const p = await propose();
    expect(p.repair).toBeUndefined();
    expect(p.declined).toContain('no candidate');
  });

  it('survives an unreachable model', async () => {
    const p = await proposeRepair(testCase, failure, triage(), {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'mock',
      timeoutMs: 3000,
    });
    expect(p.repair).toBeUndefined();
    expect(p.declined).toContain('could not be repaired');
  });
});

describe('applying a repair', () => {
  const repair: Repair = {
    kind: 'retarget',
    stepIndex: 3,
    from: '.welcome-message',
    to: '.welcome-banner',
    rationale: 'renamed',
  };

  it('changes the one selector and nothing else', () => {
    const after = applyRepair(testCase, repair);
    expect(after.steps).toHaveLength(4);
    expect((after.steps[3] as { target: string }).target).toBe('.welcome-banner');
    expect((after.steps[3] as { action: string }).action).toBe('waitFor');
    expect(after.steps.slice(0, 3)).toEqual(testCase.steps.slice(0, 3));
    expect(repairIsSafe(testCase, after, repair)).toBeUndefined();
  });

  it('catches a repair that dropped the failing step', () => {
    const weakened = { ...testCase, steps: testCase.steps.slice(0, 3) } as TestCase;
    expect(repairIsSafe(testCase, weakened, repair)).toContain('add or remove steps');
  });

  it('catches a repair that weakened an expectation', () => {
    const weakened = {
      ...testCase,
      steps: testCase.steps.map((s, i) => (i === 3 ? { ...s, action: 'audit' } : s)),
    } as TestCase;
    expect(repairIsSafe(testCase, weakened, repair)).toContain("only change a step's target");
  });

  it('catches a repair that touched an unrelated step', () => {
    const tampered = {
      ...testCase,
      steps: testCase.steps.map((s, i) => (i === 1 ? { ...s, value: 'someone@else.com' } : s)),
    } as TestCase;
    expect(repairIsSafe(testCase, tampered, repair)).toContain('only change the failing step');
  });
});
