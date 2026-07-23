import type { LlmOptions } from './llm.js';
import type { LlmConfig, LlmRole, LlmRoleConfig } from '@test-orchestrator/schema';

export type { LlmRole };

/**
 * Per-role defaults. Generation wants variety; judgement wants the same answer
 * twice. A verdict that changes between runs is not a basis for editing files,
 * so triage and repair are pinned to 0.
 */
const ROLE_TEMPERATURE: Record<LlmRole, number> = {
  author: 0.2,
  matrix: 0.2,
  triage: 0,
  repair: 0,
};

function readKey(apiKeyEnv: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (apiKeyEnv === undefined || apiKeyEnv === '') {
    return undefined;
  }
  return env[apiKeyEnv];
}

/**
 * Resolve the options for one role by layering, most specific last:
 *
 * 1. the role's defaults (temperature)
 * 2. the config's shared `llm` settings
 * 3. the config's `llm.roles.<role>` overrides
 * 4. whatever the caller passed explicitly (a CLI flag, say)
 *
 * The key is read from the environment variable the config *names* — the
 * config never holds a credential. Environment variables (`…_LLM_URL`,
 * `…_LLM_MODEL`, `…_LLM_KEY`) still apply underneath, via `resolveLlm`.
 *
 * @public
 */
export function llmOptionsFor(
  role: LlmRole,
  config: LlmConfig | undefined = undefined,
  overrides: LlmOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): LlmOptions {
  const roleConfig: LlmRoleConfig = config?.roles?.[role] ?? {};
  const pick = <K extends keyof LlmRoleConfig>(key: K): LlmRoleConfig[K] =>
    roleConfig[key] ?? config?.[key];

  const apiKey = readKey(roleConfig.apiKeyEnv ?? config?.apiKeyEnv, env);
  const baseUrl = pick('baseUrl');
  const model = pick('model');
  const timeoutMs = pick('timeoutMs');
  const temperature = pick('temperature') ?? ROLE_TEMPERATURE[role];

  return {
    temperature,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    // An explicit flag beats anything a file said.
    ...overrides,
  };
}

export interface ProviderSummary {
  readonly role: LlmRole;
  readonly baseUrl: string;
  readonly model: string;
  readonly hasKey: boolean;
  /** Where the key came from, for a log line that never prints the key. */
  readonly keyFrom: string | undefined;
}

/**
 * Describe what a role will talk to, safe to print. The key itself is never
 * included — only whether one was found and which variable it came from.
 *
 * @public
 */
export function describeProvider(
  role: LlmRole,
  config: LlmConfig | undefined,
  overrides: LlmOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ProviderSummary {
  const options = llmOptionsFor(role, config, overrides, env);
  const keyFrom = config?.roles?.[role]?.apiKeyEnv ?? config?.apiKeyEnv;
  return {
    role,
    baseUrl: options.baseUrl ?? env['TEST_ORCHESTRATOR_LLM_URL'] ?? 'http://localhost:11434/v1',
    model: options.model ?? env['TEST_ORCHESTRATOR_LLM_MODEL'] ?? 'qwen2.5-coder:14b',
    hasKey: options.apiKey !== undefined || env['TEST_ORCHESTRATOR_LLM_KEY'] !== undefined,
    keyFrom: options.apiKey !== undefined ? keyFrom : undefined,
  };
}
