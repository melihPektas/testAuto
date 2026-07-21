import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  executeRun,
  createRunnerRegistry,
  createShellRunner,
  createN8nRunner,
  createJsonReporter,
  createJunitReporter,
} from '@test-orchestrator/core';
import type { Reporter, RunOptions } from '@test-orchestrator/core';
import type { Command } from 'commander';

import { resolveConfig } from '../internal/config-loader.js';
import { assertValidTestCase } from '../internal/test-case.js';
import { createLogger } from '../internal/logger.js';

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
    .description('Generate a test-case template JSON file')
    .requiredOption('-o, --output <path>', 'output file path')
    .option('-n, --name <name>', 'test case name', 'sample')
    .action(async (opts: Record<string, unknown>) => {
      const name = String(opts['name'] ?? 'sample');
      const output = resolve(process.cwd(), String(opts['output']));
      const template = {
        id: name,
        version: '1.0',
        name,
        description: `Generated test case: ${name}`,
        tags: ['generated'],
        runner: 'default',
        steps: [
          { id: 'step-1', action: `echo "running ${name}"`, description: 'first step' },
        ],
        timeout: 30000,
        retry: 0,
      };
      try {
        await writeFile(output, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
        logger.info(`generated ${output}`);
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
        const configPath = opts['config'] === undefined ? undefined : String(opts['config']);
        const { path, config } = await resolveConfig(configPath);
        logger.info(`loaded "${config.name}" from ${path}`);

        const testsDir = resolve(process.cwd(), String(opts['tests'] ?? '.'));
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

        const runners = createRunnerRegistry();
        for (const runner of config.runners) {
          if (runner.type === 'n8n') {
            const baseUrl = runner.options?.['baseUrl'];
            if (typeof baseUrl !== 'string') {
              logger.error(`runner "${runner.name}" (n8n) requires a string options.baseUrl`);
              process.exitCode = 1;
              return;
            }
            runners.register(createN8nRunner(runner.name, { baseUrl }));
          } else {
            runners.register(createShellRunner(runner.name));
          }
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
        const reporterType = opts['reporter'] === undefined ? undefined : String(opts['reporter']);
        if (reporterType !== undefined) {
          const outPath = opts['out'] === undefined ? undefined : String(opts['out']);
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
          config: config as unknown as RunOptions['config'],
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
