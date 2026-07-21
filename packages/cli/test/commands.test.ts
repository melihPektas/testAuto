import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerCommands } from "../src/commands/index.js";

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

  it('should have exactly 5 registered commands', () => {
    const program = new Command();
    registerCommands(program);
    expect(program.commands.length).toBe(5);
  });
});