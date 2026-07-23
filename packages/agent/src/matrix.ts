import { chat, extractJson } from './llm.js';

import type { LlmOptions } from './llm.js';
import type { DiscoveredPage } from '@test-orchestrator/browser';
import type { TestCase } from '@test-orchestrator/schema';

export interface FilterValue {
  readonly label: string;
  readonly url: string;
}

export interface FilterAxis {
  readonly axis: string;
  readonly values: FilterValue[];
}

export interface SearchAxis {
  /** CSS selector of the search input. */
  readonly input: string;
  /** CSS selector of the submit control, or undefined to press Enter. */
  readonly submit?: string;
  readonly terms: string[];
}

export interface MatrixPlan {
  /** Selector that matches one result/product card. */
  readonly resultSelector: string;
  readonly search?: SearchAxis;
  readonly filters: FilterAxis[];
}

export interface PlanResult {
  readonly plan: MatrixPlan | undefined;
  readonly rejected: string[];
  readonly raw: string;
}

const PLAN_PROMPT = `You are a senior QA engineer planning COMBINATION coverage for a
listing/search page. You do not write test cases. You identify the AXES that can be
combined.

Reply with ONLY a JSON object, no prose and no markdown fences:

{
  "resultSelector": "<one selector COPIED from the repeated selectors list>",
  "search": {
    "input":  "<css selector of the search input>",
    "submit": "<css selector of the search button, or null if there is none>",
    "terms":  ["<realistic query>", ...]
  },
  "filters": [
    { "axis": "<what this group varies, e.g. category or brand>",
      "values": [ { "label": "<short name>", "url": "<url copied EXACTLY from the link list>" } ] }
  ]
}

Rules:
- "resultSelector" MUST be copied from the repeated selectors list. Pick the one that
  most likely wraps a single result/product card: a count in the tens is a card, a count
  in the hundreds or a name like checkbox/star/icon is a filter widget, not a card.
- Every "url" MUST be copied character-for-character from the internal link list below.
  Never invent, guess, shorten or complete a URL. A URL that is not in the list is discarded.
- Group the links into axes that vary independently (categories in one axis, brands in another).
  Skip links that are not filters (login, cart, contact, social media).
- "terms" should be things a real user of THIS site would search for, based on its
  headings and links. Give as many distinct ones as you reasonably can.
- If the page has no search input, set "search" to null.
- Reply in English JSON only, even when the page content is in another language.`;

function describeForPlan(page: DiscoveredPage): string {
  const inputs = page.forms
    .flatMap((form) => form.fields.map((f) => `    - name="${f.name}" type=${f.type}`))
    .join('\n');

  const repeated = page.repeated
    .map((r) => `    - ${r.selector}  (appears ${String(r.count)}x)`)
    .join('\n');

  return `PAGE
  url: ${page.url}
  title: ${page.title}
  headings: ${page.headings.slice(0, 12).join(' | ') || '(none)'}
  form inputs:
${inputs || '    (none)'}
  repeated selectors (the ONLY selectors you may use for resultSelector):
${repeated || '    (none)'}
  internal links (the ONLY urls you may use):
${page.links.map((l) => `    - ${l}`).join('\n') || '    (none)'}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Ask the model for the axes of a listing page, then keep only what is grounded
 * in the page we actually explored: every filter URL must appear verbatim in
 * the page's own link list. Anything invented is dropped with a reason.
 *
 * @public
 */
export async function planMatrix(
  page: DiscoveredPage,
  options: LlmOptions = {},
): Promise<PlanResult> {
  let raw: string;
  try {
    raw = await chat(PLAN_PROMPT, describeForPlan(page), { ...options, json: true });
  } catch (err) {
    return {
      plan: undefined,
      rejected: [`the model call failed: ${(err as Error).message}`],
      raw: '',
    };
  }

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    return { plan: undefined, rejected: [(err as Error).message], raw };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { plan: undefined, rejected: ['the model did not return a JSON object'], raw };
  }

  const candidate = parsed as Record<string, unknown>;
  const rejected: string[] = [];

  const resultSelector = asString(candidate['resultSelector']);
  if (resultSelector === undefined) {
    return { plan: undefined, rejected: ['no resultSelector in the plan'], raw };
  }
  const knownSelectors = new Set(page.repeated.map((r) => r.selector));
  if (knownSelectors.size > 0 && !knownSelectors.has(resultSelector)) {
    return {
      plan: undefined,
      rejected: [`resultSelector "${resultSelector}" was not seen on the page`],
      raw,
    };
  }

  // Search axis
  let search: SearchAxis | undefined;
  const rawSearch = candidate['search'];
  if (typeof rawSearch === 'object' && rawSearch !== null) {
    const s = rawSearch as Record<string, unknown>;
    const input = asString(s['input']);
    const terms = Array.isArray(s['terms'])
      ? (s['terms'] as unknown[]).map(asString).filter((t): t is string => t !== undefined)
      : [];
    if (input !== undefined && terms.length > 0) {
      const submit = asString(s['submit']);
      search = { input, ...(submit !== undefined ? { submit } : {}), terms };
    } else {
      rejected.push('search axis dropped: no input selector or no terms');
    }
  }

  // Filter axes — every url must be one we actually saw on the page.
  const known = new Set(page.links);
  const filters: FilterAxis[] = [];
  const rawFilters = Array.isArray(candidate['filters']) ? (candidate['filters'] as unknown[]) : [];
  for (const rawAxis of rawFilters) {
    if (typeof rawAxis !== 'object' || rawAxis === null) {
      continue;
    }
    const a = rawAxis as Record<string, unknown>;
    const axis = asString(a['axis']) ?? 'filter';
    const values: FilterValue[] = [];
    const rawValues = Array.isArray(a['values']) ? (a['values'] as unknown[]) : [];
    for (const rawValue of rawValues) {
      if (typeof rawValue !== 'object' || rawValue === null) {
        continue;
      }
      const v = rawValue as Record<string, unknown>;
      const url = asString(v['url']);
      const label = asString(v['label']) ?? url ?? '';
      if (url === undefined) {
        continue;
      }
      if (!known.has(url)) {
        rejected.push(`invented url dropped from axis "${axis}": ${url}`);
        continue;
      }
      values.push({ label, url });
    }
    if (values.length > 0) {
      filters.push({ axis, values });
    }
  }

  if (search === undefined && filters.length === 0) {
    return { plan: undefined, rejected: [...rejected, 'the plan had no usable axes'], raw };
  }
  return {
    plan: { resultSelector, ...(search !== undefined ? { search } : {}), filters },
    rejected,
    raw,
  };
}

function slug(value: string): string {
  const s = value
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return s.length > 0 ? s.slice(0, 40) : 'x';
}

export interface MatrixOptions {
  /** Stop after this many cases (default 500). */
  readonly limit?: number;
  readonly runner?: string;
  /** Assert at least this many result cards (default 1). */
  readonly minResults?: number;
}

/**
 * Expand a plan into the cross-product of its axes. Each case navigates a
 * filter combination, optionally runs a search on top of it, and asserts that
 * results actually came back — which is what makes a filter combination a test
 * rather than a click-through.
 *
 * The combinatorics are done here, not by the model: a model asked for 500
 * cases repeats itself, whereas a cross-product is exhaustive by construction.
 *
 * @public
 */
export function generateMatrixCases(
  plan: MatrixPlan,
  entryUrl: string,
  options: MatrixOptions = {},
): TestCase[] {
  const limit = options.limit ?? 500;
  const runner = options.runner ?? 'ui';
  const minResults = options.minResults ?? 1;

  // Each axis contributes one choice per case; `undefined` means "not applied",
  // so plain search-only and filter-only cases fall out of the same product.
  const axes: (FilterValue | undefined)[][] = plan.filters.map((f) => [undefined, ...f.values]);
  const terms: (string | undefined)[] =
    plan.search === undefined ? [undefined] : [undefined, ...plan.search.terms];

  const cases: TestCase[] = [];
  const seen = new Set<string>();

  const walk = (index: number, chosen: (FilterValue | undefined)[]): void => {
    if (cases.length >= limit) {
      return;
    }
    if (index < axes.length) {
      for (const value of axes[index] ?? []) {
        walk(index + 1, [...chosen, value]);
        if (cases.length >= limit) {
          return;
        }
      }
      return;
    }

    for (const term of terms) {
      if (cases.length >= limit) {
        return;
      }
      const applied = chosen.filter((c): c is FilterValue => c !== undefined);
      if (applied.length === 0 && term === undefined) {
        continue; // no axis applied at all — nothing to assert
      }

      const steps: TestCase['steps'] = [];
      // Navigate to the last filter in the combination, or the entry page.
      const destination = applied.at(-1)?.url ?? entryUrl;
      steps.push({ id: 'goto', action: 'goto', value: destination });
      steps.push({ id: 'status', action: 'expectStatus', value: 200 });

      if (term !== undefined && plan.search !== undefined) {
        steps.push({ id: 'search', action: 'fill', target: plan.search.input, value: term });
        steps.push(
          plan.search.submit === undefined
            ? { id: 'submit', action: 'press', target: plan.search.input, value: 'Enter' }
            : { id: 'submit', action: 'click', target: plan.search.submit },
        );
      }

      steps.push({
        id: 'results',
        action: 'expectMinCount',
        target: plan.resultSelector,
        value: minResults,
      });
      steps.push({ id: 'no-errors', action: 'expectNoConsoleErrors' });

      const parts = [
        ...applied.map((a) => slug(a.label)),
        ...(term === undefined ? [] : [slug(term)]),
      ];
      const id = `matrix-${parts.join('-')}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);

      const label = [
        ...applied.map((a) => a.label),
        ...(term === undefined ? [] : [`search "${term}"`]),
      ].join(' + ');
      cases.push({ id, version: '1.0', name: `Results for ${label}`, runner, steps });
    }
  };

  walk(0, []);
  return cases;
}
