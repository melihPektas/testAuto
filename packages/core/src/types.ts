import type { TestOrchestratorConfig, TestCase, Step, Expected } from '@test-orchestrator/schema';

export type { TestOrchestratorConfig, TestCase, Step, Expected };

export type PluginKind = 'runner' | 'generator' | 'reporter' | 'plugin';

export interface RunContext {
  readonly config: TestOrchestratorConfig;
  readonly testCase: TestCase;
  readonly step?: Step;
  readonly env: Record<string, string>;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly workspace: Workspace;
}

export interface Workspace {
  readonly root: string;
  readonly artifacts: string;
  readonly temp: string;
  resolve(path: string): string;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(scope: string): Logger;
}

export interface Runner {
  readonly kind: 'runner';
  readonly name: string;
  readonly type: string;
  init?(ctx: RunContext): Promise<void> | void;
  runStep(ctx: RunContext): Promise<StepResult>;
  /**
   * Describe the world at the moment a step failed *outside* the runner's own
   * control — an engine-level timeout or an abort. `runStep` never returns in
   * that case, so its own error handling cannot run, and the failure with the
   * least explanation ends up with the least evidence.
   *
   * Best-effort: the engine ignores anything thrown here, and gives up on it
   * after a few seconds so a hung page cannot hold up the run.
   */
  captureFailure?(ctx: RunContext): Promise<Record<string, unknown> | undefined>;
  dispose?(ctx: RunContext): Promise<void> | void;
}

export interface GenerateContext {
  readonly config: TestOrchestratorConfig;
  readonly env: Record<string, string>;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly workspace: Workspace;
  readonly options?: Record<string, unknown>;
}

export interface Generator {
  readonly kind: 'generator';
  readonly name: string;
  readonly type: string;
  generate(ctx: GenerateContext): Promise<GeneratedSuite>;
}

export interface Reporter {
  readonly kind: 'reporter';
  readonly name: string;
  readonly type: string;
  init?(ctx: RunContext): Promise<void> | void;
  onEvent?(event: OrchestratorEvent): Promise<void> | void;
  dispose?(ctx: RunContext): Promise<void> | void;
}

export interface Plugin {
  readonly kind: 'plugin';
  readonly name: string;
  readonly type: string;
  install(registry: PluginRegistry, config?: Record<string, unknown>): Promise<void> | void;
}

export type RegistryItem = Runner | Generator | Reporter | Plugin;

/**
 * Plugin registry contract.
 *
 * The full implementation lives in `./registry/registries.js` via
 * `createOchestratorRegistries().plugins`. This interface is re-declared here
 * as a forward declaration to avoid a circular import between `types.ts` and
 * the registry module (the `Plugin` interface references `PluginRegistry`).
 */
export interface PluginRegistry {
  register(item: Plugin): this;
  unregister(name: string, type: string): boolean;
  get(name: string, type: string): Plugin | undefined;
  getByType(type: string): readonly Plugin[];
  has(name: string, type: string): boolean;
  hasPlugin(name: string): boolean;
  list(): readonly Plugin[];
  clear(): void;
  readonly size: number;
  [Symbol.iterator](): Iterator<Plugin>;
}

export interface GeneratedSuite {
  readonly files: GeneratedFile[];
}

export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
  readonly encoding?: BufferEncoding;
}

export interface StepResult {
  /** The step this result belongs to — a report is unreadable without it. */
  readonly stepId?: string;
  /** The action the step attempted, carried through for diagnosis. */
  readonly action?: string;
  readonly status: 'pass' | 'fail' | 'flaky';
  readonly durationMs: number;
  readonly output?: string;
  readonly error?: { message: string; code?: string; stack?: string };
  readonly artifacts?: string[];
  readonly retries?: number;
  /**
   * What the world looked like when the step failed — captured by the runner,
   * carried in the report, and read by triage. Free-form so each runner can
   * record what is meaningful for it.
   */
  readonly evidence?: Record<string, unknown>;
}

export interface TestResult {
  readonly testCaseId: string;
  readonly testCaseName: string;
  readonly status: 'pass' | 'fail' | 'flaky';
  readonly durationMs: number;
  readonly steps: StepResult[];
  readonly error?: { message: string; code?: string; stack?: string };
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export interface RunEndEvent {
  type: 'run:end';
  config: TestOrchestratorConfig;
  totalDurationMs: number;
  /**
   * Every result, in the order the tests were declared. Reporters that
   * accumulate `test:end` events see completion order instead, which stops
   * matching the declared order as soon as tests run concurrently.
   */
  results: readonly TestResult[];
}

export type OrchestratorEvent =
  | { type: 'run:start'; config: TestOrchestratorConfig }
  | RunEndEvent
  | { type: 'test:start'; testCase: TestCase }
  | { type: 'test:end'; result: TestResult }
  | { type: 'step:start'; testCase: TestCase; step: Step }
  | { type: 'step:end'; testCase: TestCase; step: Step; result: StepResult }
  | { type: 'error'; error: unknown };
