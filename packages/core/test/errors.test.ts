import { describe, expect, it } from 'vitest';

import {
  OrchestratorError,
  ConfigError,
  RegistryError,
  isOrchestratorError,
  toOrchestratorError,
} from '../src/errors/errors.js';

describe('OrchestratorError', () => {
  it('stores code, message and name', () => {
    const err = new OrchestratorError('ORCH_RUNTIME_ERROR', 'boom');
    expect(err.code).toBe('ORCH_RUNTIME_ERROR');
    expect(err.message).toBe('boom');
    expect(err.name).toBe('OrchestratorError');
    expect(err).toBeInstanceOf(Error);
  });

  it('stores context and cause from options', () => {
    const cause = new Error('root');
    const err = new OrchestratorError('ORCH_CONFIG_INVALID', 'bad', {
      cause,
      context: { field: 'name' },
    });
    expect(err.context).toEqual({ field: 'name' });
    expect(err.cause).toBe(cause);
  });
});

describe('error subclasses', () => {
  it('are instances of OrchestratorError', () => {
    const err = new ConfigError('ORCH_CONFIG_INVALID', 'nope');
    expect(err).toBeInstanceOf(OrchestratorError);
    expect(isOrchestratorError(err)).toBe(true);
  });

  it('RegistryError carries its code', () => {
    const err = new RegistryError('ORCH_DUPLICATE_REGISTRY_ITEM', 'dup');
    expect(err.code).toBe('ORCH_DUPLICATE_REGISTRY_ITEM');
  });
});

describe('isOrchestratorError', () => {
  it('returns false for a plain Error', () => {
    expect(isOrchestratorError(new Error('x'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isOrchestratorError('nope')).toBe(false);
    expect(isOrchestratorError(undefined)).toBe(false);
  });
});

describe('toOrchestratorError', () => {
  it('wraps a plain Error as ORCH_RUNTIME_ERROR preserving the cause', () => {
    const original = new Error('kaboom');
    const wrapped = toOrchestratorError(original);
    expect(wrapped).toBeInstanceOf(OrchestratorError);
    expect(wrapped.code).toBe('ORCH_RUNTIME_ERROR');
    expect(wrapped.message).toBe('kaboom');
    expect(wrapped.cause).toBe(original);
  });

  it('returns the same instance when already an OrchestratorError', () => {
    const err = new OrchestratorError('ORCH_TIMEOUT', 'slow');
    expect(toOrchestratorError(err)).toBe(err);
  });

  it('wraps non-error values into a runtime error', () => {
    const wrapped = toOrchestratorError('just a string');
    expect(wrapped).toBeInstanceOf(OrchestratorError);
    expect(wrapped.code).toBe('ORCH_RUNTIME_ERROR');
  });
});
