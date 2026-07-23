import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Page } from 'playwright';

export interface Evidence {
  /** Where the browser actually was when the step failed. */
  readonly url: string;
  readonly title: string;
  /** How much text the page rendered — near zero means it never really loaded. */
  readonly bodyChars: number;
  /** First words of the visible page, for a human reading the report. */
  readonly excerpt: string;
  /** How many elements the failing step's selector matched (0 is the usual answer). */
  readonly targetCount?: number;
  /**
   * Selectors present on the page that share a word with the one we looked for.
   * This is what separates "the element is missing" from "the page is showing
   * you something else, and it is telling you why".
   */
  readonly similarSelectors?: string[];
  /** Path to the screenshot, relative to the artifacts directory. */
  readonly screenshot?: string;
}

/** Split `.welcome-message` / `#search_product` into its meaningful words. */
function tokens(selector: string): string[] {
  return selector
    .split(/[^a-z0-9]+/i)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 2);
}

function slug(value: string): string {
  return (
    value
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'step'
  );
}

/**
 * Capture what the page looked like at the moment a step failed: a screenshot
 * for a human, and a small set of facts a triager can reason over. The DOM
 * itself is deliberately not included — it is far too large to put in front of
 * a model, and almost none of it bears on why the step failed.
 *
 * Capture must never mask the original failure, so every part is best-effort.
 *
 * @public
 */
export async function captureEvidence(
  page: Page,
  options: { artifactsDir: string; testCaseId: string; stepIndex: number; target?: string },
): Promise<Evidence> {
  const base: Evidence = { url: '', title: '', bodyChars: 0, excerpt: '' };
  try {
    const target = options.target;
    const wanted = target === undefined ? [] : tokens(target);

    const facts = await page.evaluate(
      ({ selector, words }) => {
        const body = document.body?.innerText ?? '';
        let targetCount: number | undefined;
        if (selector !== undefined && selector !== '') {
          try {
            targetCount = document.querySelectorAll(selector).length;
          } catch {
            targetCount = undefined;
          }
        }

        const similar = new Set<string>();
        if (words.length > 0) {
          for (const el of Array.from(document.querySelectorAll('[class],[id]'))) {
            for (const name of Array.from(el.classList)) {
              if (words.some((w) => name.toLowerCase().includes(w))) {
                similar.add(`.${name}`);
              }
            }
            const id = el.getAttribute('id');
            if (id !== null && words.some((w) => id.toLowerCase().includes(w))) {
              similar.add(`#${id}`);
            }
          }
        }

        return {
          url: window.location.href,
          title: document.title,
          bodyChars: body.length,
          excerpt: body.replace(/\s+/g, ' ').trim().slice(0, 300),
          targetCount,
          similar: Array.from(similar).slice(0, 10),
        };
      },
      { selector: target, words: wanted },
    );

    const dir = join(options.artifactsDir, slug(options.testCaseId));
    const name = `step-${String(options.stepIndex)}.png`;
    let screenshot: string | undefined;
    try {
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: join(dir, name), fullPage: false });
      screenshot = join(slug(options.testCaseId), name);
    } catch {
      // a screenshot is a nicety; the facts above are the evidence
    }

    const evidence: Evidence = {
      url: facts.url,
      title: facts.title,
      bodyChars: facts.bodyChars,
      excerpt: facts.excerpt,
      ...(facts.targetCount !== undefined ? { targetCount: facts.targetCount } : {}),
      ...(facts.similar.length > 0 ? { similarSelectors: facts.similar } : {}),
      ...(screenshot !== undefined ? { screenshot } : {}),
    };

    try {
      await writeFile(
        join(dir, `step-${String(options.stepIndex)}.json`),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // the evidence still travels in the run report
    }
    return evidence;
  } catch {
    return base;
  }
}
