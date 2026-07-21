export const testCaseSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://test-orchestrator.io/schemas/test-case.schema.json',
  title: 'TestCase',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      minLength: 1,
    },
    version: { const: '1.0' },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    tags: {
      type: 'array',
      items: { type: 'string' },
    },
    runner: { type: 'string' },
    steps: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/Step' },
    },
    expected: { $ref: '#/$defs/Expected' },
    timeout: { type: 'integer', minimum: 0, default: 30000 },
    retry: { type: 'integer', minimum: 0, default: 0 },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
  required: ['id', 'version', 'name', 'steps'],
  $defs: {
    Step: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        action: { type: 'string', minLength: 1 },
        args: {
          type: 'array',
        },
        target: { type: 'string' },
        value: {},
        description: { type: 'string' },
        timeout: { type: 'integer', minimum: 0 },
        retry: { type: 'integer', minimum: 0 },
      },
      required: ['action'],
    },
    Expected: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['pass', 'fail', 'flaky'],
          default: 'pass',
        },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['code', 'message'],
        },
        assertion: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  },
} as const;

export default testCaseSchema;
