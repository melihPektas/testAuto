import { describe, expect, it } from 'vitest';

import { buildGeneratorRegistry } from '../src/generators/build.js';
import { buildReporters } from '../src/reporters/build.js';
import { buildRunnerRegistry } from '../src/runners/build.js';

import type { Generator, Runner } from '../src/types.js';

describe('buildReporters', () => {
  it('builds json and junit reporters that declare an output', () => {
    const reporters = buildReporters([
      { name: 'j', type: 'json', output: '/tmp/a.json' },
      { name: 'x', type: 'junit', output: '/tmp/a.xml' },
    ]);
    expect(reporters.map((r) => r.type)).toEqual(['json', 'junit']);
  });

  it('skips entries without an output and unknown types', () => {
    const reporters = buildReporters([
      { name: 'j', type: 'json' },
      { name: 'weird', type: 'nope', output: '/tmp/x' },
    ]);
    expect(reporters).toHaveLength(0);
  });

  it('uses an extra factory for custom types', () => {
    const reporters = buildReporters([{ name: 'slack', type: 'slack' }], {
      slack: (name) => ({ kind: 'reporter', name, type: 'slack' }),
    });
    expect(reporters).toHaveLength(1);
    expect(reporters[0]?.type).toBe('slack');
  });
});

describe('buildGeneratorRegistry', () => {
  it('registers the built-in template generator', () => {
    const registry = buildGeneratorRegistry([{ name: 'tpl', type: 'template' }]);
    expect(registry.size).toBe(1);
  });

  it('uses an extra factory for custom types and skips unknown ones', () => {
    const custom: Generator = {
      kind: 'generator',
      name: 'url',
      type: 'url',
      generate: () => Promise.resolve({ files: [] }),
    };
    const registry = buildGeneratorRegistry(
      [
        { name: 'url', type: 'url' },
        { name: 'ghost', type: 'unknown-type' },
      ],
      { url: () => custom },
    );
    expect(registry.size).toBe(1);
  });
});

describe('buildRunnerRegistry extra factories', () => {
  it('lets a caller supply a runner type core does not ship (e.g. browser)', () => {
    const fake: Runner = {
      kind: 'runner',
      name: 'ui',
      type: 'browser',
      runStep: () => ({ status: 'pass', durationMs: 0 }),
    };
    const registry = buildRunnerRegistry([{ name: 'ui', type: 'browser' }], {
      browser: () => fake,
    });
    expect(registry.get('ui', 'browser')).toBe(fake);
  });
});
