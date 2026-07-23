import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { registerCommands } from '../src/commands/index.js';

describe('CLI Commands Registration', () => {
  it('should register the correct commands', () => {
    const program = new Command();
    registerCommands(program);

    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).toContain('init');
    expect(commandNames).toContain('generate');
    expect(commandNames).toContain('run');
    expect(commandNames).toContain('report');
    expect(commandNames).toContain('plugin');
  });

  it('registers exactly the commands we document', () => {
    const program = new Command();
    registerCommands(program);
    // Asserting the set rather than a count, so adding a command fails here
    // with the name that changed instead of an unhelpful number.
    expect(program.commands.map((c) => c.name()).sort()).toEqual([
      'api',
      'author',
      'export',
      'generate',
      'init',
      'matrix',
      'plugin',
      'repair',
      'report',
      'run',
      'triage',
    ]);
  });
});
