import type {
  GenerateContext,
  GeneratorFactory,
  GeneratedFile,
  GeneratedSuite,
  Generator,
} from '@test-orchestrator/core';

function slugify(url: string): string {
  const slug = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug.length > 0 ? slug : 'site';
}

/**
 * Generator that turns one or more URLs into UI smoke test cases for the
 * browser runner: navigate, assert a 2xx status, a non-empty title, and a body.
 *
 * Reads `options.urls` (string[]) or `options.url` (string), and
 * `options.outputDir` (defaults to `.`).
 *
 * @public
 */
export function createUrlGenerator(): Generator {
  return {
    kind: 'generator',
    name: 'url',
    type: 'url',
    generate: (ctx: GenerateContext): Promise<GeneratedSuite> => {
      const urlsOption = ctx.options?.['urls'];
      const rawUrl = ctx.options?.['url'];
      const urls = Array.isArray(urlsOption)
        ? urlsOption.map((u) => (typeof u === 'string' ? u : ''))
        : [typeof rawUrl === 'string' ? rawUrl : 'https://example.com'];
      const outputDir =
        typeof ctx.options?.['outputDir'] === 'string' ? ctx.options['outputDir'] : '.';

      const files: GeneratedFile[] = urls.map((url) => {
        const slug = slugify(url);
        const testCase = {
          id: `ui-${slug}`,
          version: '1.0',
          name: `UI smoke: ${url}`,
          runner: 'browser',
          steps: [
            { id: 'goto', action: 'goto', value: url },
            { id: 'status', action: 'expectStatus', value: 200 },
            { id: 'title', action: 'expectTitle' },
            { id: 'body', action: 'expectSelector', target: 'body' },
          ],
        };
        return {
          path: `${outputDir}/ui-${slug}.test-case.json`,
          content: `${JSON.stringify(testCase, null, 2)}\n`,
        };
      });

      return Promise.resolve({ files });
    },
  };
}

/**
 * Factory for wiring the URL generator into {@link buildGeneratorRegistry} so a
 * config entry of `{ "type": "url" }` resolves to this generator.
 *
 * @public
 */
export const urlGeneratorFactory: GeneratorFactory = () => createUrlGenerator();
