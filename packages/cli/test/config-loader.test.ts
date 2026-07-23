import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveConfigPath, loadConfig, resolveConfig } from '../src/internal/config-loader.js';
import { OrchestratorError } from '../src/internal/errors.js';

const validConfig = {
  version: '1.0',
  name: 'demo',
  runners: [{ name: 'default', type: 'node' }],
};

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'to-loader-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveConfigPath', () => {
  it('returns an absolute path for the default filename', () => {
    const p = resolveConfigPath(undefined, dir);
    expect(isAbsolute(p)).toBe(true);
    expect(p.endsWith('test-orchestrator.config.json')).toBe(true);
  });

  it('resolves a relative explicit path against cwd', () => {
    expect(resolveConfigPath('custom.json', dir)).toBe(resolve(dir, 'custom.json'));
  });

  it('keeps an absolute explicit path', () => {
    const abs = resolve(dir, 'abs.json');
    expect(resolveConfigPath(abs, dir)).toBe(abs);
  });
});

describe('loadConfig', () => {
  it('loads and returns a valid config', async () => {
    const file = join(dir, 'valid.json');
    await writeFile(file, JSON.stringify(validConfig), 'utf8');
    const config = await loadConfig(file);
    expect(config.name).toBe('demo');
  });

  it('throws for a missing file', async () => {
    await expect(loadConfig(join(dir, 'nope.json'))).rejects.toBeInstanceOf(OrchestratorError);
  });

  it('throws for invalid JSON', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(file, '{ not json', 'utf8');
    await expect(loadConfig(file)).rejects.toBeInstanceOf(OrchestratorError);
  });

  it('throws for a structurally invalid config', async () => {
    const file = join(dir, 'invalid.json');
    await writeFile(file, JSON.stringify({ name: 'x' }), 'utf8');
    await expect(loadConfig(file)).rejects.toBeInstanceOf(OrchestratorError);
  });
});

describe('resolveConfig', () => {
  it('returns the resolved path and parsed config', async () => {
    const file = join(dir, 'resolve.json');
    await writeFile(file, JSON.stringify(validConfig), 'utf8');
    const { path, config } = await resolveConfig(file);
    expect(path).toBe(file);
    expect(config.name).toBe('demo');
  });
});
