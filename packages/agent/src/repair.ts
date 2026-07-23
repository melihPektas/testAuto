import { chat, extractJson } from './llm.js';

import type { LlmOptions } from './llm.js';
import type { Failure, Triage } from './triage.js';
import type { TestCase } from '@test-orchestrator/schema';

/**
 * The only verdict a repair may act on.
 *
 * A repair changes the test, so it is only ever the right response when the
 * test is what is wrong. Repairing a `product-bug` hides a real defect;
 * repairing an `environment` failure pretends a blocked run succeeded; and
 * repairing `test-data` would mean inventing credentials, which this never does.
 */
export const REPAIRABLE_VERDICTS = ['test-bug'] as const;

/**
 * The only edit a repair may make: point a step at a different selector.
 *
 * Everything else a model might suggest — deleting the failing step, lowering an
 * expected count, accepting a different status, rewriting an expected string —
 * makes the test pass without making anything work. A suite that heals by
 * weakening itself is worse than one that stays red.
 */
export interface Retarget {
  readonly kind: 'retarget';
  /** 0-based index of the step to change. */
  readonly stepIndex: number;
  readonly from: string;
  readonly to: string;
  readonly rationale: string;
}

export type Repair = Retarget;

export interface RepairProposal {
  readonly testCaseId: string;
  readonly repair?: Repair;
  /** Why no repair was proposed, when there is none. */
  readonly declined?: string;
}

const REPAIR_PROMPT = `You are a senior QA engineer fixing a test whose SELECTOR has gone stale
after a UI change. The application works; the test is looking for the wrong element.

Reply with ONLY a JSON object:

{
  "to":        one selector copied EXACTLY from the candidate list, or null,
  "rationale": one sentence on why it is the same element under a new name
}

Rules:
- "to" MUST be one of the candidates listed. Anything else is discarded.
- Choose only a selector that means the SAME THING as the one the step wanted.
  A step waiting for a success message must not be pointed at an error message
  just because both matched the word "message" — that would make a broken login
  look like a passing test. When no candidate means the same thing, return null.
- Return null if you are not confident. A test left failing is cheap; a test
  that passes for the wrong reason is not.`;

/** Render a value for the prompt without ever producing "[object Object]". */
function plain(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined ? fallback : JSON.stringify(value);
}

function describeRepair(testCase: TestCase, failure: Failure, candidates: string[]): string {
  const step = testCase.steps[failure.stepNumber === undefined ? 0 : failure.stepNumber - 1] as
    { action?: unknown; target?: unknown } | undefined;

  return `TEST
  name: ${testCase.name}
  the failing step wanted: ${plain(step?.action)} ${plain(step?.target)}
  error: ${failure.message}

WHAT THE PAGE SHOWED
  url: ${plain(failure.evidence?.['url'], '(unknown)')}
  visible text: ${plain(failure.evidence?.['excerpt'], '(none)')}

CANDIDATE SELECTORS (the only values you may return)
${candidates.map((c) => `  - ${c}`).join('\n')}`;
}

/**
 * Propose a repair for one failure, or decline.
 *
 * Nothing is proposed unless triage says the test is at fault and the page
 * itself offered a replacement selector: candidates come from the evidence the
 * runner captured, never from the model's imagination.
 *
 * @public
 */
export async function proposeRepair(
  testCase: TestCase,
  failure: Failure,
  triage: Triage,
  options: LlmOptions = {},
): Promise<RepairProposal> {
  const declined = (reason: string): RepairProposal => ({
    testCaseId: testCase.id,
    declined: reason,
  });

  if (!(REPAIRABLE_VERDICTS as readonly string[]).includes(triage.verdict)) {
    return declined(`verdict is ${triage.verdict}; only a test-bug is ever repaired`);
  }
  if (triage.confidence !== 'high') {
    return declined('triage was not confident enough to change the test');
  }

  const stepIndex = (failure.stepNumber ?? 0) - 1;
  const step = testCase.steps[stepIndex] as { target?: unknown } | undefined;
  const from = typeof step?.target === 'string' ? step.target : undefined;
  if (from === undefined) {
    return declined('the failing step has no selector to retarget');
  }

  const evidence = failure.evidence ?? {};
  if (evidence['targetCount'] !== 0) {
    return declined('the selector did match elements, so it is not stale');
  }
  const candidates = Array.isArray(evidence['similarSelectors'])
    ? (evidence['similarSelectors'] as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  if (candidates.length === 0) {
    return declined('the page offered no replacement selector');
  }

  let raw: string;
  try {
    raw = await chat(REPAIR_PROMPT, describeRepair(testCase, failure, candidates), {
      temperature: 0,
      ...options,
      json: true,
    });
  } catch (err) {
    return declined(`could not be repaired: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch {
    return declined('the model did not return a usable repair');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return declined('the model did not return a JSON object');
  }

  const candidate = parsed as Record<string, unknown>;
  const to = typeof candidate['to'] === 'string' ? candidate['to'].trim() : '';
  if (to === '') {
    return declined('the model found no candidate that means the same thing');
  }
  if (!candidates.includes(to)) {
    return declined(`the model invented a selector that is not on the page: ${to}`);
  }
  if (to === from) {
    return declined('the proposed selector is the one that already failed');
  }

  return {
    testCaseId: testCase.id,
    repair: {
      kind: 'retarget',
      stepIndex,
      from,
      to,
      rationale:
        typeof candidate['rationale'] === 'string' && candidate['rationale'].trim().length > 0
          ? candidate['rationale'].trim()
          : 'no rationale given',
    },
  };
}

/**
 * Apply a repair, returning a new test case. Only the one step's `target`
 * changes: no step is added, removed, reordered, or has its action or expected
 * value touched.
 *
 * @public
 */
export function applyRepair(testCase: TestCase, repair: Repair): TestCase {
  return {
    ...testCase,
    steps: testCase.steps.map((step, i) =>
      i === repair.stepIndex ? { ...step, target: repair.to } : step,
    ),
  };
}

/**
 * Check that a repaired test case differs from the original in exactly the way
 * a repair is allowed to. This runs on the result, so a bug in `applyRepair`
 * cannot quietly weaken a suite either.
 *
 * @public
 */
export function repairIsSafe(
  before: TestCase,
  after: TestCase,
  repair: Repair,
): string | undefined {
  if (before.steps.length !== after.steps.length) {
    return 'a repair may not add or remove steps';
  }
  for (let i = 0; i < before.steps.length; i += 1) {
    const a = before.steps[i] as unknown as Record<string, unknown>;
    const b = after.steps[i] as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (JSON.stringify(a[key]) === JSON.stringify(b[key])) {
        continue;
      }
      if (i !== repair.stepIndex) {
        return `a repair may only change the failing step, but step ${String(i + 1)} changed`;
      }
      if (key !== 'target') {
        return `a repair may only change a step's target, but "${key}" changed`;
      }
    }
  }
  return undefined;
}
