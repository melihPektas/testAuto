import { formatAjvErrors, validateTestCase } from '@test-orchestrator/schema';

import { chat, extractJson } from './llm.js';

import type { LlmOptions } from './llm.js';
import type { DiscoveredPage } from '@test-orchestrator/browser';
import type { TestCase } from '@test-orchestrator/schema';

/** The only step actions the browser runner understands. */
export const ALLOWED_ACTIONS = [
  'goto',
  'expectStatus',
  'expectTitle',
  'expectSelector',
  'expectText',
  'click',
  'fill',
  'select',
  'check',
  'press',
  'waitFor',
  'expectUrl',
  'expectMinCount',
  'audit',
] as const;

export interface AuthorOptions extends LlmOptions {
  /** Runner name the authored cases should target (default `ui`). */
  readonly runner?: string;
  /** How many scenarios to ask for (default 3). */
  readonly count?: number;
}

export interface RejectedCase {
  readonly reason: string;
  readonly raw: unknown;
}

export interface AuthoredResult {
  readonly accepted: TestCase[];
  readonly rejected: RejectedCase[];
  /** Raw model response, useful when nothing survived validation. */
  readonly raw: string;
}

const SYSTEM_PROMPT = `You are a senior QA engineer. You write end-to-end UI test cases for a web page.

Reply with ONLY a JSON array of test case objects. No prose, no markdown fences.

Each test case object MUST have exactly these keys:
  "id":      short kebab-case string, unique
  "version": "1.0"
  "name":    a short human sentence describing the scenario
  "steps":   an array of step objects

Each step object MUST have an "action" from this list ONLY:
  goto            {"action":"goto","value":"<absolute url>"}
  expectStatus    {"action":"expectStatus","value":200}
  expectTitle     {"action":"expectTitle","value":"<substring>"}   (value optional)
  expectSelector  {"action":"expectSelector","target":"<css selector>"}
  expectText      {"action":"expectText","value":"<text on the page>"}
  click           {"action":"click","target":"<css selector>"}
  fill            {"action":"fill","target":"<css selector>","value":"<text>"}
  select          {"action":"select","target":"<css selector>","value":"<option>"}
  check           {"action":"check","target":"<css selector>"}
  press           {"action":"press","target":"<css selector>","value":"Enter"}
  waitFor         {"action":"waitFor","target":"<css selector>"}
  expectUrl       {"action":"expectUrl","value":"<substring the URL must contain>"}
  expectMinCount  {"action":"expectMinCount","target":"<css selector>","value":<number>}
  audit           {"action":"audit"}

Rules:
- The first step of every test case MUST be a goto to a URL on the page's own origin.
- Only reference selectors, fields and links that appear in the page description.
- Prefer realistic user journeys over trivial checks.`;

function describePage(page: DiscoveredPage, count: number): string {
  const forms = page.forms
    .map((form, i) => {
      const fields = form.fields
        .map((f) => `      - name="${f.name}" type=${f.type}${f.required ? ' (required)' : ''}`)
        .join('\n');
      return `  form #${String(i + 1)} method=${form.method} action="${form.action}" submit=${String(form.hasSubmit)}\n${fields}`;
    })
    .join('\n');

  return `PAGE
  url: ${page.url}
  title: ${page.title}
  headings: ${page.headings.slice(0, 8).join(' | ') || '(none)'}
  internal links:
${
  page.links
    .slice(0, 12)
    .map((l) => `    - ${l}`)
    .join('\n') || '    (none)'
}
  forms:
${forms || '  (none)'}

Write ${String(count)} distinct, realistic test scenarios for this page as a JSON array.`;
}

function stepsAreAllowed(testCase: TestCase): string | undefined {
  for (const step of testCase.steps) {
    const action = (step as { action?: unknown }).action;
    if (
      typeof action !== 'string' ||
      !ALLOWED_ACTIONS.includes(action as (typeof ALLOWED_ACTIONS)[number])
    ) {
      return `step uses an unsupported action: ${String(action)}`;
    }
  }
  return undefined;
}

function firstStepStaysOnOrigin(testCase: TestCase, origin: string): string | undefined {
  const first = testCase.steps[0] as { action?: unknown; value?: unknown } | undefined;
  if (first?.action !== 'goto') {
    return 'the first step must be a goto';
  }
  const value = typeof first.value === 'string' ? first.value : '';
  if (!value.startsWith(origin)) {
    return `goto leaves the explored origin: ${value}`;
  }
  return undefined;
}

/**
 * Ask an LLM to author realistic test cases for a discovered page, then keep
 * only the ones that survive validation: the JSON Schema, the runner's action
 * vocabulary, and a same-origin check on the entry step. Model output is never
 * trusted — anything that fails is returned in `rejected` with a reason.
 *
 * @public
 */
export async function authorTestsForPage(
  page: DiscoveredPage,
  options: AuthorOptions = {},
): Promise<AuthoredResult> {
  const count = options.count ?? 3;
  const runner = options.runner ?? 'ui';
  const origin = new URL(page.url).origin;

  let raw: string;
  try {
    raw = await chat(SYSTEM_PROMPT, describePage(page, count), options);
  } catch (err) {
    // A slow, unreachable or aborted model must not take the caller down.
    const reason =
      (err as Error).name === 'AbortError'
        ? 'the model did not respond before the timeout'
        : `the model call failed: ${(err as Error).message}`;
    return { accepted: [], rejected: [{ reason, raw: null }], raw: '' };
  }

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    return { accepted: [], rejected: [{ reason: (err as Error).message, raw }], raw };
  }

  const candidates: unknown[] = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  const accepted: TestCase[] = [];
  const rejected: RejectedCase[] = [];

  for (const candidate of candidates) {
    const withRunner =
      typeof candidate === 'object' && candidate !== null
        ? { ...(candidate as Record<string, unknown>), runner }
        : candidate;

    const result = validateTestCase(withRunner);
    if (!result.ok) {
      rejected.push({ reason: formatAjvErrors(result.errors), raw: candidate });
      continue;
    }
    const badAction = stepsAreAllowed(result.data);
    if (badAction !== undefined) {
      rejected.push({ reason: badAction, raw: candidate });
      continue;
    }
    const badOrigin = firstStepStaysOnOrigin(result.data, origin);
    if (badOrigin !== undefined) {
      rejected.push({ reason: badOrigin, raw: candidate });
      continue;
    }
    accepted.push(result.data);
  }

  return { accepted, rejected, raw };
}
