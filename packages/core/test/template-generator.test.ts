import { describe, expect, it } from 'vitest';

import { createTemplateGenerator } from '../src/generators/template-generator.js';

import type { GenerateContext } from '../src/types.js';

function ctxWith(options?: Record<string, unknown>): GenerateContext {
  return {
    config: { version: '1.0', name: 't', runners: [{ name: 'shell', type: 'shell' }] },
    env: {},
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child() {
        return this;
      },
    },
    signal: new AbortController().signal,
    workspace: { root: '.', artifacts: '.', temp: '.', resolve: (p) => p },
    options,
  };
}

describe('createTemplateGenerator', () => {
  it('has the generator shape', () => {
    const gen = createTemplateGenerator();
    expect(gen.kind).toBe('generator');
    expect(gen.type).toBe('template');
  });

  it('defaults to a single "sample" file', async () => {
    const suite = await createTemplateGenerator().generate(ctxWith());
    expect(suite.files).toHaveLength(1);
    expect(suite.files[0]?.path).toBe('./sample.test-case.json');
  });

  it('produces one schema-shaped file per requested name', async () => {
    const suite = await createTemplateGenerator().generate(
      ctxWith({ names: ['login', 'logout'], outputDir: 'cases' }),
    );
    expect(suite.files).toHaveLength(2);
    expect(suite.files.map((f) => f.path)).toEqual([
      'cases/login.test-case.json',
      'cases/logout.test-case.json',
    ]);
    const parsed = JSON.parse(suite.files[0]?.content ?? '{}') as {
      id: string;
      version: string;
      steps: { action: string }[];
    };
    expect(parsed.id).toBe('login');
    expect(parsed.version).toBe('1.0');
    expect(parsed.steps[0]?.action).toBe('echo "login"');
  });
});
