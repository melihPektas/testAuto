import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateTestCase } from '@test-orchestrator/schema';

import type { DiscoveredPage } from '@test-orchestrator/browser';
import type { TestCase } from '@test-orchestrator/schema';

/**
 * A stable fingerprint of everything the author sees about a page, plus the
 * model and scenario count. Change any of them and the key changes, so a stale
 * cache is impossible to hit — the cache invalidates itself.
 */
export function signPage(page: DiscoveredPage, model: string, count: number): string {
  const shape = {
    url: page.url,
    title: page.title,
    headings: page.headings,
    links: page.links,
    forms: page.forms.map((f) => ({
      action: f.action,
      method: f.method,
      fields: f.fields.map((field) => ({ name: field.name, type: field.type })),
    })),
    model,
    count,
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}

/**
 * Read cached authored cases, or undefined on a miss. Every cached case is
 * re-validated against the schema: a cache file can be edited by hand, and it
 * must never become a way to slip an unvalidated test case past the boundary.
 * A single invalid entry is treated as a miss.
 *
 * @public
 */
export async function readAuthorCache(
  cacheDir: string,
  key: string,
): Promise<TestCase[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(cacheDir, `${key}.json`), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const cases: TestCase[] = [];
  for (const item of parsed) {
    const result = validateTestCase(item);
    if (!result.ok) {
      return undefined;
    }
    cases.push(result.data);
  }
  return cases;
}

/** @public */
export async function writeAuthorCache(
  cacheDir: string,
  key: string,
  cases: TestCase[],
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, `${key}.json`), `${JSON.stringify(cases, null, 2)}\n`, 'utf8');
}
