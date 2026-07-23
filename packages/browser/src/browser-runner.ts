import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';

import { captureEvidence } from './evidence.js';
import { endpointOf, isApiCall, recordNetwork, summariseNetwork } from './network.js';
import { compareScreenshots } from './visual.js';

import type { NetworkRecorder } from './network.js';
import type { Runner, RunContext, RunnerFactory, StepResult } from '@test-orchestrator/core';

/** Filesystem-safe slug for a test-case id used in a path. */
function slug(value: string): string {
  return (
    value
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'case'
  );
}

export interface BrowserRunnerOptions {
  /** Base URL prepended to relative `goto` targets. */
  readonly baseUrl?: string;
  /** Launch a headed browser (default: headless). */
  readonly headed?: boolean;
}

/** Stringify a step value safely (never "[object Object]"). */
function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

function resolveUrl(value: string, baseUrl: string | undefined): string {
  if (/^https?:\/\//.test(value)) {
    return value;
  }
  if (baseUrl === undefined) {
    return value;
  }
  return `${baseUrl.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
}

/**
 * A runner that drives a real Chromium browser via Playwright. Each step's
 * `action` is a UI command:
 *
 * - `goto`           — navigate to `value` (a URL, or a path resolved against baseUrl)
 * - `expectStatus`   — assert the last navigation returned HTTP `value`
 * - `expectTitle`    — assert the page title contains `value` (or is non-empty)
 * - `expectSelector` — assert an element matching `target` exists
 * - `expectText`     — assert the page body contains the text `value`
 * - `click`          — click the element matching `target`
 *
 * @public
 */
export function createBrowserRunner(name = 'browser', options: BrowserRunnerOptions = {}): Runner {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let lastResponse: Response | null = null;
  let network: NetworkRecorder | undefined;
  const consoleErrors: string[] = [];

  /** Capture the page for whichever failure path got here first. */
  async function evidenceFor(ctx: RunContext): Promise<Record<string, unknown> | undefined> {
    if (page === undefined) {
      return undefined;
    }
    const index = ctx.testCase.steps.findIndex((s) => s === ctx.step);
    const evidence = await captureEvidence(page, {
      artifactsDir: ctx.workspace.artifacts,
      testCaseId: ctx.testCase.id,
      stepIndex: index === -1 ? 0 : index + 1,
      ...(typeof ctx.step?.target === 'string' ? { target: ctx.step.target } : {}),
    });

    // What the page asked for matters as much as what it showed: a failure
    // sitting next to a 500 from its own API reads very differently.
    const net = summariseNetwork(network?.calls ?? []);
    const failedApiCalls = net.broken
      .slice(0, 5)
      .map((c) => `${c.method} ${endpointOf(c.url)} → ${c.failure ?? String(c.status)}`);

    return {
      ...evidence,
      apiCalls: net.apiCalls,
      ...(failedApiCalls.length > 0 ? { failedApiCalls } : {}),
    };
  }

  /**
   * Network events reach this process out of band and arrive later than the
   * page's own `await fetch(...)` resolves — at the moment a rendered element
   * appears, we may still only know about the first call. Every network
   * assertion therefore waits for the page to go quiet first, bounded, because
   * a page that polls never goes quiet at all.
   */
  async function settleNetwork(target: Page): Promise<void> {
    try {
      await target.waitForLoadState('networkidle', { timeout: 5000 });
    } catch {
      // A page with polling or a websocket never reaches networkidle; assert on
      // what we have rather than failing for a reason nobody asked about.
    }
  }

  async function act(ctx: RunContext): Promise<{ output?: string }> {
    if (page === undefined) {
      throw new Error('browser page not initialised');
    }
    const step = ctx.step;
    const action = step?.action;
    const value = step?.value;
    const target = step?.target;

    switch (action) {
      case 'goto': {
        const url = resolveUrl(text(value ?? target), options.baseUrl);
        lastResponse = await page.goto(url, { waitUntil: 'domcontentloaded' });
        return { output: `navigated to ${url} (${lastResponse?.status() ?? 'no response'})` };
      }
      case 'expectStatus': {
        const expected = Number(value);
        const actual = lastResponse?.status();
        if (actual !== expected) {
          throw new Error(`expected status ${expected} but got ${actual ?? 'none'}`);
        }
        return { output: `status ${actual}` };
      }
      case 'expectTitle': {
        const title = await page.title();
        if (value !== undefined && value !== '') {
          if (!title.includes(text(value))) {
            throw new Error(`title "${title}" does not contain "${text(value)}"`);
          }
        } else if (title.length === 0) {
          throw new Error('page has an empty title');
        }
        return { output: `title "${title}"` };
      }
      case 'expectSelector': {
        const selector = String(target ?? '');
        const el = await page.$(selector);
        if (el === null) {
          throw new Error(`no element matches selector "${selector}"`);
        }
        return { output: `selector "${selector}" found` };
      }
      case 'expectText': {
        const needle = text(value);
        const body = (await page.textContent('body')) ?? '';
        if (!body.includes(needle)) {
          throw new Error(`page does not contain text "${needle}"`);
        }
        return { output: `text "${needle}" found` };
      }
      case 'click': {
        const selector = String(target ?? '');
        await page.click(selector);
        return { output: `clicked "${selector}"` };
      }
      case 'fill': {
        const selector = String(target ?? '');
        const input = text(value);
        await page.fill(selector, input);
        return { output: `filled "${selector}" with "${input}"` };
      }
      case 'select': {
        const selector = String(target ?? '');
        const option = text(value);
        const chosen = await page.selectOption(selector, option);
        return { output: `selected ${JSON.stringify(chosen)} in "${selector}"` };
      }
      case 'check': {
        const selector = String(target ?? '');
        await page.check(selector);
        return { output: `checked "${selector}"` };
      }
      case 'press': {
        const selector = String(target ?? '');
        const key = text(value) === '' ? 'Enter' : text(value);
        await page.press(selector, key);
        return { output: `pressed ${key} on "${selector}"` };
      }
      case 'waitFor': {
        const selector = String(target ?? '');
        const timeout = value === undefined ? 5000 : Number(value);
        await page.waitForSelector(selector, { timeout });
        return { output: `"${selector}" appeared` };
      }
      case 'expectUrl': {
        // Filter and sort controls are usually reflected in the query string,
        // so this is what proves a filter was actually applied.
        const needle = text(value);
        const current = page.url();
        if (!current.includes(needle)) {
          throw new Error(`url "${current}" does not contain "${needle}"`);
        }
        return { output: `url contains "${needle}"` };
      }
      case 'expectMinCount': {
        const selector = String(target ?? '');
        const min = Number(value ?? 1);
        const count = await page.locator(selector).count();
        if (count < min) {
          throw new Error(
            `expected at least ${String(min)} element(s) matching "${selector}" but found ${String(count)}`,
          );
        }
        return { output: `${String(count)} element(s) match "${selector}"` };
      }
      case 'expectNoFailedRequests': {
        await settleNetwork(page);
        // A page can render a cached list while its API returns 500. Nothing on
        // screen says so; the network does.
        const summary = summariseNetwork(network?.calls ?? []);
        if (summary.broken.length > 0) {
          const worst = summary.broken
            .slice(0, 3)
            .map((c) => `${c.method} ${endpointOf(c.url)} → ${c.failure ?? String(c.status)}`)
            .join(' | ');
          throw new Error(`${String(summary.broken.length)} failed API call(s): ${worst}`);
        }
        return { output: `${String(summary.apiCalls)} API call(s), none failed` };
      }
      case 'expectRequestsUnder': {
        await settleNetwork(page);
        const budget = Number(value ?? 2000);
        const summary = summariseNetwork(network?.calls ?? []);
        const slow = (network?.calls ?? []).filter((c) => isApiCall(c) && c.durationMs > budget);
        if (slow.length > 0) {
          const worst = slow
            .slice(0, 3)
            .map((c) => `${endpointOf(c.url)} took ${String(c.durationMs)}ms`)
            .join(' | ');
          throw new Error(`${String(slow.length)} API call(s) over ${String(budget)}ms: ${worst}`);
        }
        const slowest = summary.slowest;
        return {
          output: `slowest API call ${slowest === undefined ? 'n/a' : `${String(slowest.durationMs)}ms`} (budget ${String(budget)}ms)`,
        };
      }
      case 'expectApiCalled': {
        await settleNetwork(page);
        const needle = String(target ?? '');
        const matched = (network?.calls ?? []).filter(
          (c) => isApiCall(c) && c.url.includes(needle),
        );
        if (matched.length === 0) {
          throw new Error(`the page never called an API matching "${needle}"`);
        }
        return { output: `${String(matched.length)} call(s) matched "${needle}"` };
      }
      case 'expectNoConsoleErrors': {
        if (consoleErrors.length > 0) {
          throw new Error(
            `${String(consoleErrors.length)} console error(s): ${consoleErrors.slice(0, 3).join(' | ')}`,
          );
        }
        return { output: 'no console errors' };
      }
      case 'expectNoBrokenImages': {
        const broken = await page.$$eval(
          'img',
          (imgs) => imgs.filter((img) => img.complete && img.naturalWidth === 0).length,
        );
        if (broken > 0) {
          throw new Error(`${String(broken)} broken image(s)`);
        }
        const total = await page.$$eval('img', (imgs) => imgs.length);
        return { output: `${String(total)} image(s), none broken` };
      }
      case 'expectMinLinks': {
        const min = Number(value ?? 1);
        const count = await page.$$eval('a[href]', (as) => as.length);
        if (count < min) {
          throw new Error(`expected at least ${String(min)} links but found ${String(count)}`);
        }
        return { output: `${String(count)} link(s)` };
      }
      case 'expectMeta': {
        const metaEl = await page.$('meta[name="description"]');
        const description = metaEl === null ? null : await metaEl.getAttribute('content');
        if (description === null || description.trim().length === 0) {
          throw new Error('missing or empty <meta name="description">');
        }
        return { output: `meta description present (${String(description.length)} chars)` };
      }
      case 'expectResponsive': {
        await page.setViewportSize({ width: 375, height: 812 });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        await page.setViewportSize({ width: 1280, height: 800 });
        if (overflow > 4) {
          throw new Error(`horizontal overflow of ${String(overflow)}px at 375px width`);
        }
        return { output: 'no horizontal overflow at mobile width' };
      }
      case 'expectScreenshot': {
        // A visual baseline is committed alongside the tests; a diff is a
        // throwaway artifact. So they live in different places on purpose.
        const maxRatio = value === undefined ? 0.001 : Number(value);
        const index = ctx.testCase.steps.findIndex((s) => s === ctx.step);
        // Name the baseline after the target, then the step id, then its
        // position — a stable name survives adding a step before it.
        const rawName =
          typeof target === 'string' && target !== '' ? target : (step?.id ?? String(index + 1));
        const name = rawName.replace(/[^a-z0-9]+/gi, '-');
        const baselineDir = join(ctx.workspace.root, '.baselines', slug(ctx.testCase.id));
        const baselinePath = join(baselineDir, `${name}.png`);

        const shot = await page.screenshot({ fullPage: false });

        let baseline: Buffer | undefined;
        try {
          baseline = await readFile(baselinePath);
        } catch {
          baseline = undefined;
        }

        // First run for this step: record the baseline and pass, but say so —
        // a silently-created baseline is a check that never actually ran.
        if (baseline === undefined) {
          await mkdir(baselineDir, { recursive: true });
          await writeFile(baselinePath, shot);
          return {
            output: `baseline created at ${baselinePath} — commit it; the next run compares against it`,
          };
        }

        const comparison = compareScreenshots(shot, baseline, { pixelThreshold: 0.1 });
        if (comparison.sizeMismatch) {
          throw new Error(
            `screenshot size changed from the baseline (now ${String(comparison.width)}×${String(comparison.height)})`,
          );
        }
        if (comparison.ratio > maxRatio) {
          // Write the current shot and the diff next to the run's artifacts so
          // a human can see what moved.
          const dir = join(ctx.workspace.artifacts, slug(ctx.testCase.id));
          await mkdir(dir, { recursive: true });
          const actualRel = join(slug(ctx.testCase.id), `${name}-actual.png`);
          const diffRel = join(slug(ctx.testCase.id), `${name}-diff.png`);
          await writeFile(join(ctx.workspace.artifacts, actualRel), shot);
          if (comparison.diff !== undefined) {
            await writeFile(join(ctx.workspace.artifacts, diffRel), comparison.diff);
          }
          const pct = (comparison.ratio * 100).toFixed(2);
          const limit = (maxRatio * 100).toFixed(2);
          throw new Error(`${pct}% of pixels changed (limit ${limit}%); see ${diffRel}`);
        }
        return {
          output: `matches baseline within ${(maxRatio * 100).toFixed(2)}% (${String(comparison.diffPixels)} px differ)`,
        };
      }
      case 'audit': {
        const checks: { name: string; ok: boolean; detail: string }[] = [];

        const title = await page.title();
        checks.push({
          name: 'title',
          ok: title.length > 0,
          detail: title.length > 0 ? title : '(empty)',
        });

        const hasBody = (await page.$('body')) !== null;
        checks.push({ name: 'body', ok: hasBody, detail: hasBody ? 'rendered' : 'missing' });

        checks.push({
          name: 'no-console-errors',
          ok: consoleErrors.length === 0,
          detail:
            consoleErrors.length === 0
              ? 'clean'
              : `${String(consoleErrors.length)}: ${consoleErrors.slice(0, 2).join(' | ')}`,
        });

        await settleNetwork(page);
        const net = summariseNetwork(network?.calls ?? []);
        const brokenDetail = net.broken
          .slice(0, 2)
          .map((c) => `${endpointOf(c.url)} → ${c.failure ?? String(c.status)}`)
          .join(' | ');
        checks.push({
          name: 'api-calls',
          ok: net.broken.length === 0,
          detail:
            net.broken.length === 0
              ? `${String(net.apiCalls)} call(s), none failed`
              : `${String(net.broken.length)} failed: ${brokenDetail}`,
        });

        const totalImg = await page.$$eval('img', (imgs) => imgs.length);
        const brokenImg = await page.$$eval(
          'img',
          (imgs) => imgs.filter((img) => img.complete && img.naturalWidth === 0).length,
        );
        checks.push({
          name: 'images',
          ok: brokenImg === 0,
          detail: `${String(totalImg)} total, ${String(brokenImg)} broken`,
        });

        const links = await page.$$eval('a[href]', (as) => as.length);
        checks.push({ name: 'links', ok: links > 0, detail: `${String(links)} links` });

        const metaEl = await page.$('meta[name="description"]');
        const description = metaEl === null ? null : await metaEl.getAttribute('content');
        const hasDesc = description !== null && description.trim().length > 0;
        checks.push({
          name: 'meta-description',
          ok: hasDesc,
          detail: hasDesc ? `${String(description.length)} chars` : 'missing',
        });

        await page.setViewportSize({ width: 375, height: 812 });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        await page.setViewportSize({ width: 1280, height: 800 });
        checks.push({
          name: 'responsive',
          ok: overflow <= 4,
          detail: overflow <= 4 ? 'no overflow @375px' : `${String(overflow)}px overflow @375px`,
        });

        const report = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n');
        const failed = checks.filter((c) => !c.ok);
        if (failed.length > 0) {
          throw new Error(`${String(failed.length)} audit check(s) failed:\n${report}`);
        }
        return { output: `audit passed (${String(checks.length)} checks):\n${report}` };
      }
      default:
        throw new Error(`unknown browser action "${String(action)}"`);
    }
  }

  return {
    kind: 'runner',
    name,
    type: 'browser',
    init: async (): Promise<void> => {
      // The browser process is reused across the tests this runner instance
      // handles; isolation comes from a fresh context per test, which is what
      // actually carries cookies, storage and cache.
      browser ??= await chromium.launch({ headless: options.headed !== true });
      context = await browser.newContext();
      page = await context.newPage();
      lastResponse = null;
      consoleErrors.length = 0;
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });
      page.on('pageerror', (err) => {
        consoleErrors.push(err.message);
      });
      network = recordNetwork(page);
    },
    runStep: async (ctx: RunContext): Promise<StepResult> => {
      const start = Date.now();
      try {
        const { output } = await act(ctx);
        const result: StepResult = { status: 'pass', durationMs: Date.now() - start };
        return output === undefined ? result : { ...result, output };
      } catch (err) {
        const failed: StepResult = {
          status: 'fail',
          durationMs: Date.now() - start,
          error: { message: (err as Error).message, code: 'ORCH_STEP_FAILED' },
        };
        const evidence = await evidenceFor(ctx);
        if (evidence === undefined) {
          return failed;
        }
        const shot = evidence['screenshot'];
        return {
          ...failed,
          evidence,
          ...(typeof shot === 'string' ? { artifacts: [shot] } : {}),
        };
      }
    },
    // The engine calls this when it timed out or aborted the step: runStep never
    // returned, so the catch above never ran.
    captureFailure: (ctx: RunContext): Promise<Record<string, unknown> | undefined> =>
      evidenceFor(ctx),
    dispose: async (): Promise<void> => {
      await context?.close();
      context = undefined;
      page = undefined;
    },
    shutdown: async (): Promise<void> => {
      await browser?.close();
      browser = undefined;
    },
  };
}

/**
 * Factory for wiring the browser runner into {@link buildRunnerRegistry} so a
 * config entry of `{ "type": "browser" }` resolves to a real Playwright runner:
 *
 * ```ts
 * buildRunnerRegistry(config.runners, { browser: browserRunnerFactory });
 * ```
 *
 * @public
 */
export const browserRunnerFactory: RunnerFactory = (name, options) =>
  createBrowserRunner(
    name,
    typeof options['baseUrl'] === 'string' ? { baseUrl: options['baseUrl'] } : {},
  );
