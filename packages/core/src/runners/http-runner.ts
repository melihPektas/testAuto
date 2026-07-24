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
  // Values pulled out of earlier responses, so one request can feed the next —
  // a POST returns an id, a later GET uses it. This is what makes a chain of
  // requests a stateful test rather than a set of independent ones.
  const captured: Record<string, string> = {};

  /**
   * Expand `${VAR}` from captured values first, then the run environment. A
   * test case names the variable holding a token rather than carrying it (the
   * file is committed, the credential is not), and names a captured id rather
   * than hard-coding one that will not exist on the next run.
   */
  const expand = (value: string, env: Record<string, string>): string =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (whole, name: string) => {
      return captured[name] ?? env[name] ?? process.env[name] ?? whole;
    });

  /** Read a dotted path (`data.id`, `items.0.id`) out of a parsed body. */
  const readPath = (body: unknown, path: string): unknown => {
    let node = body;
    for (const key of path.split('.')) {
      if (Array.isArray(node)) {
        node = node[Number(key)];
      } else if (typeof node === 'object' && node !== null) {
        node = (node as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    return node;
  };

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
            const url = resolveUrl(expand(rawUrl.trim(), ctx.env), options.baseUrl);
            const headers: Record<string, string> = {
              'content-type': 'application/json',
              ...extraHeaders,
            };
            // Expand ${...} inside the body too, so a chained request can post a
            // value it captured from an earlier response.
            const body =
              step?.value === undefined ? undefined : expand(JSON.stringify(step.value), ctx.env);
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
          case 'capture': {
            // target = "var = path", or target = "path" with the name in value.
            const spec = typeof step?.target === 'string' ? step.target : '';
            const eq = spec.indexOf('=');
            const varName = (eq === -1 ? text(step?.value) : spec.slice(0, eq)).trim();
            const path = (eq === -1 ? spec : spec.slice(eq + 1)).trim();
            if (varName === '' || path === '') {
              throw new Error('capture needs "name = path" (e.g. "id = id")');
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(lastBody);
            } catch {
              throw new Error('cannot capture: the last response was not JSON');
            }
            const found = readPath(parsed, path);
            if (found === undefined || found === null) {
              throw new Error(`nothing to capture at "${path}" in the response`);
            }
            captured[varName] = typeof found === 'string' ? found : JSON.stringify(found);
            return {
              status: 'pass',
              durationMs: Date.now() - start,
              output: `captured ${varName} = ${captured[varName]}`,
            };
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
          case 'expectResponseSchema': {
            // The spec documents a schema per status. Pick the one that matches
            // what actually came back — exact code, then family, then default —
            // so a 404 is checked against the 404 schema, not the 200 one.
            const map = (step?.value ?? {}) as Record<string, unknown>;
            const code = String(lastStatus ?? '');
            const schema = map[code] ?? map[`${code.slice(0, 1)}xx`] ?? map['default'];
            if (schema === undefined) {
              // Nothing promised for this status, so nothing to hold it to.
              return {
                status: 'pass',
                durationMs: Date.now() - start,
                output: `no schema declared for ${code}`,
              };
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(lastBody);
            } catch {
              throw new Error(`response for ${code} is not JSON, but the spec declares a schema`);
            }
            const result = validateAgainst(schema, parsed);
            if (!result.ok) {
              throw new Error(
                `the ${code} response does not match its declared schema: ${formatAjvErrors(result.errors)}`,
              );
            }
            return {
              status: 'pass',
              durationMs: Date.now() - start,
              output: `${code} matches its declared schema`,
            };
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
