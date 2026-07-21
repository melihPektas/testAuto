import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import { resolveConfig } from '../internal/config-loader.js';
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
        steps: [{ id: 'step-1', action: 'noop' }],
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
    .description('Load a config and report its runners')
    .option('-c, --config <path>', 'path to config file')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const configPath = opts['config'] === undefined ? undefined : String(opts['config']);
        const { path, config } = await resolveConfig(configPath);
        logger.info(`loaded "${config.name}" from ${path} with ${config.runners.length} runner(s)`);
      } catch (err) {
        logger.error((err as Error).message);
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
