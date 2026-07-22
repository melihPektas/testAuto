import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateTests, listTests, runTests } from '../src/tools.js';

let dir: string;
let prevCwd: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'to-mcp-'));
  prevCwd = process.cwd();
  process.chdir(dir);
  await writeFile(
    'test-orchestrator.config.json',
    JSON.stringify({ version: '1.0', name: 'mcp-suite', runners: [{ name: 'default', type: 'shell' }] }),
    'utf8',
  );
  await writeFile(
    'ok.test-case.json',
    JSON.stringify({ id: 'ok', version: '1.0', name: 'ok', runner: 'default', steps: [{ action: 'exit 0' }] }),
    'utf8',
  );
});

afterAll(async () => {
  process.chdir(prevCwd);
  await rm(dir, { recursive: true, force: true });
});

describe('mcp tools', () => {
  it('list_tests finds test-case files', async () => {
    expect(await listTests('.')).toContain('ok.test-case.json');
  });

  it('run_tests executes the suite and returns a summary', async () => {
    const summary = await runTests('test-orchestrator.config.json', '.');
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.status).toBe('pass');
  });

  it('generate_tests writes template files', async () => {
    const result = await generateTests(['alpha', 'beta'], 'gen');
    expect(result.count).toBe(2);
    const files = await listTests('gen');
    expect(files).toEqual(['alpha.test-case.json', 'beta.test-case.json']);
  });
});
