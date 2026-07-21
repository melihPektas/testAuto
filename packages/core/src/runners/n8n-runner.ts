import type { Runner, RunContext, StepResult } from '../types.js';

export interface N8nRunnerOptions {
  /** Base URL of the n8n instance, e.g. http://192.168.1.49:5678 */
  readonly baseUrl: string;
  /** Optional n8n API key, sent as the X-N8N-API-KEY header. */
  readonly apiKey?: string;
}

function webhookUrl(baseUrl: string, action: string): string {
  if (action.startsWith('http://') || action.startsWith('https://')) {
    return action;
  }
  const root = baseUrl.replace(/\/+$/, '');
  const path = action.replace(/^\/+/, '');
  return `${root}/webhook/${path}`;
}

/**
 * Runner that treats each step's `action` as an n8n workflow webhook to invoke.
 * The step passes `value` (if any) as the JSON request body; the workflow is
 * considered passing when the webhook responds with a 2xx status.
 *
 * @public
 */
export function createN8nRunner(name: string, options: N8nRunnerOptions): Runner {
  return {
    kind: 'runner',
    name,
    type: 'n8n',
    runStep: async (ctx: RunContext): Promise<StepResult> => {
      const start = Date.now();
      const action = ctx.step?.action;
      if (action === undefined || action.length === 0) {
        return {
          status: 'fail',
          durationMs: 0,
          error: { message: 'no action (n8n webhook) to invoke', code: 'ORCH_STEP_FAILED' },
        };
      }

      const url = webhookUrl(options.baseUrl, action);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.apiKey !== undefined) {
        headers['X-N8N-API-KEY'] = options.apiKey;
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: ctx.step?.value === undefined ? undefined : JSON.stringify(ctx.step.value),
          signal: ctx.signal,
        });
        const output = await response.text();
        const durationMs = Date.now() - start;
        if (response.ok) {
          return { status: 'pass', durationMs, output };
        }
        return {
          status: 'fail',
          durationMs,
          output,
          error: {
            message: `n8n webhook responded with HTTP ${response.status}`,
            code: 'ORCH_STEP_FAILED',
          },
        };
      } catch (err) {
        return {
          status: 'fail',
          durationMs: Date.now() - start,
          error: { message: (err as Error).message, code: 'ORCH_STEP_FAILED' },
        };
      }
    },
  };
}
