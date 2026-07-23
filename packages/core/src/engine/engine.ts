import { RunnerError, toOrchestratorError } from '../errors/index.js';
import { noopLogger } from '../utils/logger.js';

import type { Hooks } from '../hooks/hooks.js';
import type { RunnerRegistry } from '../registry/registries.js';
import type {
  Logger,
  OrchestratorEvent,
  Reporter,
  Runner,
  RunContext,
  Step,
  StepResult,
  TestCase,
  TestResult,
  TestOrchestratorConfig,
  Workspace,
} from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Context handed to lifecycle hooks. Fields are populated for the phases where
 * they make sense (`testCase` from `beforeTest` on, `step` around step hooks).
 *
 * @public
 */
export interface HookContext {
  readonly config: TestOrchestratorConfig;
  readonly testCase?: TestCase;
  readonly step?: Step;
  readonly result?: TestResult;
  readonly stepResult?: StepResult;
}

export interface RunOptions {
  readonly config: TestOrchestratorConfig;
  readonly testCases: readonly TestCase[];
  readonly runners: RunnerRegistry;
  readonly reporters?: readonly Reporter[];
  readonly logger?: Logger;
  readonly workspace?: Workspace;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
  /** Lifecycle hooks (see {@link createHooks}); emitted around the run, tests and steps. */
  readonly hooks?: Hooks<HookContext>;
}

export interface RunSummary {
  readonly status: 'pass' | 'fail' | 'flaky';
  readonly results: readonly TestResult[];
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly flaky: number;
  readonly durationMs: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

interface ErrorInfo {
  message: string;
  code?: string;
  stack?: string;
}

function toErrorInfo(err: unknown): ErrorInfo {
  const e = toOrchestratorError(err);
  const info: ErrorInfo = { message: e.message, code: e.code };
  if (e.stack !== undefined) {
    info.stack = e.stack;
  }
  return info;
}

function defaultWorkspace(): Workspace {
  const root = process.cwd();
  return {
    root,
    artifacts: `${root}/.artifacts`,
    temp: `${root}/.tmp`,
    resolve: (path: string): string => (path.startsWith('/') ? path : `${root}/${path}`),
  };
}

function resolveRunner(
  testCase: TestCase,
  config: TestOrchestratorConfig,
  runners: RunnerRegistry,
): Runner {
  const name = testCase.runner ?? config.defaults?.runner ?? config.runners[0]?.name;
  if (name === undefined) {
    throw new RunnerError(
      'ORCH_RUNNER_NOT_FOUND',
      'No runner could be resolved for the test case',
      {
        context: { testCase: testCase.id },
      },
    );
  }
  const runner = runners.list().find((r) => r.name === name);
  if (runner === undefined) {
    throw new RunnerError('ORCH_RUNNER_NOT_FOUND', `No runner registered with name "${name}"`, {
      context: { testCase: testCase.id, runner: name },
    });
  }
  return runner;
}

async function withTimeout(
  promise: Promise<StepResult>,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<StepResult> {
  return new Promise<StepResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RunnerError('ORCH_TIMEOUT', `Step timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RunnerError('ORCH_RUNTIME_ERROR', 'Run aborted'));
    };
    if (parentSignal.aborted) {
      onAbort();
      return;
    }
    parentSignal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        parentSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        parentSignal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function executeStep(
  runner: Runner,
  ctx: RunContext,
  timeoutMs: number,
  maxRetries: number,
): Promise<StepResult> {
  let attempt = 0;
  let last: StepResult = { status: 'fail', durationMs: 0 };
  for (;;) {
    const started = Date.now();
    try {
      const result = await withTimeout(Promise.resolve(runner.runStep(ctx)), timeoutMs, ctx.signal);
      const durationMs = result.durationMs || Date.now() - started;
      if (result.status === 'pass') {
        return { ...result, durationMs, retries: attempt };
      }
      last = { ...result, durationMs, retries: attempt };
    } catch (err) {
      last = {
        status: 'fail',
        durationMs: Date.now() - started,
        error: toErrorInfo(err),
        retries: attempt,
      };
    }
    if (attempt >= maxRetries) {
      return last;
    }
    attempt += 1;
  }
}

async function emit(reporters: readonly Reporter[], event: OrchestratorEvent): Promise<void> {
  for (const reporter of reporters) {
    if (reporter.onEvent !== undefined) {
      await reporter.onEvent(event);
    }
  }
}

async function runTestCase(
  testCase: TestCase,
  config: TestOrchestratorConfig,
  runners: RunnerRegistry,
  reporters: readonly Reporter[],
  base: Omit<RunContext, 'testCase' | 'step'>,
  hooks: Hooks<HookContext> | undefined,
): Promise<TestResult> {
  await hooks?.emit('beforeTest', { config, testCase });
  const startedAt = new Date();
  const start = Date.now();
  const steps: StepResult[] = [];
  let runner: Runner;
  try {
    runner = resolveRunner(testCase, config, runners);
  } catch (err) {
    const finishedAt = new Date();
    return {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      status: 'fail',
      durationMs: Date.now() - start,
      steps,
      error: toErrorInfo(err),
      startedAt,
      finishedAt,
    };
  }

  const testCtxBase: RunContext = { ...base, testCase };
  if (runner.init !== undefined) {
    await runner.init(testCtxBase);
  }

  for (const step of testCase.steps) {
    const stepCtx: RunContext = { ...base, testCase, step };
    await emit(reporters, { type: 'step:start', testCase, step });
    await hooks?.emit('beforeStep', { config, testCase, step });
    const timeoutMs = step.timeout ?? testCase.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = step.retry ?? testCase.retry ?? config.defaults?.retry ?? 0;
    const executed = await executeStep(runner, stepCtx, timeoutMs, maxRetries);
    // Stamp the result with what it was: a report that only says "step 4 failed"
    // cannot be diagnosed by a human or by the triager.
    const result: StepResult = {
      ...executed,
      ...(step.id !== undefined ? { stepId: step.id } : {}),
      ...(step.action !== undefined ? { action: step.action } : {}),
    };
    steps.push(result);
    await emit(reporters, { type: 'step:end', testCase, step, result });
    await hooks?.emit('afterStep', { config, testCase, step, stepResult: result });
    if (result.status === 'fail') {
      break;
    }
  }

  if (runner.dispose !== undefined) {
    await runner.dispose(testCtxBase);
  }

  const finishedAt = new Date();
  const status: TestResult['status'] = steps.some((s) => s.status === 'fail')
    ? 'fail'
    : steps.some((s) => s.status === 'flaky' || (s.retries ?? 0) > 0)
      ? 'flaky'
      : 'pass';

  const result: TestResult = {
    testCaseId: testCase.id,
    testCaseName: testCase.name,
    status,
    durationMs: Date.now() - start,
    steps,
    startedAt,
    finishedAt,
  };
  // Surface the failing step's error at the test level so reporters can show it.
  const failedStep = steps.find((s) => s.status === 'fail');
  const finalResult =
    failedStep?.error === undefined ? result : { ...result, error: failedStep.error };
  await hooks?.emit('afterTest', { config, testCase, result: finalResult });
  return finalResult;
}

/**
 * Execute a full run: every test case is dispatched to its resolved runner,
 * steps run sequentially with per-step timeout and retry, and lifecycle events
 * are emitted to all reporters. Returns an aggregate {@link RunSummary}.
 *
 * @public
 */
export async function executeRun(options: RunOptions): Promise<RunSummary> {
  const { config, testCases, runners } = options;
  const reporters = options.reporters ?? [];
  const logger = options.logger ?? noopLogger;
  const workspace = options.workspace ?? defaultWorkspace();
  const env = options.env ?? {};
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;

  const base: Omit<RunContext, 'testCase' | 'step'> = {
    config,
    env,
    logger,
    signal,
    workspace,
  };

  const startedAt = new Date();
  const start = Date.now();
  await options.hooks?.emit('beforeRun', { config });
  await emit(reporters, { type: 'run:start', config });

  const results: TestResult[] = [];
  for (const testCase of testCases) {
    await emit(reporters, { type: 'test:start', testCase });
    const result = await runTestCase(testCase, config, runners, reporters, base, options.hooks);
    results.push(result);
    await emit(reporters, { type: 'test:end', result });
  }

  const durationMs = Date.now() - start;
  await emit(reporters, { type: 'run:end', config, totalDurationMs: durationMs });
  await options.hooks?.emit('afterRun', { config });
  const finishedAt = new Date();

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const flaky = results.filter((r) => r.status === 'flaky').length;
  const status: RunSummary['status'] = failed > 0 ? 'fail' : flaky > 0 ? 'flaky' : 'pass';

  return {
    status,
    results,
    total: results.length,
    passed,
    failed,
    flaky,
    durationMs,
    startedAt,
    finishedAt,
  };
}
