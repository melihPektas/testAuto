import { chat, extractJson } from './llm.js';

import type { LlmOptions } from './llm.js';

/** What surface a change touches, and therefore what should be tested. */
export type Surface = 'backend' | 'ui' | 'both' | 'neither';

export interface ChangedFile {
  readonly path: string;
  /** Lines added + removed, when the diff carries it. Unused by the rules. */
  readonly churn?: number;
}

export interface FileVerdict {
  readonly path: string;
  readonly surface: Surface;
  /** How the call was made: a path rule, or the model for the ambiguous ones. */
  readonly source: 'rule' | 'model';
  readonly reason: string;
}

export interface ReviewPlan {
  /** The surface to test for the change as a whole. */
  readonly surface: Surface;
  readonly files: FileVerdict[];
  /** Files whose surface the rules could not decide. */
  readonly undecided: string[];
}

interface Rule {
  readonly test: RegExp;
  readonly surface: Surface;
  readonly reason: string;
}

/**
 * Path rules, most specific first. These decide the unambiguous majority of a
 * diff with no model call — a `.tsx` component is UI, a `routes/` file is
 * backend — and the model is spent only on what genuinely straddles both.
 */
const RULES: Rule[] = [
  {
    test: /\.(test|spec)\.[jt]sx?$/i,
    surface: 'neither',
    reason: 'a test file, not the thing under test',
  },
  {
    test: /(^|\/)(__tests__|e2e|cypress|playwright)\//i,
    surface: 'neither',
    reason: 'test scaffolding',
  },
  { test: /\.(md|mdx|txt|rst)$/i, surface: 'neither', reason: 'documentation' },
  {
    test: /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i,
    surface: 'neither',
    reason: 'a static asset',
  },
  {
    test: /(^|\/)(\.github|\.gitlab|\.circleci)\//i,
    surface: 'neither',
    reason: 'CI configuration',
  },
  {
    test: /\.(lock|lockb)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
    surface: 'neither',
    reason: 'a lockfile',
  },

  // UI
  { test: /\.(css|scss|sass|less|styl)$/i, surface: 'ui', reason: 'a stylesheet' },
  { test: /\.(vue|svelte|astro)$/i, surface: 'ui', reason: 'a UI component' },
  { test: /\.(tsx|jsx)$/i, surface: 'ui', reason: 'a React component' },
  {
    test: /(^|\/)(components?|pages?|views?|screens?|layouts?|widgets?)\//i,
    surface: 'ui',
    reason: 'lives in a UI folder',
  },
  { test: /(^|\/)(public|static|assets)\//i, surface: 'ui', reason: 'a front-end asset path' },

  // Backend
  {
    test: /(^|\/)(routes?|controllers?|handlers?|endpoints?|api)\//i,
    surface: 'backend',
    reason: 'an API layer',
  },
  {
    test: /(^|\/)(models?|entities|repositories|repos|dao|migrations?|schema)\//i,
    surface: 'backend',
    reason: 'a data layer',
  },
  { test: /(^|\/)(services?|usecases?|domain)\//i, surface: 'backend', reason: 'a service layer' },
  {
    test: /(^|\/)(middleware|guards?|interceptors?)\//i,
    surface: 'backend',
    reason: 'server middleware',
  },
  { test: /\.(sql|prisma|graphql|proto)$/i, surface: 'backend', reason: 'a backend schema' },
  {
    test: /(^|\/)server(\.[jt]s)?$|(^|\/)(server|backend|api)\//i,
    surface: 'backend',
    reason: 'a server path',
  },
  {
    test: /(Dockerfile|docker-compose\.ya?ml)$/i,
    surface: 'backend',
    reason: 'deployment/runtime',
  },
];

/** Classify one path by rule alone, or return undefined if it needs judgement. */
export function ruleForFile(path: string): FileVerdict | undefined {
  for (const rule of RULES) {
    if (rule.test.test(path)) {
      return { path, surface: rule.surface, source: 'rule', reason: rule.reason };
    }
  }
  return undefined;
}

/** Combine per-file surfaces into the surface for the change as a whole. */
export function combineSurfaces(surfaces: Surface[]): Surface {
  const relevant = surfaces.filter((s) => s !== 'neither');
  const hasUi = relevant.includes('ui') || relevant.includes('both');
  const hasBackend = relevant.includes('backend') || relevant.includes('both');
  if (hasUi && hasBackend) {
    return 'both';
  }
  if (hasUi) {
    return 'ui';
  }
  if (hasBackend) {
    return 'backend';
  }
  return 'neither';
}

const CLASSIFY_PROMPT = `You are triaging a code change to decide what kind of testing it needs.

For each file path you are given, decide whether the change is most likely to affect
the BACKEND (APIs, data, server logic), the UI (what a user sees and interacts with),
BOTH, or NEITHER (config, docs, tooling that changes no observable behaviour).

Reply with ONLY a JSON array, one object per input path, in the same order:
[ { "path": "<exactly as given>", "surface": "backend" | "ui" | "both" | "neither",
    "reason": "<one short clause>" } ]

Judge by what the file most likely contains, not its extension alone. A shared type
used by both a form and an endpoint is "both". Reply in English JSON only.`;

function asSurface(value: unknown): Surface | undefined {
  return value === 'backend' || value === 'ui' || value === 'both' || value === 'neither'
    ? value
    : undefined;
}

async function classifyWithModel(
  paths: string[],
  options: LlmOptions,
): Promise<Map<string, FileVerdict>> {
  const out = new Map<string, FileVerdict>();
  if (paths.length === 0) {
    return out;
  }

  let parsed: unknown;
  try {
    const raw = await chat(CLASSIFY_PROMPT, paths.map((p) => `- ${p}`).join('\n'), {
      temperature: 0,
      ...options,
      json: true,
    });
    parsed = extractJson(raw);
  } catch {
    parsed = undefined;
  }

  const rows = Array.isArray(parsed) ? parsed : [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const path = typeof record['path'] === 'string' ? record['path'] : undefined;
    const surface = asSurface(record['surface']);
    if (path !== undefined && surface !== undefined && paths.includes(path)) {
      const reason = typeof record['reason'] === 'string' ? record['reason'] : 'model judgement';
      out.set(path, { path, surface, source: 'model', reason });
    }
  }

  // Any path the model skipped or mangled falls back to "both" — the safe
  // choice, because it tests more rather than less.
  for (const path of paths) {
    if (!out.has(path)) {
      out.set(path, {
        path,
        surface: 'both',
        source: 'model',
        reason: 'unclassified; testing both to be safe',
      });
    }
  }
  return out;
}

/**
 * Decide what a set of changed files should have tested. Rules run first and
 * settle the clear cases; only the genuinely ambiguous paths reach the model,
 * and if there is no model (or it fails) they default to `both` rather than
 * being dropped — a change tested on the wrong surface is worse than one tested
 * on an extra surface.
 *
 * @public
 */
export async function planReview(
  files: ChangedFile[],
  options: LlmOptions = {},
): Promise<ReviewPlan> {
  const verdicts: FileVerdict[] = [];
  const ambiguous: string[] = [];

  for (const file of files) {
    const byRule = ruleForFile(file.path);
    if (byRule !== undefined) {
      verdicts.push(byRule);
    } else {
      ambiguous.push(file.path);
    }
  }

  const modelVerdicts = await classifyWithModel(ambiguous, options);
  for (const path of ambiguous) {
    const verdict = modelVerdicts.get(path);
    if (verdict !== undefined) {
      verdicts.push(verdict);
    }
  }

  // Keep the input order, which is the order a reader expects.
  const order = new Map(files.map((f, i) => [f.path, i]));
  verdicts.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));

  return {
    surface: combineSurfaces(verdicts.map((v) => v.surface)),
    files: verdicts,
    undecided: ambiguous.filter((p) => modelVerdicts.get(p)?.source !== 'model'),
  };
}
