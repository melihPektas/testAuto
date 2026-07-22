import { chromium, type Browser, type Page, type Response } from 'playwright';

import type { Runner, RunContext, StepResult } from '@test-orchestrator/core';

export interface BrowserRunnerOptions {
  /** Base URL prepended to relative `goto` targets. */
  readonly baseUrl?: string;
  /** Launch a headed browser (default: headless). */
  readonly headed?: boolean;
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
        const url = resolveUrl(String(value ?? target ?? ''), options.baseUrl);
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
          if (!title.includes(String(value))) {
            throw new Error(`title "${title}" does not contain "${String(value)}"`);
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
        const needle = String(value ?? '');
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
