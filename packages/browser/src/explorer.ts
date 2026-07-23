import { chromium } from 'playwright';

export interface DiscoveredField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

export interface DiscoveredForm {
  /** 1-based index of the form on its page. */
  readonly index: number;
  readonly action: string;
  readonly method: string;
  readonly fields: DiscoveredField[];
  readonly hasSubmit: boolean;
}

export interface DiscoveredPage {
  readonly url: string;
  readonly title: string;
  readonly status: number | undefined;
  readonly links: string[];
  readonly forms: DiscoveredForm[];
  readonly headings: string[];
}

export interface SiteMap {
  readonly origin: string;
  readonly startUrl: string;
  readonly pages: DiscoveredPage[];
}

export interface ExploreOptions {
  /** How many same-origin pages to visit (default 5). */
  readonly maxPages?: number;
  /** Launch a headed browser (default: headless). */
  readonly headed?: boolean;
}

export interface GeneratedTestCase {
  readonly path: string;
  readonly content: string;
}

function normaliseUrl(href: string): string {
  try {
    const url = new URL(href);
    url.hash = '';
    return url.toString();
  } catch {
    return href;
  }
}

function slugify(value: string): string {
  const slug = value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return slug.length > 0 ? slug.slice(0, 60) : 'page';
}

function pageSlug(url: string, origin: string): string {
  const path = url.startsWith(origin) ? url.slice(origin.length) : url;
  return slugify(path.length > 0 ? path : 'home');
}

/** A plausible value for a field, chosen from its type and name. */
export function sampleValue(type: string, name: string): string {
  switch (type) {
    case 'email':
      return 'test@example.com';
    case 'password':
      return 'Test1234!';
    case 'number':
    case 'range':
      return '42';
    case 'tel':
      return '5551234567';
    case 'url':
      return 'https://example.com';
    case 'date':
      return '2024-01-01';
    case 'time':
      return '12:00';
    default:
      return /mail/i.test(name) ? 'test@example.com' : 'test';
  }
}

/** Scope a selector to a specific form when the page has more than one. */
function scoped(formIndex: number, formCount: number, inner: string): string {
  return formCount > 1 ? `:nth-match(form, ${String(formIndex)}) ${inner}` : `form ${inner}`;
}

/**
 * Crawl a site (same origin, breadth-first, bounded) with a real browser and
 * record what an agent needs in order to write tests: each page's title, its
 * internal links, its headings, and every form with its fields.
 *
 * @public
 */
export async function exploreSite(startUrl: string, options: ExploreOptions = {}): Promise<SiteMap> {
  const maxPages = options.maxPages ?? 5;
  const origin = new URL(startUrl).origin;
  const browser = await chromium.launch({ headless: options.headed !== true });
  const pages: DiscoveredPage[] = [];

  try {
    const page = await browser.newPage();
    const queue: string[] = [normaliseUrl(startUrl)];
    const seen = new Set<string>(queue);

    while (queue.length > 0 && pages.length < maxPages) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      let status: number | undefined;
      try {
        const response = await page.goto(current, { waitUntil: 'domcontentloaded' });
        status = response?.status();
      } catch {
        continue;
      }

      const raw = (await page.evaluate(() => {
        const isSkippable = (type: string): boolean =>
          ['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type);

        const forms = Array.from(document.querySelectorAll('form')).map((form, index) => {
          const controls = Array.from(form.querySelectorAll('input, select, textarea'));
          const fields = controls
            .map((el) => {
              const tag = el.tagName.toLowerCase();
              const input = el as HTMLInputElement;
              const type =
                tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : input.type || 'text';
              return {
                name: input.name || input.id || '',
                type,
                required: input.required === true,
              };
            })
            .filter((f) => f.name !== '' && !isSkippable(f.type));
          const submit = form.querySelector(
            'button[type="submit"], input[type="submit"], button:not([type])',
          );
          return {
            index: index + 1,
            action: form.getAttribute('action') ?? '',
            method: (form.getAttribute('method') ?? 'get').toLowerCase(),
            fields,
            hasSubmit: submit !== null,
          };
        });

        return {
          links: Array.from(document.querySelectorAll('a[href]')).map(
            (a) => (a as HTMLAnchorElement).href,
          ),
          headings: Array.from(document.querySelectorAll('h1, h2'))
            .map((h) => (h.textContent ?? '').trim())
            .filter((t) => t.length > 0)
            .slice(0, 10),
          forms,
        };
      }));

      const internalLinks = Array.from(
        new Set(
          raw.links
            .map(normaliseUrl)
            .filter((href) => href.startsWith(origin))
            .filter((href) => !/\.(pdf|zip|png|jpe?g|svg|gif|css|js)$/i.test(href)),
        ),
      );

      pages.push({
        url: current,
        title: await page.title(),
        status,
        links: internalLinks.slice(0, 25),
        forms: raw.forms,
        headings: raw.headings,
      });

      for (const link of internalLinks) {
        if (!seen.has(link) && seen.size < maxPages * 4) {
          seen.add(link);
          queue.push(link);
        }
      }
    }
  } finally {
    await browser.close();
  }

  return { origin, startUrl: normaliseUrl(startUrl), pages };
}

/**
 * Author orchestrator test cases from an exploration: a UI audit per page, a
 * fill-and-submit flow per discovered form, and a navigation check over the
 * links found on the entry page.
 *
 * @public
 */
export function generateTestsFromExploration(
  map: SiteMap,
  runner = 'ui',
): GeneratedTestCase[] {
  const cases: GeneratedTestCase[] = [];

  const push = (id: string, name: string, steps: unknown[]): void => {
    cases.push({
      path: `explored/${id}.test-case.json`,
      content: `${JSON.stringify({ id, version: '1.0', name, runner, steps }, null, 2)}\n`,
    });
  };

  for (const page of map.pages) {
    const slug = pageSlug(page.url, map.origin);

    // 1) One audit per discovered page.
    push(`audit-${slug}`, `UI audit: ${page.url}`, [
      { id: 'goto', action: 'goto', value: page.url },
      { id: 'status', action: 'expectStatus', value: 200 },
      { id: 'audit', action: 'audit' },
    ]);

    // 2) One fill-and-submit flow per form that has inputs and a submit control.
    for (const form of page.forms) {
      if (form.fields.length === 0 || !form.hasSubmit) {
        continue;
      }
      const steps: unknown[] = [
        { id: 'goto', action: 'goto', value: page.url },
        { id: 'status', action: 'expectStatus', value: 200 },
      ];
      for (const field of form.fields) {
        const selector = scoped(form.index, page.forms.length, `[name="${field.name}"]`);
        if (field.type === 'checkbox' || field.type === 'radio') {
          steps.push({ id: `check-${slugify(field.name)}`, action: 'check', target: selector });
        } else if (field.type === 'select') {
          steps.push({
            id: `select-${slugify(field.name)}`,
            action: 'select',
            target: selector,
            value: { index: 0 },
          });
        } else {
          steps.push({
            id: `fill-${slugify(field.name)}`,
            action: 'fill',
            target: selector,
            value: sampleValue(field.type, field.name),
          });
        }
      }
      steps.push({
        id: 'submit',
        action: 'click',
        target: scoped(
          form.index,
          page.forms.length,
          'button[type="submit"], input[type="submit"], button:not([type])',
        ),
      });
      steps.push({ id: 'no-errors', action: 'expectNoConsoleErrors' });

      push(
        `form-${slug}-${String(form.index)}`,
        `Form flow (${form.fields.length} field(s)) on ${page.url}`,
        steps,
      );
    }
  }

  // 3) Navigation: the entry page's links should all resolve.
  const entry = map.pages[0];
  if (entry !== undefined && entry.links.length > 0) {
    const steps: unknown[] = [];
    for (const [i, link] of entry.links.slice(0, 8).entries()) {
      steps.push({ id: `goto-${String(i)}`, action: 'goto', value: link });
      steps.push({ id: `status-${String(i)}`, action: 'expectStatus', value: 200 });
    }
    push('navigation', `Navigation: ${String(steps.length / 2)} link(s) from ${entry.url}`, steps);
  }

  return cases;
}
