import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';

import { OrchestratorError } from './errors.js';

export type {
  DefaultsConfig,
  GeneratorConfig,
  HooksConfig,
  LogLevel,
  PluginConfig,
  ReporterConfig,
  RunnerConfig,
  TestOrchestratorConfig,
} from './config-types.js';
export { configSchema, default as defaultConfigSchema } from './config-schema.js';
export { validateConfigData, validateConfig } from './config-validator.js';
export { loadConfig, resolveConfigPath, resolveConfig } from './config-loader.js';
