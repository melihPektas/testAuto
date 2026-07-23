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
  await writeFile(
    join(dir, 'src', 'api.spec.ts'),
    'describe("api", () => { it("creates", () => {}); it("lists", () => {}); });',
    'utf8',
  );
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

  it('parses each file and generates one test case per individual test', async () => {
    const result = await ingestProject(dir);
    // api.spec.ts declares two tests, math.test.ts one → three cases in total
    expect(result.totalTests).toBe(3);
    expect(result.testCases).toHaveLength(3);
    const names = result.files.flatMap((f) => f.tests).sort();
    expect(names).toEqual(['adds', 'creates', 'lists']);
  });

  it('runs each test by name with the framework filter flag', async () => {
    const result = await ingestProject(dir);
    const parsed = result.testCases.map(
      (tc) =>
        JSON.parse(tc.content) as { runner: string; name: string; steps: { action: string }[] },
    );
    const adds = parsed.find((p) => p.name.includes('adds'));
    expect(adds?.runner).toBe('shell');
    expect(adds?.steps[0]?.action).toBe('npx vitest run src/math.test.ts -t "adds"');
  });

  it('falls back to running the whole file when nothing is parsable', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'to-ingest-plain-'));
    await writeFile(
      join(plain, 'package.json'),
      JSON.stringify({ devDependencies: { vitest: '^1.6.0' } }),
      'utf8',
    );
    await writeFile(join(plain, 'empty.test.ts'), 'export const nothing = true;', 'utf8');
    const result = await ingestProject(plain);
    expect(result.totalTests).toBe(0);
    expect(result.testCases).toHaveLength(1);
    const parsed = JSON.parse(result.testCases[0]?.content ?? '{}') as {
      steps: { action: string }[];
    };
    expect(parsed.steps[0]?.action).toBe('npx vitest run empty.test.ts');
    await rm(plain, { recursive: true, force: true });
  });

  it('reports unknown framework when there is no package.json', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'to-ingest-empty-'));
    const result = await ingestProject(empty);
    expect(result.framework).toBe('unknown');
    expect(result.count).toBe(0);
    await rm(empty, { recursive: true, force: true });
  });
});
