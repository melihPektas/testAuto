import { createRunnerRegistry } from '../registry/registries.js';

import { createHttpRunner } from './http-runner.js';
import { createN8nRunner } from './n8n-runner.js';
import { createShellRunner } from './shell-runner.js';

import type { RunnerRegistry } from '../registry/registries.js';
import type { Runner } from '../types.js';

export interface RunnerConfigInput {
  readonly name: string;
  readonly type: string;
  readonly options?: Record<string, unknown>;
}

/**
 * Factory for a runner type the core does not ship itself (e.g. the Playwright
 * `browser` runner, which lives in `@test-orchestrator/browser` so that core
 * stays free of heavy dependencies).
 *
 * @public
 */
export type RunnerFactory = (name: string, options: Record<string, unknown>) => Runner;

/**
 * Build a runner registry from a config's `runners` list, mapping each entry to
 * a built-in runner by its `type`:
 *
 * - `n8n`  → {@link createN8nRunner} (requires `options.baseUrl`; skipped if absent)
 * - `http` → {@link createHttpRunner} (optional `options.baseUrl`)
 * - anything else → {@link createShellRunner}
 *
 * @public
 */
export function buildRunnerRegistry(
  runners: readonly RunnerConfigInput[],
  extraFactories: Readonly<Record<string, RunnerFactory>> = {},
): RunnerRegistry {
  const registry = createRunnerRegistry();
  for (const runner of runners) {
    const factory = extraFactories[runner.type];
    if (factory !== undefined) {
      registry.register(factory(runner.name, runner.options ?? {}));
      continue;
    }
    const baseUrl = runner.options?.['baseUrl'];
    if (runner.type === 'n8n') {
      if (typeof baseUrl === 'string') {
        registry.register(createN8nRunner(runner.name, { baseUrl }));
      }
    } else if (runner.type === 'http') {
      registry.register(
        createHttpRunner(runner.name, typeof baseUrl === 'string' ? { baseUrl } : {}),
      );
    } else {
      registry.register(createShellRunner(runner.name));
    }
  }
  return registry;
}
