import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  authorSite,
  failuresFromReport,
  triageFailures,
  writeAuthored,
} from '@test-orchestrator/agent';
import {
  browserRunnerFactory,
  createBrowserRunner,
  exploreSite,
  generateTestsFromExploration,
} from '@test-orchestrator/browser';
import {
  executeRun,
  executeGenerators,
  createRunnerRegistry,
  createGeneratorRegistry,
  buildRunnerRegistry,
  createTemplateGenerator,
  ingestProject,
} from '@test-orchestrator/core';

import type {
  GenerateRunOptions,
  RunOptions,
  RunSummary,
  Workspace,
} from '@test-orchestrator/core';

interface WebConfig {
  name: string;
  runners: { name: string; type: string; options?: Record<string, unknown> }[];
}

export async function listTests(dir: string): Promise<string[]> {
  const target = resolve(process.cwd(), dir);
  const entries = await readdir(target);
  return entries.filter((f) => f.endsWith('.test-case.json')).sort();
}

export async function runTests(configPath: string, testsDir: string): Promise<RunSummary> {
  const resolvedConfig = resolve(process.cwd(), configPath);
  const resolvedTests = resolve(process.cwd(), testsDir);
  const config = JSON.parse(await readFile(resolvedConfig, 'utf8')) as WebConfig;

  const files = (await readdir(resolvedTests)).filter((f) => f.endsWith('.test-case.json')).sort();
  const testCases: unknown[] = [];
  for (const file of files) {
    testCases.push(JSON.parse(await readFile(join(resolvedTests, file), 'utf8')));
  }

  const runners = buildRunnerRegistry(config.runners, { browser: browserRunnerFactory });

  return executeRun({
    config: config as unknown as RunOptions['config'],
    testCases: testCases as unknown as RunOptions['testCases'],
    runners,
  });
}

export async function testUrl(url: string): Promise<RunSummary> {
  const runners = createRunnerRegistry();
  runners.register(createBrowserRunner('browser'));

  const testCases = [
    {
      id: 'ui-smoke',
      version: '1.0',
      name: `UI smoke: ${url}`,
      runner: 'browser',
      steps: [
        { id: 'goto', action: 'goto', value: url },
        { id: 'status', action: 'expectStatus', value: 200 },
        { id: 'audit', action: 'audit' },
      ],
    },
  ];

  return executeRun({
    config: {
      version: '1.0',
      name: 'ui-test',
      runners: [{ name: 'browser', type: 'browser' }],
    } as unknown as RunOptions['config'],
    testCases: testCases as unknown as RunOptions['testCases'],
    runners,
  });
}

export async function ingestProjectTool(dir: string): Promise<{
  framework: string;
  command: string;
  count: number;
  testFiles: string[];
  written: string[];
}> {
  const result = await ingestProject(dir);
  const base = resolve(process.cwd(), dir);
  const written: string[] = [];
  for (const testCase of result.testCases) {
    const target = join(base, testCase.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, testCase.content, 'utf8');
    written.push(testCase.path);
  }
  return {
    framework: result.framework,
    command: result.command,
    count: result.count,
    testFiles: result.testFiles,
    written,
  };
}

export interface ExploreToolResult {
  readonly origin: string;
  readonly pagesVisited: number;
  readonly pages: { url: string; title: string; links: number; forms: number }[];
  readonly formsFound: number;
  readonly generated: number;
  readonly written: string[];
}

export async function exploreSiteTool(
  url: string,
  maxPages: number,
  dir: string,
): Promise<ExploreToolResult> {
  const map = await exploreSite(url, { maxPages });
  const cases = generateTestsFromExploration(map);
  const base = resolve(process.cwd(), dir);
  const written: string[] = [];
  for (const testCase of cases) {
    const target = join(base, testCase.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, testCase.content, 'utf8');
    written.push(testCase.path);
  }
  return {
    origin: map.origin,
    pagesVisited: map.pages.length,
    pages: map.pages.map((p) => ({
      url: p.url,
      title: p.title,
      links: p.links.length,
      forms: p.forms.length,
    })),
    formsFound: map.pages.reduce((sum, p) => sum + p.forms.length, 0),
    generated: cases.length,
    written,
  };
}

export interface AuthorToolResult {
  readonly model: string;
  readonly pagesVisited: number;
  readonly accepted: number;
  readonly rejected: { page: string; reason: string }[];
  readonly written: string[];
  readonly cases: { file: string; name: string; steps: number }[];
}

export async function authorTestsTool(
  url: string,
  maxPages: number,
  count: number,
  dir: string,
  model: string | undefined,
  baseUrl: string | undefined,
): Promise<AuthorToolResult> {
  const site = await authorSite(url, {
    ...(model !== undefined ? { model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    maxPages,
    count,
  });
  const written = await writeAuthored(dir, site.cases);

  return {
    model: site.model,
    pagesVisited: site.pagesVisited,
    accepted: site.cases.length,
    rejected: site.rejected,
    written,
    cases: site.cases.map((c) => ({ file: c.path, name: c.name, steps: c.steps })),
  };
}

export async function triageTool(
  configPath: string,
  testsDir: string,
): Promise<{ summary: Awaited<ReturnType<typeof triageFailures>>; failures: number }> {
  const report = await runTests(configPath, testsDir);
  const resolvedTests = resolve(process.cwd(), testsDir);
  const testCases: { id: string; steps: unknown[] }[] = [];
  for (const file of (await readdir(resolvedTests)).filter((f) => f.endsWith('.test-case.json'))) {
    const parsed = JSON.parse(await readFile(join(resolvedTests, file), 'utf8')) as {
      id?: unknown;
      steps?: unknown;
    };
    if (typeof parsed.id === 'string' && Array.isArray(parsed.steps)) {
      testCases.push({ id: parsed.id, steps: parsed.steps });
    }
  }

  const failures = failuresFromReport(
    report as unknown as Parameters<typeof failuresFromReport>[0],
    testCases,
  );
  return { summary: await triageFailures(failures), failures: failures.length };
}

export async function generateTests(
  names: string[],
  dir: string,
): Promise<{ files: string[]; count: number }> {
  const cwd = process.cwd();
  const workspace: Workspace = {
    root: cwd,
    artifacts: resolve(cwd, '.artifacts'),
    temp: resolve(cwd, '.tmp'),
    resolve: (p: string) => resolve(cwd, p),
  };
  const generators = createGeneratorRegistry();
  generators.register(createTemplateGenerator());

  const options: GenerateRunOptions = {
    config: { version: '1.0', name: 'mcp-generate', runners: [] },
    generators,
    workspace,
    options: { names: names.length > 0 ? names : ['sample'], outputDir: dir },
  };
  return executeGenerators(options);
}
