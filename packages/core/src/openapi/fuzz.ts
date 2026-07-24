type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Mutation {
  /** Short description of what was broken, used in the test name. */
  readonly label: string;
  readonly value: unknown;
}

/**
 * Deterministic invalid values derived from a schema — the wrong type, a value
 * outside a declared bound, something outside an enum, a malformed format.
 *
 * Property-based tools generate these randomly; deriving them from the schema
 * instead keeps a generated suite reproducible, which matters when the suite is
 * committed and re-run rather than regenerated each time.
 *
 * @public
 */
export function mutationsFor(schema: unknown, name = ''): Mutation[] {
  const s = isDict(schema) ? schema : {};
  const type = typeof s['type'] === 'string' ? s['type'] : 'string';
  const out: Mutation[] = [];

  if (Array.isArray(s['enum']) && s['enum'].length > 0) {
    out.push({ label: `${name || 'value'} outside its enum`, value: '__not_in_enum__' });
  }

  switch (type) {
    case 'integer':
    case 'number': {
      out.push({ label: `${name || 'value'} as a string`, value: 'not-a-number' });
      if (typeof s['minimum'] === 'number') {
        out.push({ label: `${name || 'value'} below minimum`, value: s['minimum'] - 1 });
      }
      if (typeof s['maximum'] === 'number') {
        out.push({ label: `${name || 'value'} above maximum`, value: s['maximum'] + 1 });
      }
      if (type === 'integer') {
        out.push({ label: `${name || 'value'} as a fraction`, value: 1.5 });
      }
      break;
    }
    case 'boolean':
      out.push({ label: `${name || 'value'} as a string`, value: 'maybe' });
      break;
    case 'array':
      out.push({ label: `${name || 'value'} as an object`, value: { not: 'an array' } });
      break;
    case 'object':
      out.push({ label: `${name || 'value'} as an array`, value: ['not', 'an', 'object'] });
      break;
    default: {
      // string
      out.push({ label: `${name || 'value'} as a number`, value: 12345 });
      const format = typeof s['format'] === 'string' ? s['format'] : '';
      if (format !== '') {
        out.push({
          label: `${name || 'value'} with a malformed ${format}`,
          value: '!!not-valid!!',
        });
      }
      if (typeof s['maxLength'] === 'number') {
        out.push({
          label: `${name || 'value'} longer than maxLength`,
          value: 'x'.repeat(s['maxLength'] + 1),
        });
      }
      // An empty string is the most common unguarded case of all: it is not
      // null, so a null check passes, and then indexing into it throws.
      out.push({ label: `${name || 'value'} empty`, value: '' });
      // A very long string is the classic way to find an unguarded buffer.
      out.push({ label: `${name || 'value'} very long`, value: 'x'.repeat(4096) });
      break;
    }
  }

  return out;
}

/**
 * Replace one property of an object body with a mutated value, leaving the rest
 * valid — so a failure points at one field rather than a wholly invalid payload.
 *
 * @public
 */
export function mutateBody(body: unknown, key: string, value: unknown): unknown {
  if (!isDict(body)) {
    return value;
  }
  return { ...body, [key]: value };
}

/** Drop a required property, to see whether the server enforces its own spec. */
export function omitFromBody(body: unknown, key: string): unknown {
  if (!isDict(body)) {
    return body;
  }
  const copy = { ...body };
  delete copy[key];
  return copy;
}
