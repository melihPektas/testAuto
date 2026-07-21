export type OrchestratorErrorCode =
  | 'ORCH_CONFIG_INVALID'
  | 'ORCH_CONFIG_LOAD'
  | 'ORCH_SCHEMA_INVALID'
  | 'ORCH_RUNNER_NOT_FOUND'
  | 'ORCH_GENERATOR_NOT_FOUND'
  | 'ORCH_REPORTER_NOT_FOUND'
  | 'ORCH_PLUGIN_NOT_FOUND'
  | 'ORCH_DUPLICATE_REGISTRY_ITEM'
  | 'ORCH_HOOK_ERROR'
  | 'ORCH_RUNTIME_ERROR'
  | 'ORCH_TIMEOUT'
  | 'ORCH_STEP_FAILED';

export interface OrchestratorErrorOptions {
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
}

export class OrchestratorError extends Error {
  public readonly code: OrchestratorErrorCode;
  public override readonly cause?: unknown;
  public readonly context?: Record<string, unknown>;
  public override readonly name = 'OrchestratorError';

  public constructor(
    code: OrchestratorErrorCode,
    message: string,
    options?: OrchestratorErrorOptions,
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.context = options?.context;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class ConfigError extends OrchestratorError {}
export class SchemaError extends OrchestratorError {}
export class RegistryError extends OrchestratorError {}
export class HookError extends OrchestratorError {}
export class RunnerError extends OrchestratorError {}
export class StepError extends OrchestratorError {}
export class TimeoutError extends OrchestratorError {}

export function isOrchestratorError(e: unknown): e is OrchestratorError {
  return e instanceof OrchestratorError;
}

export function toOrchestratorError(e: unknown): OrchestratorError {
  if (isOrchestratorError(e)) return e;
  if (e instanceof Error) {
    return new OrchestratorError('ORCH_RUNTIME_ERROR', e.message, { cause: e });
  }
  return new OrchestratorError('ORCH_RUNTIME_ERROR', `Unknown error: ${String(e)}`, { cause: e });
}
