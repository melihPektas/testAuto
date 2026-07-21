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
  logLevel?: LogLevel;
}
