import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export type TestFramework = 'vitest' | 'jest' | 'playwright' | 'mocha' | 'unknown';

export interface GeneratedTestCase {
  readonly path: string;
  readonly content: string;
}

export interface IngestResult {
  readonly dir: string;
  readonly framework: TestFramework;
  readonly command: string;
  readonly testFiles: string[];
  readonly count: number;
  readonly testCases: GeneratedTestCase[];
}

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.turbo',
  'coverage',
  '.next',
  'build',
  'out',
]);

async function findTestFiles(dir: string, base: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        found.push(...(await findTestFiles(full, base)));
      }
    } else if (TEST_FILE_RE.test(entry.name)) {
      found.push(relative(base, full));
    }
  }
  return found;
}

async function detectFramework(dir: string): Promise<{ framework: TestFramework; command: string }> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['@playwright/test'] !== undefined) {
      return { framework: 'playwright', command: 'npx playwright test' };
    }
    if (deps['vitest'] !== undefined) {
      return { framework: 'vitest', command: 'npx vitest run' };
    }
    if (deps['jest'] !== undefined) {
      return { framework: 'jest', command: 'npx jest' };
    }
    if (deps['mocha'] !== undefined) {
      return { framework: 'mocha', command: 'npx mocha' };
    }
  } catch {
    // no package.json / unreadable — fall through
  }
  return { framework: 'unknown', command: 'echo "unknown test framework"' };
}

function slugify(file: string): string {
  const slug = file.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return slug.length > 0 ? slug : 'test';
}

/**
 * Evaluate a project directory and ingest its existing tests: detect the test
 * framework, discover test files, and produce orchestrator test cases that each
 * run one existing test file through a shell runner. The orchestrator can then
 * run heterogeneous suites under one roof (reporters, retry, exit codes).
 *
 * Returns the analysis plus the generated (in-memory) test cases; the caller
 * decides whether to write them.
 *
 * @public
 */
export async function ingestProject(dir: string): Promise<IngestResult> {
  const resolved = resolve(process.cwd(), dir);
  const { framework, command } = await detectFramework(resolved);
  const testFiles = (await findTestFiles(resolved, resolved)).sort();

  const testCases: GeneratedTestCase[] = testFiles.map((file) => {
    const id = slugify(file);
    const testCase = {
      id,
      version: '1.0',
      name: `run ${file}`,
      runner: 'shell',
      steps: [{ id: 'run', action: `${command} ${file}` }],
    };
    return {
      path: `ingested/${id}.test-case.json`,
      content: `${JSON.stringify(testCase, null, 2)}\n`,
    };
  });

  return { dir: resolved, framework, command, testFiles, count: testFiles.length, testCases };
}
