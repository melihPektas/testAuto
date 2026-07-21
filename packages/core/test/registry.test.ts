import { describe, expect, it } from 'vitest';

import { Registry } from '../src/registry/registry.js';
import { RegistryError } from '../src/errors/errors.js';
import { createRunnerRegistry } from '../src/registry/registries.js';

interface Item {
  readonly name: string;
  readonly type: string;
}

describe('Registry', () => {
  it('registers and retrieves items by name+type', () => {
    const reg = new Registry<Item>();
    const item: Item = { name: 'a', type: 'runner' };
    reg.register(item);
    expect(reg.size).toBe(1);
    expect(reg.has('a', 'runner')).toBe(true);
    expect(reg.get('a', 'runner')).toBe(item);
    expect(reg.get('a', 'other')).toBeUndefined();
  });

  it('throws RegistryError on duplicate registration', () => {
    const reg = new Registry<Item>();
    reg.register({ name: 'a', type: 'runner' });
    expect(() => reg.register({ name: 'a', type: 'runner' })).toThrowError(RegistryError);
  });

  it('allows duplicates when configured', () => {
    const reg = new Registry<Item>({ allowDuplicates: true });
    reg.register({ name: 'a', type: 'runner' });
    expect(() => reg.register({ name: 'a', type: 'runner' })).not.toThrow();
  });

  it('filters by type with getByType', () => {
    const reg = new Registry<Item>();
    reg.register({ name: 'a', type: 'runner' });
    reg.register({ name: 'b', type: 'runner' });
    reg.register({ name: 'c', type: 'reporter' });
    expect(reg.getByType('runner')).toHaveLength(2);
    expect(reg.getByType('reporter')).toHaveLength(1);
  });

  it('unregisters and clears', () => {
    const reg = new Registry<Item>();
    reg.register({ name: 'a', type: 'runner' });
    expect(reg.unregister('a', 'runner')).toBe(true);
    expect(reg.unregister('a', 'runner')).toBe(false);
    reg.register({ name: 'b', type: 'runner' });
    reg.clear();
    expect(reg.size).toBe(0);
  });

  it('is iterable', () => {
    const reg = new Registry<Item>();
    reg.register({ name: 'a', type: 'runner' });
    reg.register({ name: 'b', type: 'reporter' });
    const names = [...reg].map((i) => i.name).sort();
    expect(names).toEqual(['a', 'b']);
  });
});

describe('createRunnerRegistry', () => {
  it('starts empty and stores registered runners', () => {
    const reg = createRunnerRegistry();
    expect(reg.size).toBe(0);
    const runner = { name: 'r1', type: 'node' } as unknown as Parameters<typeof reg.register>[0];
    reg.register(runner);
    expect(reg.has('r1', 'node')).toBe(true);
    expect(reg.get('r1', 'node')).toBe(runner);
  });
});
