import type { TestCase } from '@test-orchestrator/schema';

export interface CsvOptions {
  /**
   * Emit one row per step instead of one row per test case. Step-level is what
   * you want when importing into a test-management tool; case-level is what you
   * want when reviewing coverage.
   */
  readonly perStep?: boolean;
  readonly delimiter?: string;
}

/** Quote a field for CSV, doubling any embedded quotes. */
function cell(value: unknown): string {
  const text =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function stepFields(step: unknown): { action: string; target: string; value: unknown } {
  const s = step as { action?: unknown; target?: unknown; value?: unknown };
  return {
    action: typeof s.action === 'string' ? s.action : '',
    target: typeof s.target === 'string' ? s.target : '',
    value: s.value,
  };
}

/** A step rendered the way a human reads it in a test plan. */
function readable(step: unknown): string {
  const { action, target, value } = stepFields(step);
  const parts = [action];
  if (target !== '') {
    parts.push(target);
  }
  if (value !== undefined) {
    parts.push(typeof value === 'string' ? value : JSON.stringify(value));
  }
  return parts.join(' ');
}

/**
 * Render test cases as CSV — the format a QA team actually exchanges test
 * inventories in. Excel opens UTF-8 CSV correctly only with a BOM, and these
 * files routinely carry non-ASCII names, so one is written.
 *
 * @public
 */
export function testCasesToCsv(testCases: TestCase[], options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  const rows: string[] = [];

  if (options.perStep === true) {
    rows.push(
      ['id', 'name', 'runner', 'step_no', 'action', 'target', 'value'].map(cell).join(delimiter),
    );
    for (const testCase of testCases) {
      testCase.steps.forEach((step, index) => {
        const { action, target, value } = stepFields(step);
        rows.push(
          [testCase.id, testCase.name, testCase.runner ?? '', index + 1, action, target, value]
            .map(cell)
            .join(delimiter),
        );
      });
    }
  } else {
    rows.push(['id', 'name', 'runner', 'steps', 'entry_url', 'detail'].map(cell).join(delimiter));
    for (const testCase of testCases) {
      const first = stepFields(testCase.steps[0]);
      const entry = first.action === 'goto' && typeof first.value === 'string' ? first.value : '';
      rows.push(
        [
          testCase.id,
          testCase.name,
          testCase.runner ?? '',
          testCase.steps.length,
          entry,
          testCase.steps.map(readable).join(' → '),
        ]
          .map(cell)
          .join(delimiter),
      );
    }
  }

  return `\ufeff${rows.join('\r\n')}\r\n`;
}
