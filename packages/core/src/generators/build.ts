import { createGeneratorRegistry } from '../registry/registries.js';

import { createTemplateGenerator } from './template-generator.js';

import type { GeneratorRegistry } from '../registry/registries.js';
import type { Generator } from '../types.js';

export interface GeneratorConfigInput {
  readonly name: string;
  readonly type: string;
  readonly output?: string;
  readonly options?: Record<string, unknown>;
}

/**
 * Factory for a generator type the core does not ship itself (e.g. the `url`
 * generator, which lives in `@test-orchestrator/browser`).
 *
 * @public
 */
export type GeneratorFactory = (name: string, options: Record<string, unknown>) => Generator;

/**
 * Build a generator registry from a config's `generators` list. Built-in types:
 *
 * - `template` → {@link createTemplateGenerator}
 *
 * Unknown types are skipped unless supplied via `extraFactories`.
 *
 * @public
 */
export function buildGeneratorRegistry(
  generators: readonly GeneratorConfigInput[],
  extraFactories: Readonly<Record<string, GeneratorFactory>> = {},
): GeneratorRegistry {
  const registry = createGeneratorRegistry();
  for (const generator of generators) {
    const factory = extraFactories[generator.type];
    if (factory !== undefined) {
      registry.register(factory(generator.name, generator.options ?? {}));
      continue;
    }
    if (generator.type === 'template') {
      registry.register(createTemplateGenerator());
    }
  }
  return registry;
}
