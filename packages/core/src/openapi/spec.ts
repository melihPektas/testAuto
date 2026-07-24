import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';

/** The HTTP methods that cannot change anything on the server. */
export const SAFE_METHODS = ['get', 'head', 'options'] as const;

export interface Parameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header' | 'cookie';
  readonly required: boolean;
  readonly schema: unknown;
  readonly example?: unknown;
}

export interface Operation {
  readonly method: string;
  readonly path: string;
  readonly operationId: string | undefined;
  readonly summary: string | undefined;
  readonly parameters: Parameter[];
  /** Declared success status codes, e.g. [200, 201]. */
  readonly successStatuses: number[];
  /** JSON schema for the first documented success response, if any. */
  readonly responseSchema: unknown;
  /** Example or schema-derived body for a request that needs one. */
  readonly requestBody: unknown;
  /** The request body's JSON schema, when it declares one — used for fuzzing. */
  readonly requestBodySchema: unknown;
  readonly requestBodyRequired: boolean;
  /** Whether the operation declares any security requirement. */
  readonly secured: boolean;
}

export interface ApiSpec {
  readonly title: string;
  readonly version: string;
  /** First declared server URL, if the spec names one. */
  readonly serverUrl: string | undefined;
  readonly operations: Operation[];
}

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Follow a local `$ref` such as `#/components/schemas/Product`. */
function deref(node: unknown, root: Dict, seen = new Set<string>()): unknown {
  if (!isDict(node)) {
    return node;
  }
  const ref = node['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    if (seen.has(ref)) {
      // A schema that references itself is legal; expanding it forever is not.
      return {};
    }
    seen.add(ref);
    let target: unknown = root;
    for (const part of ref.slice(2).split('/')) {
      target = isDict(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    }
    return deref(target, root, seen);
  }
  return node;
}

/** Expand every `$ref` inside a schema so a validator never sees one. */
function resolveSchema(node: unknown, root: Dict, depth = 0): unknown {
  if (depth > 12 || node === undefined) {
    return {};
  }
  const resolved = deref(node, root);
  if (Array.isArray(resolved)) {
    return resolved.map((item) => resolveSchema(item, root, depth + 1));
  }
  if (!isDict(resolved)) {
    return resolved;
  }
  const resolveProperties = (value: Dict): Dict =>
    Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveSchema(v, root, depth + 1)]),
    );

  const out: Dict = {};
  for (const [key, value] of Object.entries(resolved)) {
    out[key] =
      key === 'properties' && isDict(value)
        ? resolveProperties(value)
        : resolveSchema(value, root, depth + 1);
  }
  return out;
}

/**
 * A plausible value for a parameter or property, taken from the spec where it
 * says one and derived from the declared type otherwise.
 */
export function sampleFor(schema: unknown, name = ''): unknown {
  const s = isDict(schema) ? schema : {};
  if (s['example'] !== undefined) {
    return s['example'];
  }
  if (Array.isArray(s['enum']) && s['enum'].length > 0) {
    return s['enum'][0];
  }
  if (s['default'] !== undefined) {
    return s['default'];
  }
  const type = typeof s['type'] === 'string' ? s['type'] : 'string';
  switch (type) {
    case 'integer':
    case 'number':
      return typeof s['minimum'] === 'number' ? s['minimum'] : 1;
    case 'boolean':
      return true;
    case 'array':
      return [sampleFor(s['items'], name)];
    case 'object': {
      const props = isDict(s['properties']) ? s['properties'] : {};
      const required = Array.isArray(s['required'])
        ? s['required'].map(String)
        : Object.keys(props);
      return Object.fromEntries(
        required
          .filter((key) => props[key] !== undefined)
          .map((key) => [key, sampleFor(props[key], key)]),
      );
    }
    default: {
      const format = typeof s['format'] === 'string' ? s['format'] : '';
      if (format === 'date-time') return '2024-01-01T00:00:00Z';
      if (format === 'date') return '2024-01-01';
      if (format === 'email' || /mail/i.test(name)) return 'test@example.com';
      if (format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (format === 'uri' || format === 'url') return 'https://example.com';
      return /id$/i.test(name) ? '1' : 'test';
    }
  }
}

function collectParameters(raw: unknown, root: Dict): Parameter[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Parameter[] = [];
  for (const entry of raw) {
    const p = deref(entry, root);
    if (!isDict(p) || typeof p['name'] !== 'string' || typeof p['in'] !== 'string') {
      continue;
    }
    const where = p['in'];
    if (where !== 'path' && where !== 'query' && where !== 'header' && where !== 'cookie') {
      continue;
    }
    out.push({
      name: p['name'],
      in: where,
      // A path parameter is always required, whatever the spec says.
      required: where === 'path' || p['required'] === true,
      schema: resolveSchema(p['schema'] ?? {}, root),
      ...(p['example'] !== undefined ? { example: p['example'] } : {}),
    });
  }
  return out;
}

function jsonContent(node: unknown, root: Dict): unknown {
  const resolved = deref(node, root);
  if (!isDict(resolved)) {
    return undefined;
  }
  const content = deref(resolved['content'], root);
  if (!isDict(content)) {
    return undefined;
  }
  const key = Object.keys(content).find((k) => k.includes('json'));
  if (key === undefined) {
    return undefined;
  }
  const media = deref(content[key], root);
  return isDict(media) ? media : undefined;
}

/**
 * Read an OpenAPI/Swagger document into the handful of facts a test generator
 * needs. Only local `$ref`s are followed — a spec that points at another file
 * or a remote document is not fetched.
 *
 * @public
 */
export function parseSpec(document: unknown): ApiSpec {
  const root = isDict(document) ? document : {};
  const info = isDict(root['info']) ? root['info'] : {};
  const servers: unknown[] = Array.isArray(root['servers']) ? (root['servers'] as unknown[]) : [];
  const firstServer = servers.find((s) => isDict(s) && typeof s['url'] === 'string');
  const paths = isDict(root['paths']) ? root['paths'] : {};
  const operations: Operation[] = [];

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(rawItem, root);
    if (!isDict(item)) {
      continue;
    }
    const shared = collectParameters(item['parameters'], root);

    for (const [method, rawOp] of Object.entries(item)) {
      if (!/^(get|put|post|delete|patch|head|options)$/i.test(method)) {
        continue;
      }
      const op = deref(rawOp, root);
      if (!isDict(op)) {
        continue;
      }

      const responses = isDict(op['responses']) ? op['responses'] : {};
      const successStatuses = Object.keys(responses)
        .map((code) => Number.parseInt(code, 10))
        .filter((code) => Number.isFinite(code) && code >= 200 && code < 300)
        .sort((a, b) => a - b);

      const successKey = Object.keys(responses).find((c) => /^2\d\d$/.test(c));
      const successMedia =
        successKey === undefined ? undefined : jsonContent(responses[successKey], root);
      const responseSchema = isDict(successMedia)
        ? resolveSchema(successMedia['schema'], root)
        : undefined;

      const bodyNode = deref(op['requestBody'], root);
      const bodyMedia = jsonContent(bodyNode, root);
      const bodySchema = isDict(bodyMedia) ? resolveSchema(bodyMedia['schema'], root) : undefined;
      const bodyExample = isDict(bodyMedia) ? bodyMedia['example'] : undefined;

      const security = op['security'] ?? root['security'];

      operations.push({
        method: method.toLowerCase(),
        path,
        operationId: typeof op['operationId'] === 'string' ? op['operationId'] : undefined,
        summary: typeof op['summary'] === 'string' ? op['summary'] : undefined,
        parameters: [...shared, ...collectParameters(op['parameters'], root)],
        successStatuses: successStatuses.length > 0 ? successStatuses : [200],
        responseSchema,
        requestBody: bodyExample ?? (bodySchema === undefined ? undefined : sampleFor(bodySchema)),
        requestBodySchema: bodySchema,
        requestBodyRequired: isDict(bodyNode) && bodyNode['required'] === true,
        secured: Array.isArray(security) && security.length > 0,
      });
    }
  }

  return {
    title: typeof info['title'] === 'string' ? info['title'] : 'API',
    version: typeof info['version'] === 'string' ? info['version'] : '',
    serverUrl:
      isDict(firstServer) && typeof firstServer['url'] === 'string'
        ? firstServer['url']
        : undefined,
    operations,
  };
}

async function fetchSpec(url: string): Promise<string> {
  const response = await fetch(url, { headers: { accept: 'application/json, text/yaml' } });
  if (!response.ok) {
    throw new Error(`could not fetch the spec: HTTP ${String(response.status)}`);
  }
  return response.text();
}

/**
 * Load a spec from a URL or a local path. JSON and YAML are both accepted —
 * `/v3/api-docs` tends to serve JSON, a checked-in `openapi.yaml` does not.
 *
 * @public
 */
export async function loadSpec(source: string): Promise<ApiSpec> {
  const raw = /^https?:\/\//.test(source)
    ? await fetchSpec(source)
    : await readFile(source, 'utf8');

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    try {
      document = parseYaml(raw);
    } catch (err) {
      throw new Error(`the spec is neither JSON nor YAML: ${(err as Error).message}`);
    }
  }
  return parseSpec(document);
}
