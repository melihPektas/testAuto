import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

import { configSchema } from './config/schema.js';
import { testCaseSchema } from './test-case/schema.js';
import type { TestOrchestratorConfig } from './config/types.js';
import type { TestCase } from './test-case/types.js';

export type SchemaValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: ErrorObject<string, Record<string, any>, unknown>[] };

let ajvInstance: Ajv | undefined;

function getAjv(): Ajv {
  if (ajvInstance === undefined) {
    ajvInstance = new Ajv({
      allErrors: true,
      strict: true,
      strictSchema: true,
      unevaluatedProperties: false,
      useDefaults: true,
      coerceTypes: false,
    });
    addFormats(ajvInstance);
    ajvInstance.addSchema(configSchema as Record<string, unknown>, 'config');
    ajvInstance.addSchema(testCaseSchema as Record<string, unknown>, 'test-case');
  }
  return ajvInstance;
}

export function validateConfig(data: unknown): SchemaValidationResult<TestOrchestratorConfig> {
  const ajv = getAjv();
  const validate = ajv.getSchema('config');
  if (!validate) {
    throw new Error('Config schema not registered in AJV');
  }
  const ok = validate(data);
  if (ok) {
    return { ok: true, data: data as TestOrchestratorConfig };
  }
  return { ok: false, errors: validate.errors ?? [] };
}

export function validateTestCase(data: unknown): SchemaValidationResult<TestCase> {
  const ajv = getAjv();
  const validate = ajv.getSchema('test-case');
  if (!validate) {
    throw new Error('Test-case schema not registered in AJV');
  }
  const ok = validate(data);
  if (ok) {
    return { ok: true, data: data as TestCase };
  }
  return { ok: false, errors: validate.errors ?? [] };
}

export function formatAjvErrors(errors: ErrorObject[]): string {
  return errors
    .map((e) => `${e.instancePath || '<root>'}: ${e.message ?? 'validation error'}`)
    .join('\n');
}

export function resetAjvCache(): void {
  ajvInstance = undefined;
}
