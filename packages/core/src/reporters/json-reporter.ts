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
        const document = {
          total: results.length,
          passed: results.filter((r) => r.status === 'pass').length,
          failed: results.filter((r) => r.status === 'fail').length,
          flaky: results.filter((r) => r.status === 'flaky').length,
          durationMs: event.totalDurationMs,
          results,
        };
        await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      }
    },
  };
}
