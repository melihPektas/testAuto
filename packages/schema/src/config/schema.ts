export const configSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://test-orchestrator.io/schemas/config.schema.json',
  title: 'TestOrchestratorConfig',
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { const: '1.0' },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    tags: {
      type: 'array',
      items: { type: 'string' },
    },
    runners: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/RunnerConfig' },
    },
    generators: {
      type: 'array',
      items: { $ref: '#/$defs/GeneratorConfig' },
    },
    reporters: {
      type: 'array',
      items: { $ref: '#/$defs/ReporterConfig' },
    },
    plugins: {
      type: 'array',
      items: { $ref: '#/$defs/PluginConfig' },
    },
    hooks: { $ref: '#/$defs/HooksConfig' },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    defaults: { $ref: '#/$defs/DefaultsConfig' },
    llm: { $ref: '#/$defs/LlmConfig' },
    logLevel: {
      type: 'string',
      enum: ['debug', 'info', 'warn', 'error', 'silent'],
      default: 'info',
    },
  },
  required: ['version', 'name', 'runners'],
  $defs: {
    RunnerConfig: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { type: 'string', minLength: 1 },
        options: {
          type: 'object',
          additionalProperties: true,
        },
        enabled: { type: 'boolean', default: true },
      },
      required: ['name', 'type'],
    },
    GeneratorConfig: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { type: 'string', minLength: 1 },
        output: { type: 'string' },
        options: {
          type: 'object',
          additionalProperties: true,
        },
      },
      required: ['name', 'type', 'output'],
    },
    ReporterConfig: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { type: 'string', minLength: 1 },
        output: { type: 'string' },
        options: {
          type: 'object',
          additionalProperties: true,
        },
      },
      required: ['name', 'type'],
    },
    PluginConfig: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
        options: {
          type: 'object',
          additionalProperties: true,
        },
        enabled: { type: 'boolean', default: true },
      },
      required: ['name', 'path'],
    },
    HooksConfig: {
      type: 'object',
      additionalProperties: false,
      properties: {
        beforeAll: { type: 'string' },
        afterAll: { type: 'string' },
        beforeEach: { type: 'string' },
        afterEach: { type: 'string' },
      },
    },
    LlmRoleConfig: {
      type: 'object',
      additionalProperties: false,
      properties: {
        baseUrl: { type: 'string' },
        model: { type: 'string' },
        // The NAME of an environment variable, never a key. A config file is
        // committed; a credential in one is a leak waiting to happen.
        apiKeyEnv: { type: 'string' },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
    },
    LlmConfig: {
      type: 'object',
      additionalProperties: false,
      properties: {
        baseUrl: { type: 'string' },
        model: { type: 'string' },
        apiKeyEnv: { type: 'string' },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        timeoutMs: { type: 'integer', minimum: 1 },
        roles: {
          type: 'object',
          additionalProperties: false,
          properties: {
            author: { $ref: '#/$defs/LlmRoleConfig' },
            matrix: { $ref: '#/$defs/LlmRoleConfig' },
            triage: { $ref: '#/$defs/LlmRoleConfig' },
            repair: { $ref: '#/$defs/LlmRoleConfig' },
          },
        },
      },
    },
    DefaultsConfig: {
      type: 'object',
      additionalProperties: false,
      properties: {
        runner: { type: 'string' },
        reporter: { type: 'string' },
        generator: { type: 'string' },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        retry: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const;

export default configSchema;
