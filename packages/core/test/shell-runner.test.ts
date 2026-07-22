import { describe, expect, it } from 'vitest';

import { createShellRunner } from '../src/runners/shell-runner.js';

import type { RunContext, Step } from '../src/types.js';

function ctxFor(action: string | undefined): RunContext {
  const step = action === undefined ? undefined : ({ action } as Step);
  return {
    config: { version: '1.0', name: 't', runners: [{ name: 'shell', type: 'shell' }] },
    testCase: { id: 't', version: '1.0', name: 't', steps: [{ action: 'x' }] },
    step,
    env: {},
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child() {
        return this;
      },
    },
    signal: new AbortController().signal,
    workspace: { root: '.', artifacts: '.', temp: '.', resolve: (p) => p },
  };
}

describe('createShellRunner', () => {
  it('has the runner shape', () => {
    const runner = createShellRunner();
    expect(runner.kind).toBe('runner');
    expect(runner.name).toBe('shell');
    expect(runner.type).toBe('shell');
  });

  it('passes when the command exits 0', async () => {
    const result = await createShellRunner().runStep(ctxFor('exit 0'));
    expect(result.status).toBe('pass');
  });

  it('captures stdout on success', async () => {
    const result = await createShellRunner().runStep(ctxFor('echo hello'));
    expect(result.status).toBe('pass');
    expect(result.output).toContain('hello');
  });

  it('fails when the command exits non-zero', async () => {
    const result = await createShellRunner().runStep(ctxFor('exit 3'));
    expect(result.status).toBe('fail');
    expect(result.error?.code).toBe('ORCH_STEP_FAILED');
  });

  it('fails when there is no action', async () => {
    const result = await createShellRunner().runStep(ctxFor(undefined));
    expect(result.status).toBe('fail');
    expect(result.error?.message).toBe('no action to run');
  });
});
