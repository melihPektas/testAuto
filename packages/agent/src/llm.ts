export interface LlmOptions {
  /** OpenAI-compatible base URL (e.g. an Ollama server's `/v1`). */
  readonly baseUrl?: string;
  /** Model id, e.g. `qwen3:14b`. */
  readonly model?: string;
  /** Optional bearer token for hosted providers. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  /**
   * Ask the endpoint to constrain the reply to a JSON object. Models drift into
   * prose when the page content is chatty or not in English; this stops that at
   * the source rather than hoping the prompt holds.
   */
  readonly json?: boolean;
}

export interface ResolvedLlm {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
  readonly temperature: number;
}

/**
 * Resolve LLM settings from explicit options, then environment, then defaults.
 *
 * - `TEST_ORCHESTRATOR_LLM_URL`   (default `http://localhost:11434/v1`)
 * - `TEST_ORCHESTRATOR_LLM_MODEL` (default `qwen2.5-coder:14b`)
 *
 * The default is a non-reasoning coder model on purpose: authoring is pure JSON
 * generation, and a reasoning model spends most of its time on thinking tokens
 * nobody reads (measured on the same box: 28.7s vs 6.5s for one small reply).
 * - `TEST_ORCHESTRATOR_LLM_KEY`   (optional)
 *
 * @public
 */
export function resolveLlm(options: LlmOptions = {}): ResolvedLlm {
  const env = process.env;
  return {
    baseUrl: options.baseUrl ?? env['TEST_ORCHESTRATOR_LLM_URL'] ?? 'http://localhost:11434/v1',
    model: options.model ?? env['TEST_ORCHESTRATOR_LLM_MODEL'] ?? 'qwen2.5-coder:14b',
    apiKey: options.apiKey ?? env['TEST_ORCHESTRATOR_LLM_KEY'],
    timeoutMs: options.timeoutMs ?? 300_000,
    temperature: options.temperature ?? 0.2,
  };
}

/**
 * Send a single-shot chat completion to an OpenAI-compatible endpoint and
 * return the assistant's text.
 *
 * @public
 */
export async function chat(
  system: string,
  user: string,
  options: LlmOptions = {},
): Promise<string> {
  const llm = resolveLlm(options);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (llm.apiKey !== undefined) {
    headers['authorization'] = `Bearer ${llm.apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, llm.timeoutMs);

  try {
    const response = await fetch(`${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: llm.model,
        temperature: llm.temperature,
        stream: false,
        ...(options.json === true ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`LLM responded with HTTP ${String(response.status)}`);
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return payload.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the first JSON array or object out of a model response, tolerating
 * ```json fences, chat preambles and trailing commentary.
 *
 * @public
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.search(/[[{]/);
  if (start === -1) {
    throw new Error('no JSON found in the model response');
  }
  const open = candidate[start];
  const close = open === '[' ? ']' : '}';
  const end = candidate.lastIndexOf(close);
  if (end <= start) {
    throw new Error('no complete JSON value in the model response');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
