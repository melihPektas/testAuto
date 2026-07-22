import { describe, expect, it } from 'vitest';

import { OrchestratorError } from '../src/internal/errors.js';
import {
  validateTestCase,
  assertValidTestCase,
} from '../src/internal/test-case.js';

const validCase = {
  id: 'tc-1',
  version: '1.0',
  name: 'my case',
  steps: [{ id: 'step-1', action: 'click' }],
};

describe('validateTestCase', () => {
  it('accepts a minimal valid test case', () => {
    expect(validateTestCase(validCase)).toEqual({ valid: true, errors: [] });
  });

  it('accepts a step without an id (id is optional per schema)', () => {
    const result = validateTestCase({
      ...validCase,
      steps: [{ action: 'click' }],
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects a non-object', () => {
    expect(validateTestCase(42).valid).toBe(false);
  });

  it('rejects an empty steps array', () => {
    expect(validateTestCase({ ...validCase, steps: [] }).valid).toBe(false);
  });

  it('reports a step missing an action', () => {
    const result = validateTestCase({
      ...validCase,
      steps: [{ id: 'step-1' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('action'))).toBe(true);
  });
});

describe('assertValidTestCase', () => {
  it('does not throw for a valid case', () => {
    expect(() => assertValidTestCase(validCase)).not.toThrow();
  });

  it('throws OrchestratorError for an invalid case', () => {
    expect(() => assertValidTestCase({ id: 'x' })).toThrowError(OrchestratorError);
  });
});
