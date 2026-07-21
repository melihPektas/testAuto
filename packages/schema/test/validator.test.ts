import { describe, expect, it, beforeEach } from 'vitest';

import {
  validateConfig,
  validateTestCase,
  formatAjvErrors,
  resetAjvCache,
} from '../src/validator.js';

beforeEach(() => {
  resetAjvCache();
});

describe('validateConfig', () => {
  it('accepts a minimal valid config', () => {
    const result = validateConfig({
      version: '1.0',
      name: 'demo',
      runners: [{ name: 'default', type: 'node' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('demo');
    }
  });

  it('rejects a config missing required runners', () => {
    const result = validateConfig({ version: '1.0', name: 'demo' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects a config with the wrong version', () => {
    const result = validateConfig({
      version: '2.0',
      name: 'demo',
      runners: [{ name: 'default', type: 'node' }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown top-level properties', () => {
    const result = validateConfig({
      version: '1.0',
      name: 'demo',
      runners: [{ name: 'default', type: 'node' }],
      bogus: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe('validateTestCase', () => {
  it('accepts a minimal valid test case', () => {
    const result = validateTestCase({
      id: 'tc-1',
      version: '1.0',
      name: 'my case',
      steps: [{ action: 'click' }],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a test case with an empty steps array', () => {
    const result = validateTestCase({
      id: 'tc-1',
      version: '1.0',
      name: 'my case',
      steps: [],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a step without an action', () => {
    const result = validateTestCase({
      id: 'tc-1',
      version: '1.0',
      name: 'my case',
      steps: [{ target: '#btn' }],
    });
    expect(result.ok).toBe(false);
  });
});

describe('formatAjvErrors', () => {
  it('produces a readable string from validation errors', () => {
    const result = validateConfig({ name: 'demo' });
    if (!result.ok) {
      const formatted = formatAjvErrors(result.errors);
      expect(typeof formatted).toBe('string');
      expect(formatted.length).toBeGreaterThan(0);
    }
  });
});
