import { describe, expect, it } from 'vitest';

import { parseTestFile } from '../src/ingest/parse.js';

describe('parseTestFile', () => {
  it('extracts describe suites and it/test names', () => {
    const source = `
      describe('math', () => {
        it('adds numbers', () => {});
        test("subtracts numbers", () => {});
      });
      describe(\`strings\`, () => {
        it(\`concatenates\`, () => {});
      });
    `;
    const parsed = parseTestFile(source);
    expect(parsed.suites).toEqual(['math', 'strings']);
    expect(parsed.tests).toEqual(['adds numbers', 'subtracts numbers', 'concatenates']);
  });

  it('handles modifiers like .only / .skip / .each', () => {
    const source = `
      it.only('runs alone', () => {});
      test.skip('is skipped', () => {});
      describe.each([1])('parametrised', () => {});
    `;
    const parsed = parseTestFile(source);
    expect(parsed.tests).toEqual(['runs alone', 'is skipped']);
    expect(parsed.suites).toEqual(['parametrised']);
  });

  it('ignores commented-out tests', () => {
    const source = `
      // it('commented out', () => {});
      /* it('block commented', () => {}); */
      it('real one', () => {});
    `;
    expect(parseTestFile(source).tests).toEqual(['real one']);
  });

  it('keeps escaped quotes inside names', () => {
    const parsed = parseTestFile("it('handles \\'quoted\\' input', () => {});");
    expect(parsed.tests).toEqual(["handles 'quoted' input"]);
  });

  it('returns empty lists for a file with no tests', () => {
    expect(parseTestFile('export const x = 1;')).toEqual({ suites: [], tests: [] });
  });
});
