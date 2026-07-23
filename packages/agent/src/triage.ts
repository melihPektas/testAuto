import { chat, extractJson } from './llm.js';

import type { LlmOptions } from './llm.js';

/**
 * What a failure actually means. These are the decisions a human triager makes
 * before anyone opens a ticket.
 */
export const VERDICTS = [
  /** The application is genuinely broken. */
  'product-bug',
  /** The test's expectation, selector or flow is wrong. */
  'test-bug',
  /** Timing, races, transient slowness — the same run could pass. */
  'flaky',
  /** The environment refused us: blocked, down, unreachable, unauthorised. */
  'environment',
  /** The test used data (credentials, ids, fixtures) that does not exist. */
  'test-data',
] as const;

export type Verdict = (typeof VERDICTS)[number];

export interface RunContext {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Names of tests that passed — the strongest evidence the app is not broken. */
  readonly passingTests: string[];
}

export interface Failure {
  readonly testCaseId: string;
  readonly testCaseName: string;
  /** 1-based index of the step that failed. */
  readonly stepNumber?: number;
  readonly action?: string;
  readonly target?: string;
  readonly value?: unknown;
  readonly message: string;
  /** Output of the steps that passed before it, most recent last. */
  readonly priorOutput?: string[];
  readonly retries?: number;
  /** How the rest of the run went. A failure alone reads very differently. */
  readonly runContext?: RunContext;
  /** What the page looked like when it failed, captured by the runner. */
  readonly evidence?: Record<string, unknown>;
}

export interface Triage {
  readonly testCaseId: string;
  readonly verdict: Verdict;
  readonly confidence: 'high' | 'low';
  readonly reason: string;
  /** What to do about it, when there is something concrete to say. */
  readonly suggestion?: string;
  /** Whether a rule decided this, or the model did. */
  readonly source: 'rule' | 'model';
}

interface Rule {
  readonly test: RegExp;
  readonly verdict: Verdict;
  readonly reason: string;
  readonly suggestion?: string;
}

/**
 * Failures whose cause is not a judgement call. Running these first keeps the
 * model out of decisions that a regex is simply better at, which matters when a
 * local model costs tens of seconds per call.
 */
const RULES: Rule[] = [
  {
    test: /\bgot (?:401|403)\b/,
    verdict: 'environment',
    reason: 'the server refused the request (401/403), so the page was never exercised',
    suggestion: 'run from an environment the target permits, or supply credentials',
  },
  {
    test: /\bgot (?:429)\b/,
    verdict: 'environment',
    reason: 'the server rate-limited the run',
    suggestion: 'reduce concurrency or add a delay between cases',
  },
  {
    test: /\bgot (?:5\d\d)\b/,
    verdict: 'product-bug',
    reason: 'the server returned a 5xx, which is a fault on the application side',
  },
  {
    test: /net::ERR_(?:NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_RESET)|ECONNREFUSED|ENOTFOUND/,
    verdict: 'environment',
    reason: 'the target could not be reached at all',
    suggestion: 'check the host is up and reachable from here',
  },
  {
    test: /\bgot (?:404)\b/,
    verdict: 'test-bug',
    reason: 'the url the test navigates to does not exist',
    suggestion: 'the test case is pointing at a stale url',
  },
];

/** Classify a failure by rule alone, or return undefined if it needs judgement. */
export function ruleTriage(failure: Failure): Triage | undefined {
  for (const rule of RULES) {
    if (rule.test.test(failure.message)) {
      return {
        testCaseId: failure.testCaseId,
        verdict: rule.verdict,
        confidence: 'high',
        reason: rule.reason,
        ...(rule.suggestion !== undefined ? { suggestion: rule.suggestion } : {}),
        source: 'rule',
      };
    }
  }
  // A step that only passed on retry is flaky by definition, not by opinion.
  if ((failure.retries ?? 0) > 0) {
    return {
      testCaseId: failure.testCaseId,
      verdict: 'flaky',
      confidence: 'high',
      reason: 'the step needed a retry, so the same code passed and failed in one run',
      source: 'rule',
    };
  }
  return undefined;
}

const TRIAGE_PROMPT = `You are a senior QA engineer triaging a failed UI test. Decide what
the failure MEANS. You are not fixing it.

Reply with ONLY a JSON object:

{
  "verdict":    one of ${VERDICTS.map((v) => `"${v}"`).join(' | ')},
  "confidence": "high" or "low",
  "reason":     one sentence, concrete, referring to the actual error,
  "suggestion": one sentence on what to do, or null
}

What the verdicts mean:
  product-bug  the application is broken and a ticket should be opened
  test-bug     the test is wrong: bad selector, wrong expectation, wrong flow
  flaky        timing or a race; the same test could pass on a rerun
  environment  we were blocked, throttled, or the target was unreachable
  test-data    the test used credentials, ids or fixtures that do not exist

Guidance:
- Weigh the rest of the run first. If tests exercising the SAME feature passed,
  the application is working and the fault is far more likely in this test or in
  the data it used. Only call product-bug when the evidence points at the app.
- Read "what the page actually showed" before deciding. If the page rendered a
  related selector instead of the one the step wanted — an error message where a
  success message was expected — the page is TELLING you why, and it is usually
  test-data or test-bug, not a broken application.
- A page that rendered almost no text never really loaded: that is environment.
- A selector that never appears is usually test-bug, unless earlier steps prove
  the page did render and the element is genuinely missing.
- A login that leads nowhere, with credentials that look invented
  (user@example.com, securePassword123, test/test), is test-data — not a bug.
- Say "low" confidence when the evidence does not separate two verdicts.
- Reply in English JSON only.`;

function describeFailure(failure: Failure): string {
  const prior = failure.priorOutput
    ?.slice(-4)
    .map((o) => `    - ${o}`)
    .join('\n');
  return `FAILED TEST
  name: ${failure.testCaseName}
  failing step: ${failure.stepNumber === undefined ? '?' : `#${String(failure.stepNumber)}`} ${failure.action ?? ''} ${failure.target ?? ''}
  step value: ${failure.value === undefined ? '(none)' : JSON.stringify(failure.value)}
  error: ${failure.message}
  what happened before it:
${prior === undefined || prior === '' ? '    (nothing)' : prior}
${describeEvidence(failure.evidence)}
${describeRun(failure.runContext)}`;
}

function describeEvidence(evidence: Record<string, unknown> | undefined): string {
  if (evidence === undefined) {
    return '';
  }
  const get = (key: string): unknown => evidence[key];
  const lines: string[] = [];
  if (typeof get('url') === 'string') {
    lines.push(`  the browser was at: ${String(get('url'))}`);
  }
  if (typeof get('title') === 'string') {
    lines.push(`  page title: ${String(get('title'))}`);
  }
  if (typeof get('bodyChars') === 'number') {
    const chars = get('bodyChars') as number;
    lines.push(
      `  the page rendered ${String(chars)} characters of text${chars < 50 ? ' — essentially nothing' : ''}`,
    );
  }
  if (typeof get('targetCount') === 'number') {
    lines.push(
      `  the selector the step looked for matched ${String(get('targetCount'))} element(s)`,
    );
  }
  const similar = get('similarSelectors');
  if (Array.isArray(similar) && similar.length > 0) {
    lines.push(
      `  but the page DOES contain these related selectors: ${similar.map(String).join(', ')}`,
    );
  }
  if (typeof get('excerpt') === 'string' && String(get('excerpt')).length > 0) {
    lines.push(`  visible text: "${String(get('excerpt')).slice(0, 240)}"`);
  }
  return lines.length === 0 ? '' : `\nWHAT THE PAGE ACTUALLY SHOWED\n${lines.join('\n')}`;
}

function describeRun(context: RunContext | undefined): string {
  if (context === undefined) {
    return '';
  }
  const passing = context.passingTests
    .slice(0, 8)
    .map((name) => `    - ${name}`)
    .join('\n');
  return `
THE REST OF THIS RUN
  ${String(context.passed)} of ${String(context.total)} tests passed.
  tests that PASSED (the application demonstrably works for these):
${passing === '' ? '    (none)' : passing}`;
}

function asVerdict(value: unknown): Verdict | undefined {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value)
    ? (value as Verdict)
    : undefined;
}

/**
 * Triage one failure: rules first, the model only for what needs judgement.
 * A model that is slow, unreachable or off-contract yields a `low` confidence
 * result rather than an exception, because triage must never break the run that
 * produced the failure.
 *
 * @public
 */
export async function triageFailure(failure: Failure, options: LlmOptions = {}): Promise<Triage> {
  const byRule = ruleTriage(failure);
  if (byRule !== undefined) {
    return byRule;
  }

  const unknown = (reason: string): Triage => ({
    testCaseId: failure.testCaseId,
    verdict: 'test-bug',
    confidence: 'low',
    reason,
    source: 'model',
  });

  let raw: string;
  try {
    raw = await chat(TRIAGE_PROMPT, describeFailure(failure), { ...options, json: true });
  } catch (err) {
    return unknown(`could not be triaged: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch {
    return unknown('the model did not return a usable verdict');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return unknown('the model did not return a JSON object');
  }

  const candidate = parsed as Record<string, unknown>;
  const verdict = asVerdict(candidate['verdict']);
  if (verdict === undefined) {
    return unknown(`the model returned an unknown verdict: ${String(candidate['verdict'])}`);
  }
  const reason =
    typeof candidate['reason'] === 'string' && candidate['reason'].trim().length > 0
      ? candidate['reason'].trim()
      : 'no reason given';
  const suggestion =
    typeof candidate['suggestion'] === 'string' && candidate['suggestion'].trim().length > 0
      ? candidate['suggestion'].trim()
      : undefined;

  return {
    testCaseId: failure.testCaseId,
    verdict,
    confidence: candidate['confidence'] === 'high' ? 'high' : 'low',
    reason,
    ...(suggestion !== undefined ? { suggestion } : {}),
    source: 'model',
  };
}

interface ReportStep {
  status?: string;
  action?: string;
  output?: string;
  retries?: number;
  error?: { message?: string };
  evidence?: Record<string, unknown>;
}

interface ReportResult {
  testCaseId?: string;
  testCaseName?: string;
  status?: string;
  steps?: ReportStep[];
  error?: { message?: string };
}

/**
 * Turn a JSON run report into triage input. Passing the test cases as well
 * recovers each failing step's target and value, which the report does not
 * carry and which is often the whole story.
 *
 * @public
 */
export function failuresFromReport(
  report: { results?: ReportResult[] },
  testCases: { id: string; steps: unknown[] }[] = [],
): Failure[] {
  const byId = new Map(testCases.map((t) => [t.id, t]));
  const failures: Failure[] = [];
  const all = report.results ?? [];
  const runContext: RunContext = {
    total: all.length,
    passed: all.filter((r) => r.status === 'pass').length,
    failed: all.filter((r) => r.status === 'fail').length,
    passingTests: all.filter((r) => r.status === 'pass').map((r) => r.testCaseName ?? '(unnamed)'),
  };

  for (const result of report.results ?? []) {
    if (result.status !== 'fail') {
      continue;
    }
    const steps = result.steps ?? [];
    const index = steps.findIndex((s) => s.status === 'fail');
    const step = index === -1 ? undefined : steps[index];
    const source = byId.get(result.testCaseId ?? '')?.steps[index] as
      { target?: unknown; value?: unknown } | undefined;

    failures.push({
      testCaseId: result.testCaseId ?? '(unknown)',
      testCaseName: result.testCaseName ?? '(unnamed)',
      ...(index === -1 ? {} : { stepNumber: index + 1 }),
      ...(step?.action !== undefined ? { action: step.action } : {}),
      ...(typeof source?.target === 'string' ? { target: source.target } : {}),
      ...(source?.value !== undefined ? { value: source.value } : {}),
      message: step?.error?.message ?? result.error?.message ?? 'no error message',
      priorOutput: steps
        .slice(0, index === -1 ? steps.length : index)
        .map((s) => s.output)
        .filter((o): o is string => typeof o === 'string'),
      ...(step?.retries !== undefined ? { retries: step.retries } : {}),
      ...(step?.evidence !== undefined ? { evidence: step.evidence } : {}),
      runContext,
    });
  }
  return failures;
}

export interface TriageSummary {
  readonly triaged: Triage[];
  /** How many verdicts each rule/model produced, for a quick read of a run. */
  readonly byVerdict: Record<string, number>;
  readonly byRule: number;
  readonly byModel: number;
}

/**
 * Triage every failure in a run.
 *
 * @public
 */
export async function triageFailures(
  failures: Failure[],
  options: LlmOptions & { onTriage?: (triage: Triage) => void } = {},
): Promise<TriageSummary> {
  const triaged: Triage[] = [];
  for (const failure of failures) {
    const result = await triageFailure(failure, options);
    options.onTriage?.(result);
    triaged.push(result);
  }

  const byVerdict: Record<string, number> = {};
  for (const item of triaged) {
    byVerdict[item.verdict] = (byVerdict[item.verdict] ?? 0) + 1;
  }
  return {
    triaged,
    byVerdict,
    byRule: triaged.filter((t) => t.source === 'rule').length,
    byModel: triaged.filter((t) => t.source === 'model').length,
  };
}
