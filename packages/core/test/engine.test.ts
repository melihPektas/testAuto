import { describe, expect, it } from 'vitest';

import { executeRun } from '../src/engine/engine.js';
import { createRunnerRegistry } from '../src/registry/registries.js';
import type {
  OrchestratorEvent,
  Reporter,
  Runner,
  RunContext,
  StepResult,
  TestCase,
  TestOrchestratorConfig,
} from '../src/types.js';

function makeConfig(): TestOrchestratorConfig {
  return {
    version: '1.0',
    name: 'suite',
    runners: [{ name: 'fake', type: 'fake' }],
  };
}

function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1',
    version: '1.0',
    name: 'case one',
    runner: 'fake',
    steps: [{ action: 'a' }, { action: 'b' }],
    ...overrides,
  };
}

function makeRunner(runStep: (ctx: RunContext) => Promise<StepResult> | StepResult): Runner {
  return { kind: 'runner', name: 'fake', type: 'fake', runStep };
}

function registryWith(runner: Runner): ReturnType<typeof createRunnerRegistry> {
  const reg = createRunnerRegistry();
  reg.register(runner as unknown as Parameters<typeof reg.register>[0]);
  return reg;
}

const pass: StepResult = { status: 'pass', durationMs: 1 };

describe('executeRun', () => {
  it('passes when every step passes', async () => {
    const summary = await executeRun({
      config: makeConfig(),
      testCases: [makeCase()],
      runners: registryWith(makeRunner(() => pass)),
    });
    expect(summary.status).toBe('pass');
    expect(summary.passed).toBe(1);
    expect(summary.results[0]?.steps).toHaveLength(2);
  });

  it('fails the test and stops at the first failing step', async () => {
    let calls = 0;
    const runner = makeRunner(() => {
      calls += 1;
      return { status: 'fail', durationMs: 1 } satisfies StepResult;
    });
    const summary = await executeRun({
      config: makeConfig(),
      testCases: [makeCase()],
      runners: registryWith(runner),
    });
    expect(summary.status).toBe('fail');
    expect(summary.failed).toBe(1);
    // second step must be skipped after the first fails
    expect(calls).toBe(1);
    expect(summary.results[0]?.steps).toHaveLength(1);
  });

  it('marks a test flaky when a step passes only after a retry', async () => {
    let attempts = 0;
    const runner = makeRunner(() => {
      attempts += 1;
      return attempts === 1
        ? ({ status: 'fail', durationMs: 1 } satisfies StepResult)
        : pass;
    });
    const summary = await executeRun({
      config: makeConfig(),
      testCases: [makeCase({ steps: [{ action: 'a', retry: 1 }] })],
      runners: registryWith(runner),
    });
    expect(summary.status).toBe('flaky');
    expect(summary.flaky).toBe(1);
    expect(summary.results[0]?.steps[0]?.retries).toBe(1);
  });

  it('fails with ORCH_RUNNER_NOT_FOUND when no runner matches', async () => {
    const summary = await executeRun({
      config: makeConfig(),
      testCases: [makeCase({ runner: 'missing' })],
      runners: createRunnerRegistry(),
    });
    expect(summary.status).toBe('fail');
    expect(summary.results[0]?.error?.code).toBe('ORCH_RUNNER_NOT_FOUND');
  });

  it('times out a step that never resolves', async () => {
    const runner = makeRunner(() => new Promise<StepResult>(() => undefined));
    const summary = await executeRun({
      config: makeConfig(),
      testCases: [makeCase({ steps: [{ action: 'slow', timeout: 30 }] })],
      runners: registryWith(runner),
    });
    expect(summary.status).toBe('fail');
    expect(summary.results[0]?.steps[0]?.error?.code).toBe('ORCH_TIMEOUT');
  });

  it('emits lifecycle events to reporters in order', async () => {
    const events: OrchestratorEvent['type'][] = [];
    const reporter: Reporter = {
      kind: 'reporter',
      name: 'rec',
      type: 'rec',
      onEvent: (e) => {
        events.push(e.type);
      },
    };
    await executeRun({
      config: makeConfig(),
      testCases: [makeCase({ steps: [{ action: 'a' }] })],
      runners: registryWith(makeRunner(() => pass)),
      reporters: [reporter],
    });
    expect(events).toEqual([
      'run:start',
      'test:start',
      'step:start',
      'step:end',
      'test:end',
      'run:end',
    ]);
  });
});
