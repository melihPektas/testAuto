import { chromium } from 'playwright';

import { endpointOf, isApiCall, recordNetwork } from './network.js';

import type { NetworkCall } from './network.js';

export interface ObservedEndpoint {
  readonly method: string;
  /** Origin + path, with the query string removed. */
  readonly endpoint: string;
  /** A full URL that was actually requested, query string and all. */
  readonly sample: string;
  readonly calls: number;
  /** Statuses seen, most common first. */
  readonly statuses: number[];
  readonly slowestMs: number;
  /** True when every observed call came back 2xx. */
  readonly healthy: boolean;
}

export interface Observation {
  readonly pageUrl: string;
  readonly endpoints: ObservedEndpoint[];
  readonly totalCalls: number;
}

export interface ObserveOptions {
  /** How long to keep watching after the page settles (default 4000ms). */
  readonly settleMs?: number;
  /** Only keep endpoints on these origins; defaults to the page's own origin. */
  readonly origins?: string[];
  readonly headed?: boolean;
}

/** Group raw calls into one entry per method+endpoint. */
export function groupCalls(calls: NetworkCall[], allowed: string[]): ObservedEndpoint[] {
  const groups = new Map<string, NetworkCall[]>();
  for (const call of calls) {
    if (!isApiCall(call)) {
      continue;
    }
    let origin: string;
    try {
      origin = new URL(call.url).origin;
    } catch {
      continue;
    }
    if (allowed.length > 0 && !allowed.includes(origin)) {
      continue;
    }
    const key = `${call.method} ${endpointOf(call.url)}`;
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [call]);
    } else {
      bucket.push(call);
    }
  }

  return [...groups.entries()]
    .map(([key, bucket]) => {
      const [method = 'GET', endpoint = ''] = key.split(' ');
      const statuses = [
        ...new Set(bucket.map((c) => c.status).filter((s): s is number => s !== undefined)),
      ];
      return {
        method,
        endpoint,
        sample: bucket[0]?.url ?? endpoint,
        calls: bucket.length,
        statuses,
        slowestMs: Math.max(...bucket.map((c) => c.durationMs)),
        healthy: statuses.length > 0 && statuses.every((s) => s >= 200 && s < 300),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

/**
 * Open a page and record the API calls it makes. This is what stands in for an
 * OpenAPI document when there is not one: a site that publishes no spec still
 * tells you exactly which endpoints it depends on, simply by loading.
 *
 * @public
 */
export async function observeApiCalls(
  url: string,
  options: ObserveOptions = {},
): Promise<Observation> {
  const browser = await chromium.launch({ headless: options.headed !== true });
  try {
    const page = await browser.newPage();
    const network = recordNetwork(page);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Most data arrives after first paint, so waiting is the whole point.
    await page.waitForTimeout(options.settleMs ?? 4000);

    const allowed = options.origins ?? [new URL(url).origin];
    return {
      pageUrl: url,
      endpoints: groupCalls(network.calls, allowed),
      totalCalls: network.calls.length,
    };
  } finally {
    await browser.close();
  }
}

export interface ObservedTestCase {
  readonly path: string;
  readonly content: string;
  readonly name: string;
  readonly steps: number;
}

export interface ObservedGeneration {
  readonly cases: ObservedTestCase[];
  readonly skipped: { endpoint: string; reason: string }[];
}

function slug(value: string): string {
  return (
    value
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'endpoint'
  );
}

export interface GenerateObservedOptions {
  readonly runner?: string;
}

/**
 * Turn observed endpoints into API test cases.
 *
 * Only endpoints that were observed healthy get a test. An endpoint that
 * returned 500 while we watched is a finding to report, not a baseline to
 * enshrine — writing `expect 500` would lock the bug in as expected behaviour.
 *
 * @public
 */
export function generateTestsFromObservation(
  observation: Observation,
  options: GenerateObservedOptions = {},
): ObservedGeneration {
  const runner = options.runner ?? 'api';
  const cases: ObservedTestCase[] = [];
  const skipped: { endpoint: string; reason: string }[] = [];

  for (const ep of observation.endpoints) {
    const label = `${ep.method} ${ep.endpoint}`;
    if (!ep.healthy) {
      skipped.push({
        endpoint: label,
        reason: `observed returning ${ep.statuses.join('/') || 'no response'} — a finding, not a baseline`,
      });
      continue;
    }
    if (ep.method !== 'GET') {
      skipped.push({
        endpoint: label,
        reason: 'only GET is replayed; anything else may change data',
      });
      continue;
    }

    const steps: unknown[] = [
      { id: 'call', action: 'request', target: `GET ${ep.sample}` },
      { id: 'status', action: 'expectStatusIn', value: ep.statuses },
    ];

    const id = `observed-${slug(`${ep.method}-${ep.endpoint}`)}`;
    cases.push({
      path: `observed/${String(cases.length + 1).padStart(3, '0')}-${id}.test-case.json`,
      content: `${JSON.stringify(
        {
          id,
          version: '1.0',
          name: `${label} → ${ep.statuses.join('/')} (seen ${String(ep.calls)}× loading ${observation.pageUrl})`,
          runner,
          steps,
        },
        null,
        2,
      )}\n`,
      name: label,
      steps: steps.length,
    });
  }

  return { cases, skipped };
}
