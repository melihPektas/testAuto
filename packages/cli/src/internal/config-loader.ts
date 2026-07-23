import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { formatAjvErrors, validateConfig } from '@test-orchestrator/schema';

import { OrchestratorError } from './errors.js';

import type { TestOrchestratorConfig } from '@test-orchestrator/schema';

export function resolveConfigPath(explicitPath: string | undefined, cwd?: string): string {
  if (explicitPath !== undefined) {
    return isAbsolute(explicitPath) ? explicitPath : resolve(cwd ?? process.cwd(), explicitPath);
  }
  return resolve(cwd ?? process.cwd(), 'test-orchestrator.config.json');
}

export async function loadConfig(path: string): Promise<TestOrchestratorConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    throw new OrchestratorError(`Failed to read config at ${path}: ${(cause as Error).message}`, {
      code: 'ORCH_CONFIG_NOT_FOUND',
      cause,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OrchestratorError(`Failed to parse config: ${(err as Error).message}`, {
      code: 'ORCH_CONFIG_LOAD',
    });
  }
  // Single source of truth: the JSON Schema + AJV validators in @test-orchestrator/schema.
  const result = validateConfig(parsed);
  if (!result.ok) {
    throw new OrchestratorError(`Invalid config: ${formatAjvErrors(result.errors)}`, {
      code: 'ORCH_CONFIG_INVALID',
    });
  }
  return result.data;
}

export async function resolveConfig(
  explicitPath?: string,
  cwd?: string,
): Promise<{ path: string; config: TestOrchestratorConfig }> {
  const path = resolveConfigPath(explicitPath, cwd);
  const config = await loadConfig(path);
  return { path, config };
}
