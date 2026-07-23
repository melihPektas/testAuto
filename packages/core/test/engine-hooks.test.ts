import { describe, expect, it } from 'vitest';

import { executeRun } from '../src/engine/engine.js';
import { createHooks } from '../src/hooks/hooks.js';
import { createRunnerRegistry } from '../src/registry/registries.js';

import type { HookContext } from '../src/engine/engine.js';
import type { RunOptions, Runner, StepResult } from '../src/types.js';

function passingRunner(): Runner {
  return {
    kind: 'runner',
    name: 'fake',
    type: 'fake',
    runStep: () => ({ status: 'pass', durationMs: 1 }) satisfies StepResult,
  };
}

function makeRun(hooks: ReturnType<typeof createHooks<HookContext>>): Promise<unknown> {
  const runners = createRunnerRegistry();
  runners.register(passingRunner() as unknown as Parameters<typeof runners.register>[0]);
  return executeRun({
    config: {
      version: '1.0',
      name: 'suite',
      runners: [{ name: 'fake', type: 'fake' }],
    } as unknown as RunOptions['config'],
    testCases: [
      {
        id: 't1',
        version: '1.0',
        name: 'case',
        runner: 'fake',
        steps: [{ action: 'a' }, { action: 'b' }],
      } as unknown,
    ] as unknown as RunOptions['testCases'],
    runners,
    hooks,
  });
}

describe('engine lifecycle hooks', () => {
  it('emits run, test and step hooks in order', async () => {
    const seen: string[] = [];
    const hooks = createHooks<HookContext>();
    for (const name of ['beforeRun', 'beforeTest', 'beforeStep', 'afterStep', 'afterTest', 'afterRun'] as const) {
      hooks.on(name, () => {
        seen.push(name);
      });
    }

    await makeRun(hooks);

    expect(seen[0]).toBe('beforeRun');
    expect(seen[1]).toBe('beforeTest');
    expect(seen.at(-1)).toBe('afterRun');
    expect(seen.at(-2)).toBe('afterTest');
    // two steps → two before/after step pairs
    expect(seen.filter((s) => s === 'beforeStep')).toHaveLength(2);
    expect(seen.filter((s) => s === 'afterStep')).toHaveLength(2);
  });

  it('passes the test case and step through the hook context', async () => {
    const contexts: HookContext[] = [];
    const hooks = createHooks<HookContext>();
    hooks.on('beforeStep', (ctx) => {
      contexts.push(ctx);
    });
    hooks.on('afterTest', (ctx) => {
      contexts.push(ctx);
    });

    await makeRun(hooks);

    const stepCtx = contexts[0];
    expect(stepCtx?.testCase?.id).toBe('t1');
    expect(stepCtx?.step?.action).toBe('a');
    const testCtx = contexts.at(-1);
    expect(testCtx?.result?.status).toBe('pass');
  });
});
