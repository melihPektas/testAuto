import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createJsonReporter } from '../src/reporters/json-reporter.js';
import { createJunitReporter } from '../src/reporters/junit-reporter.js';

import type { OrchestratorEvent, TestOrchestratorConfig, TestResult } from '../src/types.js';

const config: TestOrchestratorConfig = {
  version: '1.0',
  name: 'suite',
  runners: [{ name: 'shell', type: 'shell' }],
};

function result(name: string, status: TestResult['status'], errorMessage?: string): TestResult {
  const base: TestResult = {
    testCaseId: name,
    testCaseName: name,
    status,
    durationMs: 1500,
    steps: [],
    startedAt: new Date(),
    finishedAt: new Date(),
  };
  return errorMessage === undefined ? base : { ...base, error: { message: errorMessage } };
}

async function feed(
  reporter: { onEvent?: (e: OrchestratorEvent) => Promise<void> | void },
  results: TestResult[],
): Promise<void> {
  await reporter.onEvent?.({ type: 'run:start', config });
  for (const r of results) {
    await reporter.onEvent?.({ type: 'test:end', result: r });
  }
  await reporter.onEvent?.({ type: 'run:end', config, totalDurationMs: 42 });
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'to-reporters-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createJsonReporter', () => {
  it('writes a JSON summary with counts and results', async () => {
    const out = join(dir, 'report.json');
    const reporter = createJsonReporter(out);
    await feed(reporter, [result('a', 'pass'), result('b', 'fail', 'boom')]);
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      total: number;
      passed: number;
      failed: number;
      durationMs: number;
      results: unknown[];
    };
    expect(parsed.total).toBe(2);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.durationMs).toBe(42);
    expect(parsed.results).toHaveLength(2);
  });
});

describe('createJunitReporter', () => {
  it('writes JUnit XML with a failure element and escaped content', async () => {
    const out = join(dir, 'report.xml');
    const reporter = createJunitReporter(out);
    await feed(reporter, [result('ok', 'pass'), result('a & b', 'fail', 'bad <thing>')]);
    const xml = await readFile(out, 'utf8');
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('name="a &amp; b"');
    expect(xml).toContain('<failure message="bad &lt;thing&gt;">');
  });
});
