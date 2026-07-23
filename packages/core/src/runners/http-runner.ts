import { formatAjvErrors, validateAgainst } from '@test-orchestrator/schema';

import type { Runner, RunContext, StepResult } from '../types.js';

export interface HttpRunnerOptions {
  /** Base URL prepended to relative request targets. */
  readonly baseUrl?: string;
}

/** Stringify a step value safely (never "[object Object]"). */
function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

function resolveUrl(rawUrl: string, baseUrl: string | undefined): string {
  if (/^https?:\/\//.test(rawUrl)) {
    return rawUrl;
  }
  return `${(baseUrl ?? '').replace(/\/+$/, '')}/${rawUrl.replace(/^\/+/, '')}`;
}

/**
 * A runner that drives a plain HTTP API. Each step's `action` is a command:
 *
 * - `request`        — `target` is "METHOD url-or-path" (e.g. "GET /users"), `value` is an optional JSON body
 * - `setHeader`      — set a header for every later request in this test
 * - `expectStatus`   — assert the last response status equals `value`
 * - `expectStatusIn` — assert the status is one of `value` (a list, or "4xx")
 * - `expectBody`     — assert the last response body contains the text `value`
 * - `expectSchema`   — validate the last JSON body against the schema in `value`
 *
 * @public
 */
export function createHttpRunner(name = 'http', options: HttpRunnerOptions = {}): Runner {
  let lastStatus: number | undefined;
  let lastBody = '';
  let lastUrl = '';
  const extraHeaders: Record<string, string> = {};

  /**
   * Expand `${VAR}` from the run environment. A test case can then name the
   * variable holding a token instead of carrying the token itself — the file is
   * committed, the credential is not.
   */
  const expand = (value: string, env: Record<string, string>): string =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
      return env[name] ?? process.env[name] ?? whole;
    });

  return {
    kind: 'runner',
    name,
    type: 'http',
    runStep: async (ctx: RunContext): Promise<StepResult> => {
      const start = Date.now();
      const step = ctx.step;
      const action = step?.action;
      try {
        switch (action) {
          case 'request': {
            const spec =
              typeof step?.target === 'string' ? step.target : `GET ${text(step?.value)}`;
            const spaceIdx = spec.indexOf(' ');
            const method = (spaceIdx === -1 ? 'GET' : spec.slice(0, spaceIdx)).toUpperCase();
            const rawUrl = spaceIdx === -1 ? spec : spec.slice(spaceIdx + 1);
            const url = resolveUrl(rawUrl.trim(), options.baseUrl);
            const headers: Record<string, string> = {
              'content-type': 'application/json',
              ...extraHeaders,
            };
            const body = step?.value === undefined ? undefined : JSON.stringify(step.value);
            const response = await fetch(url, { method, headers, body, signal: ctx.signal });
            lastStatus = response.status;
            lastBody = await response.text();
            lastUrl = `${method} ${url}`;
            return {
              status: 'pass',
              durationMs: Date.now() - start,
              output: `${method} ${url} -> ${String(lastStatus)}`,
            };
          }
          case 'setHeader': {
            const name = typeof step?.target === 'string' ? step.target : '';
            if (name === '') {
              throw new Error('setHeader needs a header name in target');
            }
            extraHeaders[name.toLowerCase()] = expand(text(step?.value), ctx.env);
            // The value may be a credential, so the output names the header only.
            return { status: 'pass', durationMs: Date.now() - start, output: `set ${name}` };
          }
          case 'expectStatusIn': {
            const raw = step?.value;
            const allowed = Array.isArray(raw) ? raw.map(String) : [text(raw)];
            const actual = String(lastStatus ?? '');
            const matches = allowed.some((a) =>
              a.toLowerCase().endsWith('xx') ? actual.startsWith(a[0] ?? '') : a === actual,
            );
            if (!matches) {
              throw new Error(`expected status in [${allowed.join(', ')}] but got ${actual}`);
            }
            return { status: 'pass', durationMs: Date.now() - start, output: `status ${actual}` };
          }
          case 'expectSchema': {
            let parsed: unknown;
            try {
              parsed = JSON.parse(lastBody);
            } catch {
              throw new Error('response body is not JSON, so it cannot match a schema');
            }
            const result = validateAgainst(step?.value, parsed);
            if (!result.ok) {
              throw new Error(
                `response does not match its schema: ${formatAjvErrors(result.errors)}`,
              );
            }
            return {
              status: 'pass',
              durationMs: Date.now() - start,
              output: 'response matches its schema',
            };
          }
          case 'expectStatus': {
            const expected = Number(step?.value);
            if (lastStatus !== expected) {
              throw new Error(`expected status ${String(expected)} but got ${String(lastStatus)}`);
            }
            return {
              status: 'pass',
              durationMs: Date.now() - start,
              output: `status ${String(lastStatus)}`,
            };
          }
          case 'expectBody': {
            const needle = text(step?.value);
            if (!lastBody.includes(needle)) {
              throw new Error(`response body does not contain "${needle}"`);
            }
            return {
              status: 'pass',
              durationMs: Date.now() - start,
              output: `body contains "${needle}"`,
            };
          }
          default:
            throw new Error(`unknown http action "${String(action)}"`);
        }
      } catch (err) {
        return {
          status: 'fail',
          durationMs: Date.now() - start,
          error: { message: (err as Error).message, code: 'ORCH_STEP_FAILED' },
          evidence: describeLast(),
        };
      }
    },
    // Same contract the browser runner implements: when the engine times the
    // step out, runStep never returns and cannot report anything itself.
    captureFailure: (): Promise<Record<string, unknown> | undefined> =>
      Promise.resolve(describeLast()),
  };

  function describeLast(): Record<string, unknown> | undefined {
    if (lastStatus === undefined) {
      return undefined;
    }
    return {
      request: lastUrl,
      status: lastStatus,
      // Enough of the body to see an error message, not enough to fill a report.
      excerpt: lastBody.slice(0, 300),
      bodyChars: lastBody.length,
    };
  }
}
