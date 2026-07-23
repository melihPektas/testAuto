import { SAFE_METHODS, sampleFor } from './spec.js';

import type { ApiSpec, Operation, Parameter } from './spec.js';

export interface ApiTestCase {
  /** Path relative to the output directory. */
  readonly path: string;
  readonly content: string;
  readonly name: string;
  readonly steps: number;
}

export interface GenerateApiOptions {
  readonly runner?: string;
  /**
   * Include methods that change server state (POST, PUT, PATCH, DELETE).
   *
   * Off by default, and deliberately so: these tests issue real requests. A
   * generator that quietly fires DELETE at whatever host it was pointed at is
   * worse than one that generates nothing.
   */
  readonly includeWrites?: boolean;
  /** Name of an environment variable holding a bearer token. */
  readonly authEnv?: string;
  /** Skip the negative cases (missing required parameter, missing auth). */
  readonly happyPathOnly?: boolean;
}

export interface ApiGeneration {
  readonly cases: ApiTestCase[];
  /** Operations left out, with the reason — usually "changes server state". */
  readonly skipped: { operation: string; reason: string }[];
}

function slug(value: string): string {
  return (
    value
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'op'
  );
}

function opName(op: Operation): string {
  return op.operationId ?? `${op.method}-${slug(op.path)}`;
}

/** Fill path placeholders and append a query string. */
function buildTarget(op: Operation, omit?: Parameter): string {
  let path = op.path;
  for (const p of op.parameters) {
    if (p.in !== 'path' || p === omit) {
      continue;
    }
    path = path.replace(
      `{${p.name}}`,
      encodeURIComponent(String(p.example ?? sampleFor(p.schema, p.name))),
    );
  }

  const query = op.parameters
    .filter((p) => p.in === 'query' && p.required && p !== omit)
    .map(
      (p) =>
        `${encodeURIComponent(p.name)}=${encodeURIComponent(String(p.example ?? sampleFor(p.schema, p.name)))}`,
    )
    .join('&');

  return `${op.method.toUpperCase()} ${path}${query === '' ? '' : `?${query}`}`;
}

function authSteps(authEnv: string | undefined): unknown[] {
  if (authEnv === undefined) {
    return [];
  }
  // The test names the variable; the token stays in the environment.
  return [
    { id: 'auth', action: 'setHeader', target: 'Authorization', value: `Bearer \${${authEnv}}` },
  ];
}

/**
 * Turn a parsed spec into test cases. Everything here is rule-based: an OpenAPI
 * document already states the paths, the methods, the required parameters, the
 * success codes and the response schemas, so asking a model to restate them
 * would only add a way to get them wrong.
 *
 * @public
 */
export function generateApiTests(spec: ApiSpec, options: GenerateApiOptions = {}): ApiGeneration {
  const runner = options.runner ?? 'api';
  const cases: ApiTestCase[] = [];
  const skipped: { operation: string; reason: string }[] = [];
  const auth = authSteps(options.authEnv);

  const push = (id: string, name: string, steps: unknown[]): void => {
    cases.push({
      path: `api/${String(cases.length + 1).padStart(3, '0')}-${id}.test-case.json`,
      content: `${JSON.stringify({ id, version: '1.0', name, runner, steps }, null, 2)}\n`,
      name,
      steps: steps.length,
    });
  };

  for (const op of spec.operations) {
    const safe = (SAFE_METHODS as readonly string[]).includes(op.method);
    const label = `${op.method.toUpperCase()} ${op.path}`;
    if (!safe && options.includeWrites !== true) {
      skipped.push({
        operation: label,
        reason: 'changes server state; pass includeWrites to include it',
      });
      continue;
    }

    const base = opName(op);
    const request: Record<string, unknown> = {
      id: 'call',
      action: 'request',
      target: buildTarget(op),
    };
    if (op.requestBody !== undefined) {
      request['value'] = op.requestBody;
    }

    // 1) The documented happy path.
    const happy: unknown[] = [...auth, request];
    happy.push(
      op.successStatuses.length === 1
        ? { id: 'status', action: 'expectStatus', value: op.successStatuses[0] }
        : { id: 'status', action: 'expectStatusIn', value: op.successStatuses },
    );
    if (op.responseSchema !== undefined) {
      happy.push({ id: 'schema', action: 'expectSchema', value: op.responseSchema });
    }
    push(
      slug(`${base}-ok`),
      `${label} → ${op.successStatuses.join('/')}${op.responseSchema !== undefined ? ' and matches its schema' : ''}`,
      happy,
    );

    if (options.happyPathOnly === true) {
      continue;
    }

    // 2) Drop one required parameter: a documented requirement the server does
    //    not enforce is a real defect, and specs claim them constantly.
    const requiredQuery = op.parameters.find((p) => p.in === 'query' && p.required);
    if (requiredQuery !== undefined) {
      push(
        slug(`${base}-missing-${requiredQuery.name}`),
        `${label} without the required "${requiredQuery.name}" → 4xx`,
        [
          ...auth,
          { id: 'call', action: 'request', target: buildTarget(op, requiredQuery) },
          { id: 'status', action: 'expectStatusIn', value: ['4xx'] },
        ],
      );
    }

    // 3) A secured operation should refuse an unauthenticated call.
    if (op.secured) {
      push(slug(`${base}-unauthorised`), `${label} without credentials → 401/403`, [
        { id: 'call', action: 'request', target: buildTarget(op) },
        { id: 'status', action: 'expectStatusIn', value: [401, 403] },
      ]);
    }
  }

  return { cases, skipped };
}
