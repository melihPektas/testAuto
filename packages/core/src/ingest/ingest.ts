import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { parseTestFile } from './parse.js';

export type TestFramework = 'vitest' | 'jest' | 'playwright' | 'mocha' | 'unknown';

export interface GeneratedTestCase {
  readonly path: string;
  readonly content: string;
}

export interface IngestedFile {
  readonly file: string;
  /** Suite names found in the file (`describe(...)`). */
  readonly suites: string[];
  /** Individual test names found in the file (`it(...)` / `test(...)`). */
  readonly tests: string[];
}

export interface IngestResult {
  readonly dir: string;
  readonly framework: TestFramework;
  readonly command: string;
  readonly testFiles: string[];
  /** Per-file parse results: which suites and tests each file declares. */
  readonly files: IngestedFile[];
  /** Number of discovered test files. */
  readonly count: number;
  /** Number of individual tests parsed across all files. */
  readonly totalTests: number;
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

/** Flag each framework uses to run a single test by name. */
const FILTER_FLAG: Readonly<Record<TestFramework, string | undefined>> = {
  vitest: '-t',
  jest: '-t',
  playwright: '-g',
  mocha: '--grep',
  unknown: undefined,
};

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

async function detectFramework(
  dir: string,
): Promise<{ framework: TestFramework; command: string }> {
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

function slugify(value: string): string {
  const slug = value
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug.length > 0 ? slug : 'test';
}

/** Quote a test name for a shell command, escaping embedded double quotes. */
function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Evaluate a project directory and ingest its existing tests: detect the test
 * framework, discover test files, **parse each file for its individual test
 * names**, and produce one orchestrator test case per test — each invoking the
 * framework with its "run a single test by name" filter so results stay
 * granular. Files whose tests cannot be parsed fall back to a single test case
 * that runs the whole file.
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
  const filterFlag = FILTER_FLAG[framework];

  const files: IngestedFile[] = [];
  const testCases: GeneratedTestCase[] = [];

  for (const file of testFiles) {
    let parsed = { suites: [] as string[], tests: [] as string[] };
    try {
      parsed = parseTestFile(await readFile(join(resolved, file), 'utf8'));
    } catch {
      // unreadable file — treat as unparsed
    }
    files.push({ file, suites: parsed.suites, tests: parsed.tests });

    if (parsed.tests.length > 0 && filterFlag !== undefined) {
      for (const test of parsed.tests) {
        const id = `${slugify(file)}--${slugify(test)}`;
        const testCase = {
          id,
          version: '1.0',
          name: `${file} › ${test}`,
          runner: 'shell',
          steps: [{ id: 'run', action: `${command} ${file} ${filterFlag} ${shellQuote(test)}` }],
        };
        testCases.push({
          path: `ingested/${id}.test-case.json`,
          content: `${JSON.stringify(testCase, null, 2)}\n`,
        });
      }
      continue;
    }

    // Fallback: no parsable tests (or no filter flag) — run the whole file.
    const id = slugify(file);
    const testCase = {
      id,
      version: '1.0',
      name: `run ${file}`,
      runner: 'shell',
      steps: [{ id: 'run', action: `${command} ${file}` }],
    };
    testCases.push({
      path: `ingested/${id}.test-case.json`,
      content: `${JSON.stringify(testCase, null, 2)}\n`,
    });
  }

  return {
    dir: resolved,
    framework,
    command,
    testFiles,
    files,
    count: testFiles.length,
    totalTests: files.reduce((sum, f) => sum + f.tests.length, 0),
    testCases,
  };
}
