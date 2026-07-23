import { writeFile } from 'node:fs/promises';

import type { OrchestratorEvent, Reporter, TestResult } from '../types.js';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The evidence a failing step carried, rendered for a human reading the report. */
function renderEvidence(result: TestResult): string {
  const failing = result.steps.find((s) => s.status === 'fail');
  const evidence = failing?.evidence;
  if (evidence === undefined) {
    return '';
  }
  const lines: string[] = [];
  const say = (label: string, key: string): void => {
    const value = evidence[key];
    if (value !== undefined) {
      lines.push(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  };
  say('url', 'url');
  say('selector matched', 'targetCount');
  say('related selectors', 'similarSelectors');
  say('failed API calls', 'failedApiCalls');
  say('visible text', 'excerpt');

  const shot = evidence['screenshot'];
  // `[[ATTACHMENT|path]]` is the convention Jenkins' JUnit Attachments plugin
  // (and others) read, so the screenshot shows up next to the failure.
  const attachment = typeof shot === 'string' ? `\n[[ATTACHMENT|${shot}]]` : '';
  if (lines.length === 0 && attachment === '') {
    return '';
  }
  return `\n      <system-out>${esc(lines.join('\n'))}${esc(attachment)}</system-out>`;
}

function renderTestCase(result: TestResult): string {
  const name = esc(result.testCaseName);
  const time = (result.durationMs / 1000).toFixed(3);
  if (result.status === 'fail') {
    const message = esc(result.error?.message ?? 'failed');
    return (
      `    <testcase name="${name}" time="${time}">` +
      `<failure message="${message}"></failure>${renderEvidence(result)}\n    </testcase>`
    );
  }
  return `    <testcase name="${name}" time="${time}"></testcase>`;
}

/**
 * Reporter that accumulates every test result and, when the run ends, writes a
 * JUnit-style XML report to `outputPath`.
 *
 * @public
 */
export function createJunitReporter(outputPath: string): Reporter {
  const results: TestResult[] = [];

  return {
    kind: 'reporter',
    name: 'junit',
    type: 'junit',
    onEvent: async (event: OrchestratorEvent): Promise<void> => {
      if (event.type === 'test:end') {
        results.push(event.result);
        return;
      }
      if (event.type === 'run:end') {
        // Prefer the declared order; accumulated events are in completion order.
        const ordered = (event.results ?? []).length > 0 ? [...event.results] : results;
        const failures = ordered.filter((r) => r.status === 'fail').length;
        const cases = ordered.map(renderTestCase).join('\n');
        const xml =
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<testsuites>\n' +
          `  <testsuite name="orchestrator" tests="${ordered.length}" failures="${failures}">\n` +
          `${cases}${cases ? '\n' : ''}` +
          '  </testsuite>\n' +
          '</testsuites>\n';
        await writeFile(outputPath, xml, 'utf8');
      }
    },
  };
}
