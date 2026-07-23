import { describe, expect, it } from 'vitest';

import { describeProvider, llmOptionsFor } from '../src/provider.js';

import type { LlmConfig } from '@test-orchestrator/schema';

const openrouter: LlmConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'qwen/qwen-2.5-coder-32b-instruct',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  roles: {
    // judgement is cheap and frequent; authoring is worth the bigger model
    triage: { model: 'meta-llama/llama-3.1-8b-instruct' },
    repair: { model: 'meta-llama/llama-3.1-8b-instruct' },
  },
};

const env = { OPENROUTER_API_KEY: 'sk-or-secret' } as NodeJS.ProcessEnv;

describe('llmOptionsFor', () => {
  it('gives each role its own model, falling back to the shared one', () => {
    expect(llmOptionsFor('author', openrouter, {}, env).model).toBe(
      'qwen/qwen-2.5-coder-32b-instruct',
    );
    expect(llmOptionsFor('triage', openrouter, {}, env).model).toBe(
      'meta-llama/llama-3.1-8b-instruct',
    );
  });

  it('shares the base url across roles that do not override it', () => {
    for (const role of ['author', 'matrix', 'triage', 'repair'] as const) {
      expect(llmOptionsFor(role, openrouter, {}, env).baseUrl).toBe('https://openrouter.ai/api/v1');
    }
  });

  it('reads the key from the named variable, never from the config', () => {
    expect(llmOptionsFor('author', openrouter, {}, env).apiKey).toBe('sk-or-secret');
    // the config holds the variable's NAME; nothing in it is the key itself
    expect(JSON.stringify(openrouter)).not.toContain('sk-or-secret');
  });

  it('yields no key when the named variable is unset', () => {
    expect(llmOptionsFor('author', openrouter, {}, {} as NodeJS.ProcessEnv).apiKey).toBeUndefined();
  });

  it('pins judgement to temperature 0 and leaves generation warmer', () => {
    expect(llmOptionsFor('triage').temperature).toBe(0);
    expect(llmOptionsFor('repair').temperature).toBe(0);
    expect(llmOptionsFor('author').temperature).toBe(0.2);
    expect(llmOptionsFor('matrix').temperature).toBe(0.2);
  });

  it('lets a role override the temperature deliberately', () => {
    expect(llmOptionsFor('triage', { roles: { triage: { temperature: 0.7 } } }).temperature).toBe(
      0.7,
    );
  });

  it('lets an explicit flag beat the config', () => {
    const options = llmOptionsFor('author', openrouter, { model: 'from-the-command-line' }, env);
    expect(options.model).toBe('from-the-command-line');
  });

  it('works with no config at all', () => {
    expect(llmOptionsFor('author').model).toBeUndefined();
    expect(llmOptionsFor('author').baseUrl).toBeUndefined();
  });
});

describe('describeProvider', () => {
  it('reports what will be used without exposing the key', () => {
    const summary = describeProvider('triage', openrouter, {}, env);
    expect(summary.model).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(summary.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(summary.hasKey).toBe(true);
    expect(summary.keyFrom).toBe('OPENROUTER_API_KEY');
    expect(JSON.stringify(summary)).not.toContain('sk-or-secret');
  });

  it('falls back to the local defaults when nothing is configured', () => {
    const summary = describeProvider('author', undefined, {}, {} as NodeJS.ProcessEnv);
    expect(summary.baseUrl).toBe('http://localhost:11434/v1');
    expect(summary.model).toBe('qwen2.5-coder:14b');
    expect(summary.hasKey).toBe(false);
  });
});
