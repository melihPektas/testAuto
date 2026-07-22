import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  executeRun,
  executeGenerators,
  createRunnerRegistry,
  createGeneratorRegistry,
  createShellRunner,
  createN8nRunner,
  createTemplateGenerator,
} from '@test-orchestrator/core';
import type { GenerateRunOptions, RunOptions, RunSummary, Workspace } from '@test-orchestrator/core';
import { createBrowserRunner } from '@test-orchestrator/browser';

interface WebConfig {
  name: string;
  runners: { name: string; type: string; options?: Record<string, unknown> }[];
}

export async function listTests(dir: string): Promise<string[]> {
  const target = resolve(process.cwd(), dir);
  const entries = await readdir(target);
  return entries.filter((f) => f.endsWith('.test-case.json')).sort();
}

export async function runTests(
  configPath: string,
  testsDir: string,
): Promise<RunSummary> {
  const resolvedConfig = resolve(process.cwd(), configPath);
  const resolvedTests = resolve(process.cwd(), testsDir);
  const config = JSON.parse(await readFile(resolvedConfig, 'utf8')) as WebConfig;

  const files = (await readdir(resolvedTests)).filter((f) => f.endsWith('.test-case.json')).sort();
  const testCases: unknown[] = [];
  for (const file of files) {
    testCases.push(JSON.parse(await readFile(join(resolvedTests, file), 'utf8')));
  }

  const runners = createRunnerRegistry();
  for (const runner of config.runners) {
    if (runner.type === 'n8n') {
      const baseUrl = runner.options?.['baseUrl'];
      if (typeof baseUrl === 'string') {
        runners.register(createN8nRunner(runner.name, { baseUrl }));
      }
    } else {
      runners.register(createShellRunner(runner.name));
    }
  }

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
        { id: 'title', action: 'expectTitle' },
        { id: 'body', action: 'expectSelector', target: 'body' },
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
