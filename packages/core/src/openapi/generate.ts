import { mutationsFor, mutateBody } from './fuzz.js';
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
  /**
   * Also generate schema-derived invalid inputs. Each asserts only that the
   * server does not return 5xx: accepting bad input (2xx) or rejecting it (4xx)
   * are both defensible, but crashing on it is not. That is what makes this
   * check free of false positives.
   */
  readonly fuzz?: boolean;
  /** Cap the fuzz cases generated per operation (default 6). */
  readonly maxFuzzPerOperation?: number;
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

    // 3b) Schema-derived invalid inputs. The only assertion is "do not 5xx":
    //     a server may reasonably accept or reject bad input, but it must not
    //     fall over, and that is a real defect whenever it happens.
    if (options.fuzz === true) {
      let made = 0;
      const cap = options.maxFuzzPerOperation ?? 6;

      for (const p of op.parameters) {
        if (made >= cap || (p.in !== 'query' && p.in !== 'path')) {
          continue;
        }
        for (const mutation of mutationsFor(p.schema, p.name)) {
          if (made >= cap) {
            break;
          }
          made += 1;
          const target = buildTarget(op).replace(
            new RegExp(`([?&]${p.name}=)[^&]*`),
            `$1${encodeURIComponent(String(mutation.value))}`,
          );
          push(
            slug(`${base}-fuzz-${mutation.label}`),
            `${label} with ${mutation.label} → must not 5xx`,
            [
              ...auth,
              { id: 'call', action: 'request', target },
              { id: 'alive', action: 'expectStatusIn', value: ['2xx', '4xx'] },
            ],
          );
        }
      }

      // Body fields, one at a time, so a failure names one field.
      const body = op.requestBody;
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        for (const [key, current] of Object.entries(body)) {
          if (made >= cap) {
            break;
          }
          const guessed = typeof current === 'number' ? { type: 'number' } : { type: 'string' };
          const mutation = mutationsFor(guessed, key)[0];
          if (mutation === undefined) {
            continue;
          }
          made += 1;
          push(slug(`${base}-fuzz-body-${key}`), `${label} with ${mutation.label} → must not 5xx`, [
            ...auth,
            {
              id: 'call',
              action: 'request',
              target: buildTarget(op),
              value: mutateBody(body, key, mutation.value),
            },
            { id: 'alive', action: 'expectStatusIn', value: ['2xx', '4xx'] },
          ]);
        }
      }
    }

    // 3) A secured operation should refuse an unauthenticated call.
    if (op.secured) {
      push(slug(`${base}-unauthorised`), `${label} without credentials → 401/403`, [
        { id: 'call', action: 'request', target: buildTarget(op) },
        { id: 'status', action: 'expectStatusIn', value: [401, 403] },
      ]);
    }
  }

  // 4) Stateful chains: a resource you POST and then GET is only really tested
  //    end to end, with the created id carried across. This is where an id that
  //    "does not exist until the POST returns it" comes from.
  if (options.includeWrites === true) {
    for (const chain of resourceChains(spec.operations)) {
      push(slug(`${opName(chain.create)}-lifecycle`), `${chain.label} lifecycle`, [
        ...auth,
        {
          id: 'create',
          action: 'request',
          target: buildTarget(chain.create),
          value: chain.create.requestBody ?? {},
        },
        { id: 'created', action: 'expectStatusIn', value: chain.create.successStatuses },
        { id: 'grab', action: 'capture', target: `${chain.idField} = ${chain.idField}` },
        {
          id: 'read',
          action: 'request',
          target: `GET ${chain.itemPath.replace(`{${chain.pathParam}}`, `\${${chain.idField}}`)}`,
        },
        { id: 'read-ok', action: 'expectStatus', value: 200 },
        ...(chain.remove !== undefined
          ? [
              {
                id: 'remove',
                action: 'request',
                target: `DELETE ${chain.itemPath.replace(`{${chain.pathParam}}`, `\${${chain.idField}}`)}`,
              },
              { id: 'removed', action: 'expectStatusIn', value: chain.remove.successStatuses },
            ]
          : []),
      ]);
    }
  }

  return { cases, skipped };
}

interface ResourceChain {
  readonly label: string;
  readonly create: Operation;
  readonly read: Operation;
  readonly remove: Operation | undefined;
  readonly itemPath: string;
  readonly pathParam: string;
  /** The field on the created resource that names it (usually `id`). */
  readonly idField: string;
}

/**
 * Pair `POST /things` with `GET /things/{id}` (and `DELETE` when present) so a
 * created resource can be read back through the id the create returned. The
 * pairing is by path shape, which is how a spec expresses the relationship even
 * when it does not spell it out.
 */
function resourceChains(operations: Operation[]): ResourceChain[] {
  const chains: ResourceChain[] = [];
  for (const read of operations) {
    if (read.method !== 'get') {
      continue;
    }
    const match = /^(.*)\/\{([^/}]+)\}$/.exec(read.path);
    if (match === null) {
      continue;
    }
    const collection = match[1] ?? '';
    const pathParam = match[2] ?? 'id';
    const create = operations.find((o) => o.method === 'post' && o.path === collection);
    if (create === undefined) {
      continue;
    }
    const remove = operations.find((o) => o.method === 'delete' && o.path === read.path);
    chains.push({
      label: `${collection} (create → read${remove !== undefined ? ' → delete' : ''})`,
      create,
      read,
      remove,
      itemPath: read.path,
      pathParam,
      idField: pathParam,
    });
  }
  return chains;
}
