export type {
  DefaultsConfig,
  GeneratorConfig,
  HooksConfig,
  LogLevel,
  PluginConfig,
  ReporterConfig,
  RunnerConfig,
  TestOrchestratorConfig,
} from '@test-orchestrator/schema';
export { configSchema, validateConfig, formatAjvErrors } from '@test-orchestrator/schema';
export { loadConfig, resolveConfigPath, resolveConfig } from './config-loader.js';
