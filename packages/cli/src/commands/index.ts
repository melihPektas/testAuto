import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  authorSite,
  failuresFromReport,
  matrixSite,
  resolveLlm,
  triageFailures,
  writeAuthored,
} from '@test-orchestrator/agent';
import { browserRunnerFactory, urlGeneratorFactory } from '@test-orchestrator/browser';
import {
  executeRun,
  executeGenerators,
  buildRunnerRegistry,
  createGeneratorRegistry,
  createTemplateGenerator,
  createJsonReporter,
  createJunitReporter,
  buildReporters,
  buildGeneratorRegistry,
  loadPlugins,
  createOchestratorRegistries,
  testCasesToCsv,
} from '@test-orchestrator/core';
import { formatAjvErrors, validateTestCase } from '@test-orchestrator/schema';

import { resolveConfig } from '../internal/config-loader.js';
import { createLogger } from '../internal/logger.js';

import type { GenerateRunOptions, Reporter, RunOptions, Workspace } from '@test-orchestrator/core';
import type { Command } from 'commander';

const logger = createLogger();

export function registerCommands(program: Command): void {
  program
    .command('init')
    .description('Create a starter test-orchestrator.config.json in the current directory')
    .option('-f, --force', 'overwrite an existing config file')
    .action(async (opts: Record<string, unknown>) => {
      const target = resolve(process.cwd(), 'test-orchestrator.config.json');
      const starter = {
        version: '1.0',
        name: 'my-tests',
        runners: [{ name: 'default', type: 'node' }],
      };
      try {
        await writeFile(target, `${JSON.stringify(starter, null, 2)}\n`, {
          encoding: 'utf8',
          flag: opts['force'] === true ? 'w' : 'wx',
        });
        logger.info(`created ${target}`);
      } catch (err) {
        if ((err as { code?: string }).code === 'EEXIST') {
          logger.error('config already exists; pass --force to overwrite');
          return;
        }
        logger.error(`failed to write config: ${(err as Error).message}`);
      }
    });

  program
    .command('generate')
    .description('Generate test-case files through the generator engine')
    .argument('[names...]', 'test case names to generate', ['sample'])
    .option('-d, --dir <dir>', 'output directory', '.')
    .action(async (names: string[], opts: Record<string, unknown>) => {
      try {
        const cwd = process.cwd();
        const workspace: Workspace = {
          root: cwd,
          artifacts: resolve(cwd, '.artifacts'),
          temp: resolve(cwd, '.tmp'),
          resolve: (p: string) => resolve(cwd, p),
        };
        let generators = createGeneratorRegistry();
        generators.register(createTemplateGenerator());
        try {
          const { config } = await resolveConfig(undefined);
          const declared = config.generators ?? [];
          if (declared.length > 0) {
            generators = buildGeneratorRegistry(declared, { url: urlGeneratorFactory });
            logger.info(`using ${declared.length} generator(s) from config`);
          }
        } catch {
          // no config file — fall back to the built-in template generator
        }

        const options: GenerateRunOptions = {
          config: { version: '1.0', name: 'cli-generate', runners: [] },
          generators,
          workspace,
          logger,
          options: {
            names: names.length > 0 ? names : ['sample'],
            outputDir: typeof opts['dir'] === 'string' ? opts['dir'] : '.',
          },
        };
        const summary = await executeGenerators(options);
        logger.info(`generated ${summary.count} file(s)`);
      } catch (err) {
        logger.error(`failed to generate: ${(err as Error).message}`);
      }
    });

  program
    .command('author')
    .description('Explore a URL and have an LLM author validated test cases for it')
    .argument('<url>', 'the site to explore')
    .option('-d, --dir <dir>', 'output directory (cases land in <dir>/authored/)', '.')
    .option('-p, --pages <n>', 'how many same-origin pages to explore', '3')
    .option('-n, --count <n>', 'scenarios to request per page', '3')
    .option('-m, --model <model>', 'model id (default: $TEST_ORCHESTRATOR_LLM_MODEL)')
    .option(
      '-u, --llm-url <url>',
      'OpenAI-compatible base URL (default: $TEST_ORCHESTRATOR_LLM_URL)',
    )
    .action(async (url: string, opts: Record<string, unknown>) => {
      const int = (key: string, fallback: number): number => {
        const raw = opts[key];
        const parsed = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      };
      const model = typeof opts['model'] === 'string' ? opts['model'] : undefined;
      const llmUrl = typeof opts['llmUrl'] === 'string' ? opts['llmUrl'] : undefined;
      const dir = typeof opts['dir'] === 'string' ? opts['dir'] : '.';

      try {
        const llm = resolveLlm({
          ...(model !== undefined ? { model } : {}),
          ...(llmUrl !== undefined ? { baseUrl: llmUrl } : {}),
        });
        logger.info(`authoring with ${llm.model} at ${llm.baseUrl}`);

        const site = await authorSite(url, {
          ...(model !== undefined ? { model } : {}),
          ...(llmUrl !== undefined ? { baseUrl: llmUrl } : {}),
          maxPages: int('pages', 3),
          count: int('count', 3),
          onPage: (pageUrl, accepted, rejected) => {
            logger.info(
              `  ${pageUrl} → ${String(accepted)} accepted, ${String(rejected)} rejected`,
            );
          },
        });

        const written = await writeAuthored(dir, site.cases);
        for (const testCase of site.cases) {
          logger.info(`  ${testCase.path}  (${String(testCase.steps)} steps)  ${testCase.name}`);
        }
        for (const reject of site.rejected) {
          logger.warn(`  rejected on ${reject.page}: ${reject.reason}`);
        }
        logger.info(
          `explored ${String(site.pagesVisited)} page(s), wrote ${String(written.length)} test case(s), rejected ${String(site.rejected.length)}`,
        );
        if (written.length === 0) {
          process.exitCode = 1;
        }
      } catch (err) {
        logger.error(`failed to author: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command('matrix')
    .description(
      'Plan the axes of a listing page with an LLM, then expand the full combination matrix',
    )
    .argument('<url>', 'the listing/search page to plan from')
    .option('-d, --dir <dir>', 'output directory (cases land in <dir>/matrix/)', '.')
    .option('-l, --limit <n>', 'maximum number of cases to generate', '500')
    .option('-m, --model <model>', 'model id (default: $TEST_ORCHESTRATOR_LLM_MODEL)')
    .option(
      '-u, --llm-url <url>',
      'OpenAI-compatible base URL (default: $TEST_ORCHESTRATOR_LLM_URL)',
    )
    .action(async (url: string, opts: Record<string, unknown>) => {
      const model = typeof opts['model'] === 'string' ? opts['model'] : undefined;
      const llmUrl = typeof opts['llmUrl'] === 'string' ? opts['llmUrl'] : undefined;
      const dir = typeof opts['dir'] === 'string' ? opts['dir'] : '.';
      const rawLimit = opts['limit'];
      const parsedLimit = Number.parseInt(typeof rawLimit === 'string' ? rawLimit : '', 10);

      try {
        const result = await matrixSite(url, {
          ...(model !== undefined ? { model } : {}),
          ...(llmUrl !== undefined ? { baseUrl: llmUrl } : {}),
          limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 500,
        });

        for (const reject of result.rejected) {
          logger.warn(`  ${reject}`);
        }
        if (result.plan === undefined) {
          logger.error('no usable matrix plan for this page');
          process.exitCode = 1;
          return;
        }

        logger.info(`result selector: ${result.plan.resultSelector}`);
        if (result.plan.search !== undefined) {
          logger.info(
            `search axis: ${result.plan.search.input} × ${String(result.plan.search.terms.length)} term(s)`,
          );
        }
        for (const axis of result.plan.filters) {
          logger.info(`filter axis "${axis.axis}": ${String(axis.values.length)} value(s)`);
        }

        const written = await writeAuthored(dir, result.cases);
        logger.info(`wrote ${String(written.length)} test case(s) to ${dir}/matrix/`);
        if (written.length === 0) {
          process.exitCode = 1;
        }
      } catch (err) {
        logger.error(`failed to build matrix: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command('triage')
    .description(
      'Classify the failures in a JSON report: product bug, test bug, flaky, environment or test data',
    )
    .option('-i, --input <path>', 'path to the JSON report', 'results.json')
    .option('-t, --tests <dir>', 'directory holding the test cases the report came from')
    .option('-o, --out <path>', 'write the triage as JSON to this path')
    .option('-m, --model <model>', 'model id (default: $TEST_ORCHESTRATOR_LLM_MODEL)')
    .option(
      '-u, --llm-url <url>',
      'OpenAI-compatible base URL (default: $TEST_ORCHESTRATOR_LLM_URL)',
    )
    .action(async (opts: Record<string, unknown>) => {
      try {
        const input = resolve(
          process.cwd(),
          typeof opts['input'] === 'string' ? opts['input'] : 'results.json',
        );
        const report = JSON.parse(await readFile(input, 'utf8')) as Parameters<
          typeof failuresFromReport
        >[0];

        // The report records what happened, not what was asked for; loading the
        // test cases recovers the failing step's selector and value.
        const testCases: { id: string; steps: unknown[] }[] = [];
        if (typeof opts['tests'] === 'string') {
          const testsDir = resolve(process.cwd(), opts['tests']);
          for (const file of (await readdir(testsDir)).filter((f) =>
            f.endsWith('.test-case.json'),
          )) {
            const parsed = JSON.parse(await readFile(join(testsDir, file), 'utf8')) as {
              id?: unknown;
              steps?: unknown;
            };
            if (typeof parsed.id === 'string' && Array.isArray(parsed.steps)) {
              testCases.push({ id: parsed.id, steps: parsed.steps });
            }
          }
        }

        const failures = failuresFromReport(report, testCases);
        if (failures.length === 0) {
          logger.info('no failures to triage');
          return;
        }
        logger.info(`triaging ${String(failures.length)} failure(s)`);

        const model = typeof opts['model'] === 'string' ? opts['model'] : undefined;
        const llmUrl = typeof opts['llmUrl'] === 'string' ? opts['llmUrl'] : undefined;
        const summary = await triageFailures(failures, {
          ...(model !== undefined ? { model } : {}),
          ...(llmUrl !== undefined ? { baseUrl: llmUrl } : {}),
          onTriage: (triage) => {
            const line = `  [${triage.verdict}] ${triage.testCaseId} (${triage.confidence}, by ${triage.source}) — ${triage.reason}`;
            if (triage.verdict === 'product-bug') {
              logger.error(line);
            } else if (triage.confidence === 'low') {
              logger.warn(line);
            } else {
              logger.info(line);
            }
          },
        });

        for (const [verdict, count] of Object.entries(summary.byVerdict).sort(
          (a, b) => b[1] - a[1],
        )) {
          logger.info(`${verdict}: ${String(count)}`);
        }
        logger.info(
          `${String(summary.byRule)} decided by rule, ${String(summary.byModel)} by the model`,
        );

        if (typeof opts['out'] === 'string') {
          const out = resolve(process.cwd(), opts['out']);
          await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
          logger.info(`wrote ${out}`);
        }
      } catch (err) {
        logger.error(`failed to triage: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command('export')
    .description('Export discovered test cases as CSV')
    .option('-t, --tests <dir>', 'directory holding *.test-case.json files', '.')
    .option('-o, --out <path>', 'output CSV path', 'test-cases.csv')
    .option('--per-step', 'one row per step instead of one row per test case')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const testsDir = resolve(
          process.cwd(),
          typeof opts['tests'] === 'string' ? opts['tests'] : '.',
        );
        const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test-case.json')).sort();
        if (files.length === 0) {
          logger.warn(`no *.test-case.json files found in ${testsDir}`);
          process.exitCode = 1;
          return;
        }

        const testCases = [];
        for (const file of files) {
          const parsed: unknown = JSON.parse(await readFile(join(testsDir, file), 'utf8'));
          const validated = validateTestCase(parsed);
          if (!validated.ok) {
            logger.warn(`skipping ${file}: ${formatAjvErrors(validated.errors)}`);
            continue;
          }
          testCases.push(validated.data);
        }

        const out = resolve(
          process.cwd(),
          typeof opts['out'] === 'string' ? opts['out'] : 'test-cases.csv',
        );
        await writeFile(
          out,
          testCasesToCsv(testCases, { perStep: opts['perStep'] === true }),
          'utf8',
        );
        logger.info(`exported ${String(testCases.length)} test case(s) to ${out}`);
      } catch (err) {
        logger.error(`failed to export: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command('run')
    .description('Load a config, discover test cases and execute them')
    .option('-c, --config <path>', 'path to config file')
    .option('-t, --tests <dir>', 'directory holding *.test-case.json files', '.')
    .option('-r, --reporter <type>', 'also write a file report: json or junit')
    .option('-o, --out <path>', 'output path for the file reporter')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const configPath = typeof opts['config'] === 'string' ? opts['config'] : undefined;
        const { path, config } = await resolveConfig(configPath);
        logger.info(`loaded "${config.name}" from ${path}`);

        const testsDir = resolve(
          process.cwd(),
          typeof opts['tests'] === 'string' ? opts['tests'] : '.',
        );
        const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test-case.json'));
        if (files.length === 0) {
          logger.warn(`no *.test-case.json files found in ${testsDir}`);
          return;
        }

        const testCases: unknown[] = [];
        for (const file of files) {
          const parsed: unknown = JSON.parse(await readFile(join(testsDir, file), 'utf8'));
          const validated = validateTestCase(parsed);
          if (!validated.ok) {
            throw new Error(`Invalid test case ${file}: ${formatAjvErrors(validated.errors)}`);
          }
          testCases.push(validated.data);
        }
        logger.info(`discovered ${testCases.length} test case(s) in ${testsDir}`);

        const runners = buildRunnerRegistry(config.runners, { browser: browserRunnerFactory });

        const consoleReporter: Reporter = {
          kind: 'reporter',
          name: 'cli',
          type: 'cli',
          onEvent: (event) => {
            if (event.type === 'test:end') {
              const r = event.result;
              const mark = r.status === 'pass' ? 'PASS' : r.status === 'flaky' ? 'FLAKY' : 'FAIL';
              logger.info(`  [${mark}] ${r.testCaseName} (${r.durationMs}ms)`);
            }
          },
        };

        const reporters: Reporter[] = [consoleReporter];
        // Reporters declared in the config file (json/junit with an output path).
        const configReporters = buildReporters(config.reporters ?? []);
        if (configReporters.length > 0) {
          logger.info(`using ${configReporters.length} reporter(s) from config`);
          reporters.push(...configReporters);
        }
        const reporterType = typeof opts['reporter'] === 'string' ? opts['reporter'] : undefined;
        if (reporterType !== undefined) {
          const outPath = typeof opts['out'] === 'string' ? opts['out'] : undefined;
          if (outPath === undefined) {
            logger.error('--out <path> is required when --reporter is set');
            process.exitCode = 1;
            return;
          }
          const resolvedOut = resolve(process.cwd(), outPath);
          if (reporterType === 'json') {
            reporters.push(createJsonReporter(resolvedOut));
          } else if (reporterType === 'junit') {
            reporters.push(createJunitReporter(resolvedOut));
          } else {
            logger.error(`unknown reporter "${reporterType}" (use json or junit)`);
            process.exitCode = 1;
            return;
          }
        }

        const summary = await executeRun({
          config: config,
          testCases: testCases as unknown as RunOptions['testCases'],
          runners,
          reporters,
          logger,
        });

        logger.info(
          `done: ${summary.passed} passed, ${summary.failed} failed, ${summary.flaky} flaky (${summary.durationMs}ms)`,
        );
        if (summary.status === 'fail') {
          process.exitCode = 1;
        }
      } catch (err) {
        logger.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  program
    .command('report')
    .description('Summarise a JSON report produced by the json reporter')
    .option('-i, --input <path>', 'path to the JSON report', 'results.json')
    .action(async (opts: Record<string, unknown>) => {
      const input = resolve(
        process.cwd(),
        typeof opts['input'] === 'string' ? opts['input'] : 'results.json',
      );
      try {
        const doc = JSON.parse(await readFile(input, 'utf8')) as {
          total?: number;
          passed?: number;
          failed?: number;
          flaky?: number;
          durationMs?: number;
          results?: {
            testCaseName: string;
            status: string;
            durationMs: number;
            error?: { message?: string };
          }[];
        };
        const results = doc.results ?? [];
        logger.info(`report: ${input}`);
        logger.info(
          `  ${String(doc.passed ?? 0)} passed, ${String(doc.failed ?? 0)} failed, ` +
            `${String(doc.flaky ?? 0)} flaky of ${String(doc.total ?? results.length)} ` +
            `(${String(doc.durationMs ?? 0)}ms)`,
        );
        for (const result of results) {
          const mark =
            result.status === 'pass' ? 'PASS' : result.status === 'flaky' ? 'FLAKY' : 'FAIL';
          logger.info(`  [${mark}] ${result.testCaseName} (${String(result.durationMs)}ms)`);
          if (result.error?.message !== undefined) {
            logger.error(`         ${result.error.message}`);
          }
        }
        if ((doc.failed ?? 0) > 0) {
          process.exitCode = 1;
        }
      } catch (err) {
        logger.error(`failed to read report: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  const plugin = program.command('plugin').description('Manage plugins');
  plugin
    .command('list')
    .description('List the plugins declared in the config and whether they load')
    .action(async () => {
      try {
        const { config } = await resolveConfig(undefined);
        const declared = config.plugins ?? [];
        if (declared.length === 0) {
          logger.info('no plugins declared in the config');
          return;
        }
        const registry = createOchestratorRegistries().plugins;
        const loaded = await loadPlugins(declared, registry);
        for (const entry of loaded) {
          if (entry.loaded) {
            logger.info(`  [OK]   ${entry.name} (${entry.path})`);
          } else {
            logger.warn(`  [SKIP] ${entry.name} (${entry.path}) — ${entry.error ?? 'unknown'}`);
          }
        }
        logger.info(`${loaded.filter((l) => l.loaded).length}/${loaded.length} plugin(s) loaded`);
      } catch (err) {
        logger.error(`failed to list plugins: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
