import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  applyRepair,
  authorSite,
  changesetFromGithub,
  changesetFromGitlab,
  changesetFromNumstat,
  describeProvider,
  llmOptionsFor,
  failuresFromReport,
  matrixSite,
  planReview,
  buildReviewReport,
  reviewReportToMarkdown,
  proposeRepair,
  repairIsSafe,
  triageFailure,
  triageFailures,
  writeAuthored,
} from '@test-orchestrator/agent';
import {
  browserRunnerFactory,
  generateTestsFromObservation,
  observeApiCalls,
  urlGeneratorFactory,
} from '@test-orchestrator/browser';
import {
  executeRun,
  executeGenerators,
  buildRunnerRegistry,
  createGeneratorRegistry,
  createTemplateGenerator,
  createJsonReporter,
  createJunitReporter,
  createHtmlReporter,
  buildReporters,
  buildGeneratorRegistry,
  loadPlugins,
  createOchestratorRegistries,
  generateApiTests,
  loadSpec,
  testCasesToCsv,
} from '@test-orchestrator/core';
import { formatAjvErrors, validateTestCase } from '@test-orchestrator/schema';

import { resolveConfig } from '../internal/config-loader.js';
import { createLogger } from '../internal/logger.js';

import type { Changeset, SuiteResult } from '@test-orchestrator/agent';
import type { GenerateRunOptions, Reporter, RunOptions, Workspace } from '@test-orchestrator/core';
import type { LlmConfig, TestCase } from '@test-orchestrator/schema';
import type { Command } from 'commander';

const logger = createLogger();

/**
 * The `llm` block from the config, if there is a config. These commands are
 * useful against a bare directory too, so a missing config is not an error.
 */
async function llmConfig(configPath?: string): Promise<LlmConfig | undefined> {
  try {
    const { config } = await resolveConfig(configPath);
    return config.llm;
  } catch {
    return undefined;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Assemble a changeset from whichever input flag was given. */
async function readChangeset(opts: Record<string, unknown>): Promise<Changeset> {
  if (opts['diff'] === true) {
    return changesetFromNumstat(await readStdin());
  }
  if (typeof opts['gitlab'] === 'string') {
    return changesetFromGitlab(
      JSON.parse(await readFile(resolve(process.cwd(), opts['gitlab']), 'utf8')),
    );
  }
  if (typeof opts['github'] === 'string') {
    return changesetFromGithub(
      JSON.parse(await readFile(resolve(process.cwd(), opts['github']), 'utf8')),
    );
  }
  if (typeof opts['files'] === 'string') {
    const files = opts['files']
      .split(',')
      .map((f) => ({ path: f.trim() }))
      .filter((f) => f.path !== '');
    return { files, title: undefined, source: 'cli', targetUrl: undefined };
  }
  return { files: [], title: undefined, source: 'none', targetUrl: undefined };
}

/** Run one generated suite through the engine and return its summary. */
async function runSuite(
  testsDir: string,
  opts: Record<string, unknown>,
): Promise<{ passed: number; failed: number; flaky: number }> {
  const configPath = typeof opts['config'] === 'string' ? opts['config'] : undefined;
  const { config } = await resolveConfig(configPath);
  const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test-case.json')).sort();
  const testCases: unknown[] = [];
  for (const file of files) {
    testCases.push(JSON.parse(await readFile(join(testsDir, file), 'utf8')));
  }
  const runners = buildRunnerRegistry(config.runners, { browser: browserRunnerFactory });
  const summary = await executeRun({
    config,
    testCases: testCases as RunOptions['testCases'],
    runners,
    createRunners: () => buildRunnerRegistry(config.runners, { browser: browserRunnerFactory }),
  });
  return { passed: summary.passed, failed: summary.failed, flaky: summary.flaky };
}

/** Log which provider a role will use, without ever printing the key. */
function announce(
  role: Parameters<typeof describeProvider>[0],
  config: LlmConfig | undefined,
  overrides: Record<string, unknown>,
): void {
  const p = describeProvider(role, config, overrides);
  const key = p.hasKey ? ` · key from ${p.keyFrom ?? 'environment'}` : '';
  logger.info(`${role}: ${p.model} at ${p.baseUrl}${key}`);
}

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
    .option(
      '--cache <dir>',
      'cache authored cases by page signature; an unchanged page skips the model',
    )
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
        const overrides = {
          ...(model !== undefined ? { model } : {}),
          ...(llmUrl !== undefined ? { baseUrl: llmUrl } : {}),
        };
        const cfg = await llmConfig(undefined);
        announce('author', cfg, overrides);

        const cacheDir = typeof opts['cache'] === 'string' ? opts['cache'] : undefined;
        const site = await authorSite(url, {
          ...llmOptionsFor('author', cfg, overrides),
          ...(cacheDir !== undefined ? { cacheDir } : {}),
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
        const overrides = {
          ...(model !== undefined ? { model } : {}),
          ...(llmUrl !== undefined ? { baseUrl: llmUrl } : {}),
        };
        const cfg = await llmConfig(undefined);
        announce('matrix', cfg, overrides);
        const result = await matrixSite(url, {
          ...llmOptionsFor('matrix', cfg, overrides),
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
    .command('api')
    .description('Generate API test cases from an OpenAPI/Swagger spec (url or file)')
    .argument('<spec>', 'url or path of the OpenAPI document')
    .option('-d, --dir <dir>', 'output directory (cases land in <dir>/api/)', '.')
    .option('-r, --runner <name>', 'runner name the cases should target', 'api')
    .option('--auth-env <var>', 'environment variable holding a bearer token')
    .option('--include-writes', 'also generate POST/PUT/PATCH/DELETE cases (these change data)')
    .option('--happy-path-only', 'skip the negative cases')
    .action(async (spec: string, opts: Record<string, unknown>) => {
      try {
        const api = await loadSpec(spec);
        logger.info(`${api.title} ${api.version} — ${String(api.operations.length)} operation(s)`);
        if (api.serverUrl !== undefined) {
          logger.info(`server: ${api.serverUrl} (set this as the runner's baseUrl)`);
        }

        const authEnv = typeof opts['authEnv'] === 'string' ? opts['authEnv'] : undefined;
        const { cases, skipped } = generateApiTests(api, {
          runner: typeof opts['runner'] === 'string' ? opts['runner'] : 'api',
          includeWrites: opts['includeWrites'] === true,
          happyPathOnly: opts['happyPathOnly'] === true,
          ...(authEnv !== undefined ? { authEnv } : {}),
        });

        for (const skip of skipped) {
          logger.warn(`  skipped ${skip.operation}: ${skip.reason}`);
        }
        const dir = typeof opts['dir'] === 'string' ? opts['dir'] : '.';
        const written = await writeAuthored(dir, cases);
        for (const testCase of cases) {
          logger.info(`  ${testCase.path}  ${testCase.name}`);
        }
        logger.info(`wrote ${String(written.length)} test case(s) to ${dir}/api/`);
        if (written.length === 0) {
          process.exitCode = 1;
        }
      } catch (err) {
        logger.error(`failed to read the spec: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command('observe')
    .description('Watch the API calls a page makes, and generate tests from the healthy ones')
    .argument('<url>', 'the page to load')
    .option('-d, --dir <dir>', 'output directory (cases land in <dir>/observed/)', '.')
    .option('-s, --settle <ms>', 'how long to keep watching after load', '4000')
    .option('--all-origins', "include third-party endpoints, not just the page's own")
    .action(async (url: string, opts: Record<string, unknown>) => {
      try {
        const rawSettle = opts['settle'];
        const settle = Number.parseInt(typeof rawSettle === 'string' ? rawSettle : '', 10);
        const observation = await observeApiCalls(url, {
          settleMs: Number.isFinite(settle) && settle > 0 ? settle : 4000,
          ...(opts['allOrigins'] === true ? { origins: [] } : {}),
        });

        logger.info(
          `${String(observation.totalCalls)} request(s), ${String(observation.endpoints.length)} API endpoint(s)`,
        );
        for (const ep of observation.endpoints) {
          const line = `  ${ep.method} ${ep.endpoint} → ${ep.statuses.join('/') || 'no response'} (${String(ep.calls)}×, ${String(ep.slowestMs)}ms)`;
          if (ep.healthy) {
            logger.info(line);
          } else {
            logger.error(line);
          }
        }

        const { cases, skipped } = generateTestsFromObservation(observation);
        for (const skip of skipped) {
          logger.warn(`  not replayed — ${skip.endpoint}: ${skip.reason}`);
        }
        const dir = typeof opts['dir'] === 'string' ? opts['dir'] : '.';
        const written = await writeAuthored(dir, cases);
        logger.info(`wrote ${String(written.length)} test case(s) to ${dir}/observed/`);
      } catch (err) {
        logger.error(`failed to observe: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command('review')
    .description(
      'Review a change: decide if it is backend, UI or both, and test accordingly against a running environment',
    )
    .option('--diff', 'read changed files from `git diff --numstat` on stdin')
    .option('--gitlab <file>', 'a GitLab merge-request changes payload (JSON file)')
    .option('--github <file>', 'a GitHub pull-request files payload (JSON file)')
    .option('--files <list>', 'comma-separated changed file paths')
    .option('--url <url>', 'base URL of the running environment to test the UI against')
    .option('--spec <spec>', 'OpenAPI spec (url or file) to test the backend against')
    .option('-d, --dir <dir>', 'where generated tests land', '.review')
    .option('-c, --config <path>', 'config for the run step')
    .option('-m, --model <model>', 'model id for classifying ambiguous files')
    .option('-u, --llm-url <url>', 'OpenAI-compatible base URL')
    .option('--report <path>', 'write a Markdown + JSON review report (e.g. to post back to Jira)')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const changeset = await readChangeset(opts);
        if (changeset.files.length === 0) {
          logger.error('no changed files to review');
          process.exitCode = 1;
          return;
        }
        logger.info(
          `reviewing ${String(changeset.files.length)} changed file(s)${changeset.title !== undefined ? ` — ${changeset.title}` : ''}`,
        );

        const model = typeof opts['model'] === 'string' ? opts['model'] : undefined;
        const llmUrl = typeof opts['llmUrl'] === 'string' ? opts['llmUrl'] : undefined;
        const plan = await planReview(changeset.files, {
          ...(model !== undefined ? { model } : {}),
          ...(llmUrl !== undefined ? { baseUrl: llmUrl } : {}),
        });

        for (const file of plan.files) {
          logger.info(`  ${file.surface.padEnd(8)} ${file.path}  (${file.source}: ${file.reason})`);
        }
        logger.info(`this change is: ${plan.surface.toUpperCase()}`);

        const url = typeof opts['url'] === 'string' ? opts['url'] : changeset.targetUrl;
        const spec = typeof opts['spec'] === 'string' ? opts['spec'] : undefined;
        const dir = typeof opts['dir'] === 'string' ? opts['dir'] : '.review';
        const wantUi = plan.surface === 'ui' || plan.surface === 'both';
        const wantBackend = plan.surface === 'backend' || plan.surface === 'both';

        const suiteResults: SuiteResult[] = [];

        if (wantUi) {
          if (url === undefined) {
            logger.warn('UI is affected but no --url was given; skipping the UI tests');
            suiteResults.push({
              label: 'UI',
              passed: 0,
              failed: 0,
              flaky: 0,
              skipped: 'no --url given',
            });
          } else {
            logger.info(`authoring UI tests against ${url}`);
            const site = await authorSite(url, {
              ...(model !== undefined ? { model } : {}),
              ...(llmUrl !== undefined ? { baseUrl: llmUrl } : {}),
              maxPages: 2,
            });
            await writeAuthored(join(dir, 'ui'), site.cases);
            suiteResults.push({
              label: 'UI',
              ...(await runSuite(join(dir, 'ui', 'authored'), opts)),
            });
          }
        }

        if (wantBackend) {
          if (spec === undefined) {
            logger.warn('backend is affected but no --spec was given; skipping the API tests');
            suiteResults.push({
              label: 'backend',
              passed: 0,
              failed: 0,
              flaky: 0,
              skipped: 'no --spec given',
            });
          } else {
            logger.info(`generating API tests from ${spec}`);
            const api = await loadSpec(spec);
            const { cases } = generateApiTests(api);
            await writeAuthored(join(dir, 'backend'), cases);
            suiteResults.push({
              label: 'backend',
              ...(await runSuite(join(dir, 'backend', 'api'), opts)),
            });
          }
        }

        for (const suite of suiteResults) {
          if (suite.skipped !== undefined) {
            continue;
          }
          const status = suite.failed > 0 ? 'FAIL' : 'PASS';
          logger.info(
            `[${status}] ${suite.label}: ${String(suite.passed)} passed, ${String(suite.failed)} failed, ${String(suite.flaky)} flaky`,
          );
        }

        const report = buildReviewReport(plan, suiteResults, changeset.title);
        const reportPath = typeof opts['report'] === 'string' ? opts['report'] : undefined;
        if (reportPath !== undefined) {
          const md = reviewReportToMarkdown(report);
          await writeFile(resolve(process.cwd(), reportPath), md, 'utf8');
          const jsonPath = reportPath.replace(/\.mde?$|\.md$/i, '') + '.json';
          await writeFile(
            resolve(process.cwd(), jsonPath),
            `${JSON.stringify(report, null, 2)}\n`,
            'utf8',
          );
          logger.info(`wrote review report to ${reportPath} (and ${jsonPath})`);
        }

        if (suiteResults.every((s) => s.skipped !== undefined)) {
          logger.warn('nothing was testable for this change with the inputs given');
        }
        if (!report.ok) {
          process.exitCode = 1;
        }
      } catch (err) {
        logger.error(`failed to review: ${(err as Error).message}`);
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
        const overrides = {
          ...(model !== undefined ? { model } : {}),
          ...(llmUrl !== undefined ? { baseUrl: llmUrl } : {}),
        };
        const cfg = await llmConfig(undefined);
        announce('triage', cfg, overrides);
        const summary = await triageFailures(failures, {
          ...llmOptionsFor('triage', cfg, overrides),
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
    .command('repair')
    .description(
      'Propose selector fixes for tests triage blames on the test, verify them by re-running, and optionally write them back',
    )
    .option('-i, --input <path>', 'path to the JSON report', 'results.json')
    .option('-t, --tests <dir>', 'directory holding the test cases', '.')
    .option('-c, --config <path>', 'path to config file')
    .option('--apply', 'write verified repairs back to disk (default: propose only)')
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
        const testsDir = resolve(
          process.cwd(),
          typeof opts['tests'] === 'string' ? opts['tests'] : '.',
        );
        const report = JSON.parse(await readFile(input, 'utf8')) as Parameters<
          typeof failuresFromReport
        >[0];

        const byId = new Map<string, { file: string; testCase: TestCase }>();
        for (const file of (await readdir(testsDir))
          .filter((f) => f.endsWith('.test-case.json'))
          .sort()) {
          const parsed: unknown = JSON.parse(await readFile(join(testsDir, file), 'utf8'));
          const validated = validateTestCase(parsed);
          if (validated.ok) {
            byId.set(validated.data.id, { file, testCase: validated.data });
          }
        }

        const failures = failuresFromReport(
          report,
          [...byId.values()].map((e) => ({
            id: e.testCase.id,
            steps: e.testCase.steps,
          })),
        );
        if (failures.length === 0) {
          logger.info('nothing to repair');
          return;
        }

        const model = typeof opts['model'] === 'string' ? opts['model'] : undefined;
        const llmUrl = typeof opts['llmUrl'] === 'string' ? opts['llmUrl'] : undefined;
        const overrides = {
          ...(model !== undefined ? { model } : {}),
          ...(llmUrl !== undefined ? { baseUrl: llmUrl } : {}),
        };

        const { config } = await resolveConfig(
          typeof opts['config'] === 'string' ? opts['config'] : undefined,
        );
        // Repair leans on triage's verdict, so both roles are resolved here and
        // may legitimately use different models.
        const triageLlm = llmOptionsFor('triage', config.llm, overrides);
        const repairLlm = llmOptionsFor('repair', config.llm, overrides);
        announce('triage', config.llm, overrides);
        announce('repair', config.llm, overrides);
        const makeRunners = (): ReturnType<typeof buildRunnerRegistry> =>
          buildRunnerRegistry(config.runners, { browser: browserRunnerFactory });

        let verified = 0;
        for (const failure of failures) {
          const entry = byId.get(failure.testCaseId);
          if (entry === undefined) {
            continue;
          }
          const triage = await triageFailure(failure, triageLlm);
          const proposal = await proposeRepair(entry.testCase, failure, triage, repairLlm);
          if (proposal.repair === undefined) {
            logger.info(`  ${failure.testCaseId}: no repair — ${proposal.declined ?? 'declined'}`);
            continue;
          }

          const repaired = applyRepair(entry.testCase, proposal.repair);
          const unsafe = repairIsSafe(entry.testCase, repaired, proposal.repair);
          if (unsafe !== undefined) {
            logger.error(`  ${failure.testCaseId}: repair rejected — ${unsafe}`);
            continue;
          }
          const revalidated = validateTestCase(repaired);
          if (!revalidated.ok) {
            logger.error(
              `  ${failure.testCaseId}: repair rejected — ${formatAjvErrors(revalidated.errors)}`,
            );
            continue;
          }

          // A repair is a claim that the test now passes. Check the claim.
          const check = await executeRun({
            config,
            testCases: [repaired],
            runners: makeRunners(),
          });
          const passes = check.status === 'pass';
          const arrow = `${proposal.repair.from} → ${proposal.repair.to}`;
          if (!passes) {
            logger.warn(`  ${failure.testCaseId}: ${arrow} did NOT fix it — discarded`);
            continue;
          }

          verified += 1;
          logger.info(
            `  ${failure.testCaseId}: ${arrow} — verified (${proposal.repair.rationale})`,
          );
          if (opts['apply'] === true) {
            await writeFile(
              join(testsDir, entry.file),
              `${JSON.stringify(repaired, null, 2)}\n`,
              'utf8',
            );
            logger.info(`    written to ${entry.file}`);
          }
        }

        logger.info(
          opts['apply'] === true
            ? `applied ${String(verified)} verified repair(s)`
            : `${String(verified)} verified repair(s) available — re-run with --apply to write them`,
        );
      } catch (err) {
        logger.error(`failed to repair: ${(err as Error).message}`);
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
    .option('-r, --reporter <type>', 'also write a file report: json, junit or html')
    .option('-o, --out <path>', 'output path for the file reporter')
    .option('-j, --concurrency <n>', 'run this many test cases at once', '1')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const configPath = typeof opts['config'] === 'string' ? opts['config'] : undefined;
        const { path, config } = await resolveConfig(configPath);
        logger.info(`loaded "${config.name}" from ${path}`);

        const testsDir = resolve(
          process.cwd(),
          typeof opts['tests'] === 'string' ? opts['tests'] : '.',
        );
        // Sorted so a run is reproducible; readdir order is not guaranteed.
        const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test-case.json')).sort();
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

        const makeRunners = (): ReturnType<typeof buildRunnerRegistry> =>
          buildRunnerRegistry(config.runners, { browser: browserRunnerFactory });
        const runners = makeRunners();
        const rawConcurrency = opts['concurrency'];
        const concurrency = Math.max(
          1,
          Number.parseInt(typeof rawConcurrency === 'string' ? rawConcurrency : '', 10) || 1,
        );
        if (concurrency > 1) {
          logger.info(`running ${String(concurrency)} test case(s) at a time`);
        }

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
          } else if (reporterType === 'html') {
            reporters.push(createHtmlReporter(resolvedOut, resolve(process.cwd(), '.artifacts')));
          } else {
            logger.error(`unknown reporter "${reporterType}" (use json, junit or html)`);
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
          concurrency,
          createRunners: makeRunners,
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
