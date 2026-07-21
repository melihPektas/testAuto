import { Command } from 'commander';

import { registerCommands } from './commands/index.js';

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name('test-orchestrator')
    .description('Test orchestration CLI')
    .version('0.0.1');
  registerCommands(program);
  await program.parseAsync(argv);
}
