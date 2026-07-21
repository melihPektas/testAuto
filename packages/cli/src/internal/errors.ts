export type OrchestratorErrorCode =
  | 'ORCH_CONFIG_LOAD'
  | 'ORCH_CONFIG_NOT_FOUND'
  | 'ORCH_CONFIG_INVALID'
  | 'ORCH_TEST_CASE_INVALID'
  | 'ORCH_GENERATOR_NOT_FOUND'
  | 'ORCH_FILE_EXISTS'
  | 'ORCH_RUNNER_NOT_FOUND'
  | 'ORCH_PLUGIN_NOT_FOUND'
  | 'ORCH_PLUGIN_ALREADY_EXISTS'
  | 'ORCH_UNKNOWN';

export interface OrchestratorErrorOptions {
  code: OrchestratorErrorCode;
  cause?: unknown;
}

export class OrchestratorError extends Error {
  public readonly code: OrchestratorErrorCode;
  public override readonly cause?: unknown;

  public constructor(message: string, options: OrchestratorErrorOptions) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = options.code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
