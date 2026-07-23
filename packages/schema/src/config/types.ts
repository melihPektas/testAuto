export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface DocumentBase {
  $schema?: string;
  $id?: string;
}

export interface RunnerConfig {
  name: string;
  type: string;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

export interface GeneratorConfig {
  name: string;
  type: string;
  output: string;
  options?: Record<string, unknown>;
}

export interface ReporterConfig {
  name: string;
  type: string;
  output?: string;
  options?: Record<string, unknown>;
}

export interface PluginConfig {
  name: string;
  path: string;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

export interface HooksConfig {
  beforeAll?: string;
  afterAll?: string;
  beforeEach?: string;
  afterEach?: string;
}

export interface DefaultsConfig {
  runner?: string;
  reporter?: string;
  generator?: string;
  tags?: string[];
  retry?: number;
}

/** The model-backed roles, each of which may use a different model. */
export type LlmRole = 'author' | 'matrix' | 'triage' | 'repair';

export interface LlmRoleConfig {
  baseUrl?: string;
  model?: string;
  /**
   * Name of the environment variable holding the API key — never the key
   * itself. This file gets committed; keys must not.
   */
  apiKeyEnv?: string;
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmConfig extends LlmRoleConfig {
  /** Per-role overrides, layered over the settings above. */
  roles?: Partial<Record<LlmRole, LlmRoleConfig>>;
}

export interface TestOrchestratorConfig extends DocumentBase {
  version: '1.0';
  name: string;
  description?: string;
  tags?: string[];
  runners: RunnerConfig[];
  generators?: GeneratorConfig[];
  reporters?: ReporterConfig[];
  plugins?: PluginConfig[];
  hooks?: HooksConfig;
  env?: Record<string, string>;
  defaults?: DefaultsConfig;
  llm?: LlmConfig;
  logLevel?: LogLevel;
}
