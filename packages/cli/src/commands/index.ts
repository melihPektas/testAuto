import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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
} from '@test-orchestrator/core';

import { browserRunnerFactory, urlGeneratorFactory } from '@test-orchestrator/browser';

import { resolveConfig } from '../internal/config-loader.js';
import { createLogger } from '../internal/logger.js';
import { assertValidTestCase } from '../internal/test-case.js';

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
          assertValidTestCase(parsed);
          testCases.push(parsed);
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
    .description('Produce a report (not yet implemented)')
    .action(() => {
      logger.info('report: not yet implemented');
    });

  const plugin = program.command('plugin').description('Manage plugins');
  plugin
    .command('list')
    .description('List registered plugins')
    .action(() => {
      logger.info('no plugins registered');
    });
}
