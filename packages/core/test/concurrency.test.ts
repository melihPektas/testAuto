import { describe, expect, it } from 'vitest';

import { executeRun } from '../src/engine/engine.js';
import { createRunnerRegistry } from '../src/registry/registries.js';

import type {
  OrchestratorEvent,
  RunOptions,
  Runner,
  RunnerRegistry,
  StepResult,
} from '../src/types.js';

const config = {
  version: '1.0',
  name: 'concurrency',
  runners: [{ name: 'slow', type: 'test' }],
} as unknown as RunOptions['config'];

function testCases(count: number): RunOptions['testCases'] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${String(i + 1)}`,
    version: '1.0',
    name: `test ${String(i + 1)}`,
    runner: 'slow',
    steps: [{ id: 's', action: 'wait' }],
  })) as unknown as RunOptions['testCases'];
}

/** A runner that takes 50ms per step and reports how many ran at once. */
function makeRunner(state: { active: number; peak: number; instances: number }): Runner {
  state.instances += 1;
  const id = state.instances;
  return {
    name: 'slow',
    runStep: async (): Promise<StepResult> => {
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      state.active -= 1;
      return { status: 'pass', durationMs: 50, output: `lane ${String(id)}` };
    },
  };
}

function registryFor(state: { active: number; peak: number; instances: number }): RunnerRegistry {
  const registry = createRunnerRegistry();
  registry.register(makeRunner(state));
  return registry;
}

describe('concurrency', () => {
  it('runs one test at a time by default', async () => {
    const state = { active: 0, peak: 0, instances: 0 };
    const summary = await executeRun({
      config,
      testCases: testCases(4),
      runners: registryFor(state),
    });
    expect(summary.passed).toBe(4);
    expect(state.peak).toBe(1);
  });

  it('runs several tests at once when asked', async () => {
    const state = { active: 0, peak: 0, instances: 0 };
    const summary = await executeRun({
      config,
      testCases: testCases(8),
      runners: registryFor(state),
      concurrency: 4,
      createRunners: () => registryFor(state),
    });
    expect(summary.passed).toBe(8);
    expect(state.peak).toBeGreaterThan(1);
    expect(state.peak).toBeLessThanOrEqual(4);
  });

  it('builds one runner per lane, not one per test', async () => {
    const state = { active: 0, peak: 0, instances: 0 };
    await executeRun({
      config,
      testCases: testCases(12),
      runners: registryFor(state),
      concurrency: 3,
      createRunners: () => registryFor(state),
    });
    // 1 for the registry passed in, plus one per lane
    expect(state.instances).toBe(4);
  });

  it('keeps results in the order the tests were declared', async () => {
    const state = { active: 0, peak: 0, instances: 0 };
    const summary = await executeRun({
      config,
      testCases: testCases(10),
      runners: registryFor(state),
      concurrency: 5,
      createRunners: () => registryFor(state),
    });
    expect(summary.results.map((r) => r.testCaseId)).toEqual([
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
      't7',
      't8',
      't9',
      't10',
    ]);
  });

  it('refuses to share one runner across lanes', async () => {
    const state = { active: 0, peak: 0, instances: 0 };
    await expect(
      executeRun({
        config,
        testCases: testCases(4),
        runners: registryFor(state),
        concurrency: 4,
      }),
    ).rejects.toThrow(/createRunners/);
  });

  it('is actually faster', async () => {
    const state = { active: 0, peak: 0, instances: 0 };
    const serialStart = Date.now();
    await executeRun({ config, testCases: testCases(6), runners: registryFor(state) });
    const serial = Date.now() - serialStart;

    const parallelStart = Date.now();
    await executeRun({
      config,
      testCases: testCases(6),
      runners: registryFor(state),
      concurrency: 6,
      createRunners: () => registryFor(state),
    });
    const parallel = Date.now() - parallelStart;

    expect(parallel).toBeLessThan(serial / 2);
  });
});

describe('reports under concurrency', () => {
  it('writes results in the declared order, not the order they finished', async () => {
    const state = { active: 0, peak: 0, instances: 0 };
    const seen: string[] = [];
    const captured: string[] = [];

    const reporter = {
      kind: 'reporter' as const,
      name: 'capture',
      type: 'capture',
      onEvent: (event: OrchestratorEvent): void => {
        if (event.type === 'test:end') {
          seen.push(event.result.testCaseId);
        }
        if (event.type === 'run:end') {
          captured.push(...event.results.map((r) => r.testCaseId));
        }
      },
    };

    // Later tests finish sooner, so completion order cannot match declared order.
    const registry = (): RunnerRegistry => {
      const r = createRunnerRegistry();
      state.instances += 1;
      r.register({
        name: 'slow',
        runStep: async (ctx): Promise<StepResult> => {
          const n = Number(ctx.testCase.id.replace('t', ''));
          await new Promise((resolve) => setTimeout(resolve, (5 - n) * 30));
          return { status: 'pass', durationMs: 0 };
        },
      });
      return r;
    };

    await executeRun({
      config,
      testCases: testCases(4),
      runners: registry(),
      reporters: [reporter],
      concurrency: 4,
      createRunners: registry,
    });

    expect(captured).toEqual(['t1', 't2', 't3', 't4']);
    // and the point of the fix: the events really did arrive out of order
    expect(seen).not.toEqual(captured);
  });
});

describe('evidence on an engine-level failure', () => {
  const hangingRunner = (captured: { calls: number }): RunnerRegistry => {
    const r = createRunnerRegistry();
    r.register({
      name: 'slow',
      // never settles: the engine's timeout is what ends this step
      runStep: () => new Promise<StepResult>(() => undefined),
      captureFailure: async () => {
        captured.calls += 1;
        return { url: 'https://shop.test/checkout', targetCount: 0 };
      },
    });
    return r;
  };

  it('asks the runner what happened when it times the step out', async () => {
    const captured = { calls: 0 };
    const summary = await executeRun({
      config,
      testCases: [
        {
          id: 'hangs',
          version: '1.0',
          name: 'hangs forever',
          runner: 'slow',
          timeout: 100,
          steps: [{ id: 's', action: 'wait' }],
        },
      ] as unknown as RunOptions['testCases'],
      runners: hangingRunner(captured),
    });

    expect(summary.failed).toBe(1);
    expect(captured.calls).toBe(1);
    // the whole point: the failure with the least explanation still gets evidence
    expect(summary.results[0]?.steps[0]?.evidence).toEqual({
      url: 'https://shop.test/checkout',
      targetCount: 0,
    });
  });

  it('does not let a hanging capture hold up the run', async () => {
    const registry = createRunnerRegistry();
    registry.register({
      name: 'slow',
      runStep: () => new Promise<StepResult>(() => undefined),
      captureFailure: () => new Promise<undefined>(() => undefined),
    });

    const started = Date.now();
    const summary = await executeRun({
      config,
      testCases: [
        {
          id: 'hangs',
          version: '1.0',
          name: 'hangs forever',
          runner: 'slow',
          timeout: 100,
          steps: [{ id: 's', action: 'wait' }],
        },
      ] as unknown as RunOptions['testCases'],
      runners: registry,
    });

    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.steps[0]?.evidence).toBeUndefined();
    // capture is budgeted at 8s; without the budget this would never return
    expect(Date.now() - started).toBeLessThan(11_000);
  }, 20_000);

  it('survives a runner that throws while describing the failure', async () => {
    const registry = createRunnerRegistry();
    registry.register({
      name: 'slow',
      runStep: () => new Promise<StepResult>(() => undefined),
      captureFailure: () => Promise.reject(new Error('the page is gone')),
    });

    const summary = await executeRun({
      config,
      testCases: [
        {
          id: 'hangs',
          version: '1.0',
          name: 'hangs forever',
          runner: 'slow',
          timeout: 100,
          steps: [{ id: 's', action: 'wait' }],
        },
      ] as unknown as RunOptions['testCases'],
      runners: registry,
    });
    // the original timeout is what gets reported, not the capture's failure
    expect(summary.results[0]?.steps[0]?.error?.message).toContain('timed out');
  });
});

describe('lane teardown', () => {
  const countingRunner = (counts: {
    init: number;
    dispose: number;
    shutdown: number;
  }): RunnerRegistry => {
    const r = createRunnerRegistry();
    r.register({
      name: 'slow',
      init: () => {
        counts.init += 1;
      },
      runStep: () => Promise.resolve({ status: 'pass', durationMs: 0 } as StepResult),
      dispose: () => {
        counts.dispose += 1;
      },
      shutdown: () => {
        counts.shutdown += 1;
      },
    });
    return r;
  };

  it('shuts a runner down once per lane, not once per test', async () => {
    const counts = { init: 0, dispose: 0, shutdown: 0 };
    await executeRun({
      config,
      testCases: testCases(12),
      runners: countingRunner(counts),
      concurrency: 3,
      createRunners: () => countingRunner(counts),
    });
    // per test: init and dispose. per lane: one shutdown. The registry passed
    // in is never used once createRunners is supplied, so it is never torn
    // down either — the engine shuts down what it actually ran with.
    expect(counts.init).toBe(12);
    expect(counts.dispose).toBe(12);
    expect(counts.shutdown).toBe(3);
  });

  it('shuts down even when a test throws', async () => {
    const counts = { init: 0, dispose: 0, shutdown: 0 };
    const registry = createRunnerRegistry();
    registry.register({
      name: 'slow',
      runStep: () => Promise.reject(new Error('boom')),
      shutdown: () => {
        counts.shutdown += 1;
      },
    });
    await executeRun({ config, testCases: testCases(2), runners: registry });
    expect(counts.shutdown).toBe(1);
  });

  it('does not lose results when teardown itself fails', async () => {
    const registry = createRunnerRegistry();
    registry.register({
      name: 'slow',
      runStep: () => Promise.resolve({ status: 'pass', durationMs: 0 } as StepResult),
      shutdown: () => Promise.reject(new Error('could not close')),
    });
    const summary = await executeRun({ config, testCases: testCases(3), runners: registry });
    expect(summary.passed).toBe(3);
  });
});
