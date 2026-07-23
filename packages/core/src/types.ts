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

export type OrchestratorEvent =
  | { type: 'run:start'; config: TestOrchestratorConfig }
  | { type: 'run:end'; config: TestOrchestratorConfig; totalDurationMs: number }
  | { type: 'test:start'; testCase: TestCase }
  | { type: 'test:end'; result: TestResult }
  | { type: 'step:start'; testCase: TestCase; step: Step }
  | { type: 'step:end'; testCase: TestCase; step: Step; result: StepResult }
  | { type: 'error'; error: unknown };
