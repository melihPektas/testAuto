import { type ErrorObject } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { configSchema } from './config/schema.js';
import { testCaseSchema } from './test-case/schema.js';

import type { TestOrchestratorConfig } from './config/types.js';
import type { TestCase } from './test-case/types.js';

export type SchemaValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: ErrorObject<string, Record<string, unknown>, unknown>[] };

let ajvInstance: Ajv2020 | undefined;
let lenientAjv: Ajv2020 | undefined;

function getLenientAjv(): Ajv2020 {
  if (lenientAjv === undefined) {
    lenientAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    addFormats(lenientAjv);
  }
  return lenientAjv;
}

function getAjv(): Ajv2020 {
  if (ajvInstance === undefined) {
    ajvInstance = new Ajv2020({
      allErrors: true,
      strict: true,
      strictSchema: true,
      useDefaults: true,
      coerceTypes: false,
    });
    addFormats(ajvInstance);
    ajvInstance.addSchema(configSchema, 'config');
    ajvInstance.addSchema(testCaseSchema, 'test-case');
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

/**
 * Validate data against a schema supplied at runtime — an OpenAPI response
 * schema, say, rather than one of this package's own documents.
 *
 * A separate, lenient Ajv instance is used on purpose: our documents are
 * validated strictly because we wrote them, but a third party's spec routinely
 * carries vendor extensions and keywords Ajv does not know, and refusing to
 * check a response because its schema mentions `nullable` would help nobody.
 *
 * @public
 */
export function validateAgainst(schema: unknown, data: unknown): SchemaValidationResult<unknown> {
  let validate;
  try {
    validate = getLenientAjv().compile(schema as object);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          instancePath: '',
          schemaPath: '',
          keyword: 'schema',
          params: {},
          message: `unusable schema: ${(err as Error).message}`,
        },
      ],
    };
  }
  return validate(data) ? { ok: true, data } : { ok: false, errors: validate.errors ?? [] };
}

export function resetAjvCache(): void {
  ajvInstance = undefined;
  lenientAjv = undefined;
}
