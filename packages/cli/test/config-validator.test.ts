import { describe, expect, it } from 'vitest';

import {
  validateConfigData,
  assertValidConfig,
} from '../src/internal/config-validator.js';
import { OrchestratorError } from '../src/internal/errors.js';

const validConfig = {
  version: '1.0',
  name: 'demo',
  runners: [{ name: 'default', type: 'node' }],
};

describe('validateConfigData', () => {
  it('accepts a minimal valid config', () => {
    expect(validateConfigData(validConfig)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a non-object', () => {
    const result = validateConfigData(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty runners array', () => {
    const result = validateConfigData({ ...validConfig, runners: [] });
    expect(result.valid).toBe(false);
  });

  it('rejects a wrong version', () => {
    const result = validateConfigData({ ...validConfig, version: '2.0' });
    expect(result.valid).toBe(false);
  });

  it('rejects an invalid logLevel', () => {
    const result = validateConfigData({ ...validConfig, logLevel: 'loud' });
    expect(result.valid).toBe(false);
  });
});

describe('assertValidConfig', () => {
  it('does not throw for a valid config', () => {
    expect(() => assertValidConfig(validConfig)).not.toThrow();
  });

  it('throws OrchestratorError for an invalid config', () => {
    expect(() => assertValidConfig({ name: 'x' })).toThrowError(OrchestratorError);
  });
});
