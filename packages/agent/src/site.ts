import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { exploreSite } from '@test-orchestrator/browser';

import { authorTestsForPage } from './author.js';
import { resolveLlm } from './llm.js';
import { generateMatrixCases, planMatrix } from './matrix.js';

import type { AuthorOptions } from './author.js';
import type { LlmOptions } from './llm.js';
import type { MatrixOptions, MatrixPlan } from './matrix.js';

export interface AuthoredCase {
  /** Path relative to the output directory. */
  readonly path: string;
  readonly content: string;
  readonly name: string;
  readonly steps: number;
}

export interface AuthoredSite {
  readonly model: string;
  readonly pagesVisited: number;
  readonly cases: AuthoredCase[];
  readonly rejected: { page: string; reason: string }[];
}

export interface AuthorSiteOptions extends AuthorOptions {
  /** How many same-origin pages to explore (default 3). */
  readonly maxPages?: number;
  /** Called after each page is authored, for progress reporting. */
  readonly onPage?: (url: string, accepted: number, rejected: number) => void;
}

/**
 * Explore a site and have the model author test cases for every page found.
 * Returns the cases as file content rather than writing them, so the caller
 * decides where — and whether — they land on disk.
 *
 * @public
 */
export async function authorSite(
  url: string,
  options: AuthorSiteOptions = {},
): Promise<AuthoredSite> {
  const map = await exploreSite(url, { maxPages: options.maxPages ?? 3 });
  const cases: AuthoredCase[] = [];
  const rejected: { page: string; reason: string }[] = [];

  for (const page of map.pages) {
    const result = await authorTestsForPage(page, options);
    for (const reject of result.rejected) {
      rejected.push({ page: page.url, reason: reject.reason });
    }
    for (const testCase of result.accepted) {
      cases.push({
        path: `authored/${String(cases.length + 1).padStart(2, '0')}-${testCase.id}.test-case.json`,
        content: `${JSON.stringify(testCase, null, 2)}\n`,
        name: testCase.name,
        steps: testCase.steps.length,
      });
    }
    options.onPage?.(page.url, result.accepted.length, result.rejected.length);
  }

  return { model: resolveLlm(options).model, pagesVisited: map.pages.length, cases, rejected };
}

export interface MatrixSiteResult {
  readonly model: string;
  readonly plan: MatrixPlan | undefined;
  readonly cases: AuthoredCase[];
  readonly rejected: string[];
}

export interface MatrixSiteOptions extends LlmOptions, MatrixOptions {
  /** How many links to show the planner (default 80). */
  readonly maxLinks?: number;
}

/**
 * Explore a listing page, have the model identify its axes, then expand the
 * cross-product locally. One model call produces hundreds of distinct cases —
 * asking a model for hundreds of cases directly just produces repetition.
 *
 * @public
 */
export async function matrixSite(
  url: string,
  options: MatrixSiteOptions = {},
): Promise<MatrixSiteResult> {
  const map = await exploreSite(url, { maxPages: 1, maxLinks: options.maxLinks ?? 80 });
  const page = map.pages[0];
  const model = resolveLlm(options).model;
  if (page === undefined) {
    return { model, plan: undefined, cases: [], rejected: [`could not load ${url}`] };
  }

  const planned = await planMatrix(page, options);
  if (planned.plan === undefined) {
    return { model, plan: undefined, cases: [], rejected: planned.rejected };
  }

  const testCases = generateMatrixCases(planned.plan, page.url, options);
  const cases = testCases.map((testCase, i) => ({
    path: `matrix/${String(i + 1).padStart(3, '0')}-${testCase.id}.test-case.json`,
    content: `${JSON.stringify(testCase, null, 2)}\n`,
    name: testCase.name,
    steps: testCase.steps.length,
  }));

  return { model, plan: planned.plan, cases, rejected: planned.rejected };
}

/**
 * Write authored cases under `baseDir`, returning the relative paths written.
 *
 * @public
 */
export async function writeAuthored(baseDir: string, cases: AuthoredCase[]): Promise<string[]> {
  const base = resolve(process.cwd(), baseDir);
  const written: string[] = [];
  for (const testCase of cases) {
    const target = join(base, testCase.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, testCase.content, 'utf8');
    written.push(testCase.path);
  }
  return written;
}
