import type { Page, Request } from 'playwright';

export interface NetworkCall {
  readonly method: string;
  readonly url: string;
  /** Undefined when the request never got a response. */
  readonly status: number | undefined;
  readonly durationMs: number;
  readonly resourceType: string;
  /** True when the request failed outright (DNS, abort, connection reset). */
  readonly failed: boolean;
  readonly failure: string | undefined;
}

/**
 * The resource types that carry data rather than presentation. Watching a page
 * fetch its own stylesheet tells nobody anything; watching it fetch its
 * products tells you whether the backend is holding up.
 */
export const API_RESOURCE_TYPES = ['xhr', 'fetch'] as const;

export const isApiCall = (call: NetworkCall): boolean =>
  (API_RESOURCE_TYPES as readonly string[]).includes(call.resourceType);

/** Strip the query string, so repeated calls to one endpoint group together. */
export function endpointOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function durationOf(request: Request): number {
  try {
    const timing = request.timing();
    const end = timing.responseEnd;
    return end > 0 ? Math.round(end) : 0;
  } catch {
    return 0;
  }
}

export interface NetworkRecorder {
  /** Everything seen since the last reset. */
  readonly calls: NetworkCall[];
  reset(): void;
}

/**
 * Watch a page's network traffic. A UI test asserts what the page *showed*, but
 * a page showing a cached list while its API returns 500 is still broken, and
 * nothing on screen says so.
 *
 * @public
 */
export function recordNetwork(page: Page): NetworkRecorder {
  const calls: NetworkCall[] = [];

  const record = (
    request: Request,
    status: number | undefined,
    failure: string | undefined,
  ): void => {
    // Bound the list: a long-running page can make thousands of requests, and
    // no assertion needs more than a working sample.
    if (calls.length >= 500) {
      return;
    }
    calls.push({
      method: request.method(),
      url: request.url(),
      status,
      durationMs: durationOf(request),
      resourceType: request.resourceType(),
      failed: failure !== undefined,
      failure,
    });
  };

  // The status is taken from the `response` event rather than by awaiting
  // `request.response()`: awaiting defers the record past the assertion that
  // wanted it, which made `expectNoFailedRequests` silently miss a 500.
  const statuses = new WeakMap<Request, number>();
  page.on('response', (response) => {
    statuses.set(response.request(), response.status());
  });

  page.on('requestfinished', (request) => {
    record(request, statuses.get(request), undefined);
  });

  page.on('requestfailed', (request) => {
    record(request, undefined, request.failure()?.errorText ?? 'request failed');
  });

  return {
    calls,
    reset: (): void => {
      calls.length = 0;
    },
  };
}

export interface NetworkSummary {
  readonly total: number;
  readonly apiCalls: number;
  /** Calls that failed outright or came back 4xx/5xx. */
  readonly broken: NetworkCall[];
  /** The slowest API call, if there was one. */
  readonly slowest: NetworkCall | undefined;
  /** Endpoints called more than once, worst first — the N+1 smell. */
  readonly repeated: { endpoint: string; count: number }[];
}

/** @public */
export function summariseNetwork(calls: NetworkCall[]): NetworkSummary {
  const api = calls.filter(isApiCall);
  const counts = new Map<string, number>();
  for (const call of api) {
    const key = `${call.method} ${endpointOf(call.url)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    total: calls.length,
    apiCalls: api.length,
    broken: api.filter((c) => c.failed || (c.status !== undefined && c.status >= 400)),
    slowest: [...api].sort((a, b) => b.durationMs - a.durationMs)[0],
    repeated: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([endpoint, count]) => ({ endpoint, count }))
      .sort((a, b) => b.count - a.count),
  };
}
