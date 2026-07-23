import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { failuresFromReport, ruleTriage, triageFailure, triageFailures } from '../src/triage.js';

import type { Failure } from '../src/triage.js';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;
let reply = '';
let calls = 0;

const failure = (over: Partial<Failure> = {}): Failure => ({
  testCaseId: 'c1',
  testCaseName: 'Search returns results',
  stepNumber: 4,
  action: 'waitFor',
  target: '.welcome-message',
  message: 'page.waitForSelector: Timeout 5000ms exceeded.',
  priorOutput: ['navigated to https://shop.test/login (200)', 'filled "#email"'],
  ...over,
});

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on('data', () => {
      // drain
    });
    req.on('end', () => {
      calls += 1;
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

describe('ruleTriage', () => {
  it('calls a 403 an environment problem, not a bug', () => {
    const t = ruleTriage(failure({ message: 'expected status 200 but got 403' }));
    expect(t?.verdict).toBe('environment');
    expect(t?.confidence).toBe('high');
    expect(t?.source).toBe('rule');
  });

  it('calls a 5xx a product bug', () => {
    expect(ruleTriage(failure({ message: 'expected status 200 but got 503' }))?.verdict).toBe(
      'product-bug',
    );
  });

  it('calls a 404 a test bug', () => {
    expect(ruleTriage(failure({ message: 'expected status 200 but got 404' }))?.verdict).toBe(
      'test-bug',
    );
  });

  it('calls an unreachable host an environment problem', () => {
    expect(
      ruleTriage(failure({ message: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.test' }))
        ?.verdict,
    ).toBe('environment');
  });

  it('calls a step that needed a retry flaky', () => {
    expect(ruleTriage(failure({ retries: 2 }))?.verdict).toBe('flaky');
  });

  it('defers a missing selector to judgement', () => {
    expect(ruleTriage(failure())).toBeUndefined();
  });
});

describe('triageFailure', () => {
  it('never calls the model when a rule already decided', async () => {
    calls = 0;
    const t = await triageFailure(failure({ message: 'expected status 200 but got 403' }), {
      baseUrl,
      model: 'mock',
      timeoutMs: 5000,
    });
    expect(t.source).toBe('rule');
    expect(calls).toBe(0);
  });

  it('accepts a well-formed model verdict', async () => {
    reply = JSON.stringify({
      verdict: 'test-data',
      confidence: 'high',
      reason: 'the credentials used do not exist on this site',
      suggestion: 'supply real test credentials',
    });
    const t = await triageFailure(failure(), { baseUrl, model: 'mock', timeoutMs: 5000 });
    expect(t.verdict).toBe('test-data');
    expect(t.suggestion).toBe('supply real test credentials');
    expect(t.source).toBe('model');
  });

  it('refuses a verdict that is not in the vocabulary', async () => {
    reply = JSON.stringify({ verdict: 'works-on-my-machine', confidence: 'high', reason: 'x' });
    const t = await triageFailure(failure(), { baseUrl, model: 'mock', timeoutMs: 5000 });
    expect(t.confidence).toBe('low');
    expect(t.reason).toContain('unknown verdict');
  });

  it('survives an unreachable model', async () => {
    const t = await triageFailure(failure(), {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'mock',
      timeoutMs: 3000,
    });
    expect(t.confidence).toBe('low');
    expect(t.reason).toContain('could not be triaged');
  });
});

describe('evidence reaches the model', () => {
  it('puts what the page showed into the prompt', async () => {
    let seen = '';
    const capture = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += String(c);
      });
      req.on('end', () => {
        seen = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict: 'test-data',
                    confidence: 'high',
                    reason: 'the page said the credentials were invalid',
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => capture.listen(0, resolve));
    const url = `http://127.0.0.1:${(capture.address() as AddressInfo).port}/v1`;

    const t = await triageFailure(
      failure({
        evidence: {
          url: 'http://shop.test/login',
          title: 'Sign in',
          bodyChars: 85,
          excerpt: 'Sign in Invalid email or password.',
          targetCount: 0,
          similarSelectors: ['.error-message'],
        },
      }),
      { baseUrl: url, model: 'mock', timeoutMs: 5000 },
    );

    expect(t.verdict).toBe('test-data');
    expect(seen).toContain('.error-message');
    expect(seen).toContain('matched 0 element');
    await new Promise<void>((resolve) => capture.close(() => resolve()));
  });
});

describe('failuresFromReport', () => {
  const report = {
    results: [
      { testCaseId: 'ok', testCaseName: 'passes', status: 'pass', steps: [] },
      {
        testCaseId: 'bad',
        testCaseName: 'fails on step 2',
        status: 'fail',
        steps: [
          { status: 'pass', action: 'goto', output: 'navigated to https://shop.test (200)' },
          {
            status: 'fail',
            action: 'expectMinCount',
            error: { message: 'found 0' },
            retries: 0,
            evidence: { url: 'https://shop.test', targetCount: 0 },
          },
        ],
      },
    ],
  };

  it('picks out only the failures, with the failing step located', () => {
    const failures = failuresFromReport(report);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.stepNumber).toBe(2);
    expect(failures[0]?.action).toBe('expectMinCount');
    expect(failures[0]?.message).toBe('found 0');
    expect(failures[0]?.priorOutput).toEqual(['navigated to https://shop.test (200)']);
  });

  it('carries the rest of the run, which is what separates a bug from bad data', () => {
    const failures = failuresFromReport(report);
    expect(failures[0]?.runContext).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      passingTests: ['passes'],
    });
  });

  it('carries the runner evidence through to triage', () => {
    expect(failuresFromReport(report)[0]?.evidence).toEqual({
      url: 'https://shop.test',
      targetCount: 0,
    });
  });

  it('recovers the failing step target and value from the test case', () => {
    const failures = failuresFromReport(report, [
      {
        id: 'bad',
        steps: [
          { action: 'goto', value: 'https://shop.test' },
          { action: 'expectMinCount', target: '.card', value: 1 },
        ],
      },
    ]);
    expect(failures[0]?.target).toBe('.card');
    expect(failures[0]?.value).toBe(1);
  });
});

describe('triageFailures', () => {
  it('counts verdicts and where they came from', async () => {
    reply = JSON.stringify({ verdict: 'test-bug', confidence: 'high', reason: 'bad selector' });
    const summary = await triageFailures(
      [failure({ message: 'expected status 200 but got 403' }), failure()],
      { baseUrl, model: 'mock', timeoutMs: 5000 },
    );
    expect(summary.byRule).toBe(1);
    expect(summary.byModel).toBe(1);
    expect(summary.byVerdict['environment']).toBe(1);
    expect(summary.byVerdict['test-bug']).toBe(1);
  });
});
