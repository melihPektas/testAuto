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
 * - `request`      — `target` is "METHOD url-or-path" (e.g. "GET /users"), `value` is an optional JSON body
 * - `expectStatus` — assert the last response status equals `value`
 * - `expectBody`   — assert the last response body contains the text `value`
 *
 * @public
 */
export function createHttpRunner(name = 'http', options: HttpRunnerOptions = {}): Runner {
  let lastStatus: number | undefined;
  let lastBody = '';

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
            const spec = typeof step?.target === 'string' ? step.target : `GET ${text(step?.value)}`;
            const spaceIdx = spec.indexOf(' ');
            const method = (spaceIdx === -1 ? 'GET' : spec.slice(0, spaceIdx)).toUpperCase();
            const rawUrl = spaceIdx === -1 ? spec : spec.slice(spaceIdx + 1);
            const url = resolveUrl(rawUrl.trim(), options.baseUrl);
            const headers: Record<string, string> = { 'content-type': 'application/json' };
            const body = step?.value === undefined ? undefined : JSON.stringify(step.value);
            const response = await fetch(url, { method, headers, body, signal: ctx.signal });
            lastStatus = response.status;
            lastBody = await response.text();
            return {
              status: 'pass',
              durationMs: Date.now() - start,
              output: `${method} ${url} -> ${String(lastStatus)}`,
            };
          }
          case 'expectStatus': {
            const expected = Number(step?.value);
            if (lastStatus !== expected) {
              throw new Error(`expected status ${String(expected)} but got ${String(lastStatus)}`);
            }
            return { status: 'pass', durationMs: Date.now() - start, output: `status ${String(lastStatus)}` };
          }
          case 'expectBody': {
            const needle = text(step?.value);
            if (!lastBody.includes(needle)) {
              throw new Error(`response body does not contain "${needle}"`);
            }
            return { status: 'pass', durationMs: Date.now() - start, output: `body contains "${needle}"` };
          }
          default:
            throw new Error(`unknown http action "${String(action)}"`);
        }
      } catch (err) {
        return {
          status: 'fail',
          durationMs: Date.now() - start,
          error: { message: (err as Error).message, code: 'ORCH_STEP_FAILED' },
        };
      }
    },
  };
}
