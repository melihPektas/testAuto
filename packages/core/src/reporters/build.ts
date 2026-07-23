import { createJsonReporter } from './json-reporter.js';
import { createJunitReporter } from './junit-reporter.js';

import type { Reporter } from '../types.js';

export interface ReporterConfigInput {
  readonly name: string;
  readonly type: string;
  readonly output?: string;
  readonly options?: Record<string, unknown>;
}

/**
 * Factory for a reporter type the core does not ship itself.
 *
 * @public
 */
export type ReporterFactory = (
  name: string,
  output: string | undefined,
  options: Record<string, unknown>,
) => Reporter | undefined;

/**
 * Build reporters from a config's `reporters` list. Built-in types:
 *
 * - `json`  → {@link createJsonReporter} (needs `output`)
 * - `junit` → {@link createJunitReporter} (needs `output`)
 *
 * Entries whose type is unknown, or which lack a required `output`, are skipped.
 *
 * @public
 */
export function buildReporters(
  reporters: readonly ReporterConfigInput[],
  extraFactories: Readonly<Record<string, ReporterFactory>> = {},
): Reporter[] {
  const built: Reporter[] = [];
  for (const reporter of reporters) {
    const factory = extraFactories[reporter.type];
    if (factory !== undefined) {
      const made = factory(reporter.name, reporter.output, reporter.options ?? {});
      if (made !== undefined) {
        built.push(made);
      }
      continue;
    }
    if (reporter.output === undefined) {
      continue;
    }
    if (reporter.type === 'json') {
      built.push(createJsonReporter(reporter.output));
    } else if (reporter.type === 'junit') {
      built.push(createJunitReporter(reporter.output));
    }
  }
  return built;
}
