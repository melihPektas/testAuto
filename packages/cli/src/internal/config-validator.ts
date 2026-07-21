import type { TestOrchestratorConfig } from './config-types.js';
import { OrchestratorError } from './errors.js';

export interface ConfigValidationResult {
  valid: boolean;
  errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isArrayOf<T>(value: unknown, predicate: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every((item) => predicate(item));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') {
      return false;
    }
  }
  return true;
}

function isRunner(input: unknown): boolean {
  if (!isRecord(input)) {
    return false;
  }
  return typeof input.name === 'string' && input.name.length > 0
    && typeof input.type === 'string' && input.type.length > 0;
}

function isReporter(input: unknown): boolean {
  if (!isRecord(input)) {
    return false;
  }
  return typeof input.name === 'string' && input.name.length > 0
    && typeof input.type === 'string' && input.type.length > 0;
}

function isGenerator(input: unknown): boolean {
  if (!isRecord(input)) {
    return false;
  }
  return typeof input.name === 'string' && input.name.length > 0
    && typeof input.type === 'string' && input.type.length > 0
    && typeof input.output === 'string' && input.output.length > 0;
}

function isPlugin(input: unknown): boolean {
  if (!isRecord(input)) {
    return false;
  }
  return typeof input.name === 'string' && input.name.length > 0
    && typeof input.path === 'string' && input.path.length > 0;
}

function isHooksConfig(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  for (const k of ['beforeAll', 'afterAll', 'beforeEach', 'afterEach']) {
    if (value[k] !== undefined && typeof value[k] !== 'string') {
      return false;
    }
  }
  return true;
}

function isDefaultsConfig(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.runner !== undefined && typeof value.runner !== 'string') {
    return false;
  }
  if (value.reporter !== undefined && typeof value.reporter !== 'string') {
    return false;
  }
  if (value.generator !== undefined && typeof value.generator !== 'string') {
    return false;
  }
  if (value.tags !== undefined && !isArrayOf(value.tags, (x): x is string => typeof x === 'string')) {
    return false;
  }
  if (value.retry !== undefined && (typeof value.retry !== 'number' || !Number.isInteger(value.retry) || value.retry < 0)) {
    return false;
  }
  return true;
}

function isLogLevel(value: unknown): boolean {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'silent';
}

export function validateConfigData(input: unknown): ConfigValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { valid: false, errors: ['config must be an object'] };
  }
  if (input.version !== '1.0') {
    errors.push('version must equal "1.0"');
  }
  if (typeof input.name !== 'string' || input.name.length === 0) {
    errors.push('name must be a non-empty string');
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    errors.push('description must be a string');
  }
  if (input.tags !== undefined && !isArrayOf(input.tags, (x): x is string => typeof x === 'string')) {
    errors.push('tags must be an array of strings');
  }
  if (!Array.isArray(input.runners) || input.runners.length === 0) {
    errors.push('runners must be a non-empty array');
  } else if (!isArrayOf(input.runners, isRunner)) {
    errors.push('each runner must have a non-empty name and type');
  }
  if (input.generators !== undefined
    && (!Array.isArray(input.generators) || !isArrayOf(input.generators, isGenerator))) {
    errors.push('each generator must have non-empty name, type and output');
  }
  if (input.reporters !== undefined
    && (!Array.isArray(input.reporters) || !isArrayOf(input.reporters, isReporter))) {
    errors.push('each reporter must have a non-empty name and type');
  }
  if (input.plugins !== undefined
    && (!Array.isArray(input.plugins) || !isArrayOf(input.plugins, isPlugin))) {
    errors.push('each plugin must have a non-empty name and path');
  }
  if (!isHooksConfig(input.hooks)) {
    errors.push('hooks must be an object with string lifecycle hooks');
  }
  if (input.env !== undefined && !isStringRecord(input.env)) {
    errors.push('env must be an object of strings');
  }
  if (!isDefaultsConfig(input.defaults)) {
    errors.push('defaults has invalid shape');
  }
  if (input.logLevel !== undefined && !isLogLevel(input.logLevel)) {
    errors.push('logLevel must be one of debug, info, warn, error, silent');
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

export function assertValidConfig(input: unknown): asserts input is TestOrchestratorConfig {
  const result = validateConfigData(input);
  if (!result.valid) {
    throw new OrchestratorError(`Invalid config: ${result.errors.join('; ')}`, {
      code: 'ORCH_CONFIG_INVALID',
    });
  }
}

export function validateConfig(input: unknown): ConfigValidationResult {
  return validateConfigData(input);
}
