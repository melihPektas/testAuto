import { writeFile } from 'node:fs/promises';

import type { OrchestratorEvent, Reporter, TestResult } from '../types.js';

/**
 * Reporter that accumulates every test result and, when the run ends, writes a
 * JSON summary document to `outputPath`.
 *
 * @public
 */
export function createJsonReporter(outputPath: string): Reporter {
  const results: TestResult[] = [];

  return {
    kind: 'reporter',
    name: 'json',
    type: 'json',
    onEvent: async (event: OrchestratorEvent): Promise<void> => {
      if (event.type === 'test:end') {
        results.push(event.result);
        return;
      }
      if (event.type === 'run:end') {
        // The run reports the declared order; the accumulated events only match
        // it when nothing ran concurrently.
        // Guarded: reporters also receive events from plugins and tests, which
        // may construct a run:end without them.
        const ordered = (event.results ?? []).length > 0 ? [...event.results] : results;
        const document = {
          total: ordered.length,
          passed: ordered.filter((r) => r.status === 'pass').length,
          failed: ordered.filter((r) => r.status === 'fail').length,
          flaky: ordered.filter((r) => r.status === 'flaky').length,
          durationMs: event.totalDurationMs,
          results: ordered,
        };
        await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      }
    },
  };
}
