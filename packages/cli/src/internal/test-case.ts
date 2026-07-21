import { OrchestratorError } from './errors.js';

export interface TestStep {
  id: string;
  action: string;
  target?: string;
  value?: unknown;
  description?: string;
  options?: Record<string, unknown>;
}

export interface ExpectedResult {
  status?: 'pass' | 'fail' | 'flaky';
  error?: string;
}

export interface TestCase {
  id: string;
  version: '1.0';
  name: string;
  description?: string;
  tags?: string[];
  steps: TestStep[];
  expected?: ExpectedResult;
  timeout?: number;
  retry?: number;
}

export interface TestStepResult {
  id: string;
  status: 'pass' | 'fail' | 'skipped';
  durationMs?: number;
  error?: string;
}

export interface TestResult {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'flaky' | 'skipped';
  durationMs?: number;
  steps?: TestStepResult[];
  error?: string;
  tags?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: readonly string[];
}

export function validateTestCase(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (input === null || typeof input !== 'object') {
    return { valid: false, errors: ['test case must be an object'] };
  }
  const record = input as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    errors.push('id must be a non-empty string');
  }
  if (record.version !== '1.0') {
    errors.push('version must equal "1.0"');
  }
  if (typeof record.name !== 'string' || record.name.length === 0) {
    errors.push('name must be a non-empty string');
  }
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    errors.push('steps must be a non-empty array');
  } else {
    const steps = record.steps as unknown[];
    steps.forEach((step, idx) => {
      if (step === null || typeof step !== 'object') {
        errors.push(`steps[${idx}] must be an object`);
        return;
      }
      const s = step as Record<string, unknown>;
      if (typeof s.id !== 'string' || s.id.length === 0) {
        errors.push(`steps[${idx}].id must be a non-empty string`);
      }
      if (typeof s.action !== 'string' || s.action.length === 0) {
        errors.push(`steps[${idx}].action must be a non-empty string`);
      }
    });
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

export function assertValidTestCase(input: unknown): asserts input is TestCase {
  const result = validateTestCase(input);
  if (!result.valid) {
    throw new OrchestratorError(`Invalid test case: ${result.errors.join('; ')}`, {
      code: 'ORCH_TEST_CASE_INVALID',
    });
  }
}
