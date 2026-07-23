import { chromium, type Browser, type Page, type Response } from 'playwright';

import type { Runner, RunContext, RunnerFactory, StepResult } from '@test-orchestrator/core';

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
  let page: Page | undefined;
  let lastResponse: Response | null = null;
  const consoleErrors: string[] = [];

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
      case 'expectNoConsoleErrors': {
        if (consoleErrors.length > 0) {
          throw new Error(
            `${String(consoleErrors.length)} console error(s): ${consoleErrors.slice(0, 3).join(' | ')}`,
          );
        }
        return { output: 'no console errors' };
      }
      case 'expectNoBrokenImages': {
        const broken = await page.$$eval('img', (imgs) =>
          imgs.filter((img) => img.complete && img.naturalWidth === 0).length,
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
      case 'audit': {
        const checks: { name: string; ok: boolean; detail: string }[] = [];

        const title = await page.title();
        checks.push({ name: 'title', ok: title.length > 0, detail: title.length > 0 ? title : '(empty)' });

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

        const report = checks
          .map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`)
          .join('\n');
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
      browser = await chromium.launch({ headless: options.headed !== true });
      page = await browser.newPage();
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
    },
    runStep: async (ctx: RunContext): Promise<StepResult> => {
      const start = Date.now();
      try {
        const { output } = await act(ctx);
        const result: StepResult = { status: 'pass', durationMs: Date.now() - start };
        return output === undefined ? result : { ...result, output };
      } catch (err) {
        return {
          status: 'fail',
          durationMs: Date.now() - start,
          error: { message: (err as Error).message, code: 'ORCH_STEP_FAILED' },
        };
      }
    },
    dispose: async (): Promise<void> => {
      await browser?.close();
      browser = undefined;
      page = undefined;
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
