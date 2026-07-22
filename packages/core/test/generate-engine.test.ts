import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executeGenerators } from '../src/engine/generate-engine.js';
import { createTemplateGenerator } from '../src/generators/template-generator.js';
import { createGeneratorRegistry } from '../src/registry/registries.js';

import type { TestOrchestratorConfig, Workspace } from '../src/types.js';

const config: TestOrchestratorConfig = {
  version: '1.0',
  name: 'gen-suite',
  runners: [{ name: 'shell', type: 'shell' }],
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'to-genengine-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function workspaceIn(root: string): Workspace {
  return {
    root,
    artifacts: join(root, '.artifacts'),
    temp: join(root, '.tmp'),
    resolve: (p: string) => join(root, p),
  };
}

describe('executeGenerators', () => {
  it('runs registered generators and writes their files to disk', async () => {
    const generators = createGeneratorRegistry();
    generators.register(createTemplateGenerator());

    const summary = await executeGenerators({
      config,
      generators,
      workspace: workspaceIn(dir),
      options: { names: ['login', 'logout'] },
    });

    expect(summary.count).toBe(2);
    expect(summary.files).toHaveLength(2);

    const content = await readFile(join(dir, 'login.test-case.json'), 'utf8');
    const parsed = JSON.parse(content) as { id: string; steps: { action: string }[] };
    expect(parsed.id).toBe('login');
    expect(parsed.steps[0]?.action).toBe('echo "login"');
  });

  it('returns an empty summary when no generators are registered', async () => {
    const summary = await executeGenerators({
      config,
      generators: createGeneratorRegistry(),
      workspace: workspaceIn(dir),
    });
    expect(summary.count).toBe(0);
    expect(summary.files).toEqual([]);
  });
});
