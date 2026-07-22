import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ingestProject } from '../src/ingest/ingest.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'to-ingest-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'sample', devDependencies: { vitest: '^1.6.0' } }),
    'utf8',
  );
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'foo'), { recursive: true });
  await writeFile(join(dir, 'src', 'math.test.ts'), 'test("adds", () => {});', 'utf8');
  await writeFile(join(dir, 'src', 'api.spec.ts'), 'test("api", () => {});', 'utf8');
  await writeFile(join(dir, 'src', 'helper.ts'), 'export const x = 1;', 'utf8');
  // should be ignored (inside node_modules)
  await writeFile(join(dir, 'node_modules', 'foo', 'dep.test.js'), 'test("x", () => {});', 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ingestProject', () => {
  it('detects the framework from package.json', async () => {
    const result = await ingestProject(dir);
    expect(result.framework).toBe('vitest');
    expect(result.command).toBe('npx vitest run');
  });

  it('discovers test files and skips node_modules and non-test files', async () => {
    const result = await ingestProject(dir);
    expect(result.count).toBe(2);
    expect(result.testFiles.sort()).toEqual(['src/api.spec.ts', 'src/math.test.ts']);
  });

  it('generates one orchestrator test case per file, running it via shell', async () => {
    const result = await ingestProject(dir);
    expect(result.testCases).toHaveLength(2);
    const parsed = JSON.parse(result.testCases[0]?.content ?? '{}') as {
      runner: string;
      steps: { action: string }[];
    };
    expect(parsed.runner).toBe('shell');
    expect(parsed.steps[0]?.action).toContain('npx vitest run');
  });

  it('reports unknown framework when there is no package.json', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'to-ingest-empty-'));
    const result = await ingestProject(empty);
    expect(result.framework).toBe('unknown');
    expect(result.count).toBe(0);
    await rm(empty, { recursive: true, force: true });
  });
});
