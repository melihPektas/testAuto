export interface ParsedTestFile {
  /** `describe(...)` block names, outermost first (in source order). */
  readonly suites: string[];
  /** `it(...)` / `test(...)` names in source order. */
  readonly tests: string[];
}

/**
 * Matches `describe|it|test` (plus modifiers like `.only`, `.skip`, `.each`)
 * followed by a quoted name. Deliberately regex-based: parsing arbitrary test
 * files with a real AST would drag a parser dependency into core for little
 * gain — a test name is all we need.
 */
const BLOCK_RE =
  /\b(describe|it|test)(?:\.\w+)*(?:\s*\([^()]*\))?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;

/** Strip line and block comments so commented-out tests are not picked up. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Extract suite and test names from a test file's source.
 *
 * @public
 */
export function parseTestFile(source: string): ParsedTestFile {
  const cleaned = stripComments(source);
  const suites: string[] = [];
  const tests: string[] = [];

  BLOCK_RE.lastIndex = 0;
  let match = BLOCK_RE.exec(cleaned);
  while (match !== null) {
    const kind = match[1];
    const name = (match[3] ?? '').replace(/\\(['"`])/g, '$1').trim();
    if (name.length > 0) {
      if (kind === 'describe') {
        suites.push(name);
      } else {
        tests.push(name);
      }
    }
    match = BLOCK_RE.exec(cleaned);
  }

  return { suites, tests };
}
