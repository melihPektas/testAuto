import { describe, expect, it } from 'vitest';

import { testCasesToCsv } from '../src/export/csv.js';

import type { TestCase } from '@test-orchestrator/schema';

const cases = [
  {
    id: 'a',
    version: '1.0',
    name: 'Results for Elbise + search "yazlık"',
    runner: 'ui',
    steps: [
      { id: 'goto', action: 'goto', value: 'https://shop.test/elbise' },
      { id: 'q', action: 'fill', target: '#q', value: 'say "hi"' },
      { id: 'n', action: 'expectMinCount', target: '.card', value: 1 },
    ],
  },
] as unknown as TestCase[];

describe('testCasesToCsv', () => {
  it('writes one row per case with a BOM and CRLF endings', () => {
    const csv = testCasesToCsv(cases);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv.trimEnd().split('\r\n')).toHaveLength(2);
  });

  it('escapes embedded quotes so the row does not break', () => {
    const csv = testCasesToCsv(cases);
    expect(csv).toContain('""hi""');
    expect(csv).toContain('Results for Elbise + search ""yazlık""');
  });

  it('records the entry url and a readable step trail', () => {
    const csv = testCasesToCsv(cases);
    expect(csv).toContain('https://shop.test/elbise');
    expect(csv).toContain('→');
  });

  it('writes one row per step when asked', () => {
    const csv = testCasesToCsv(cases, { perStep: true });
    expect(csv.trimEnd().split('\r\n')).toHaveLength(4);
    expect(csv).toContain('"expectMinCount"');
  });
});
