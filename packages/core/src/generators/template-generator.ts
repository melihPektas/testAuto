import type { GenerateContext, GeneratedSuite, Generator } from '../types.js';

export function createTemplateGenerator(): Generator {
  return {
    kind: 'generator',
    name: 'template',
    type: 'template',
    generate: (ctx: GenerateContext): Promise<GeneratedSuite> => {
      const names = ctx.options?.['names'];
      const nameArray: string[] = Array.isArray(names)
        ? names.filter((name): name is string => typeof name === 'string')
        : ['sample'];

      const outputDir =
        typeof ctx.options?.['outputDir'] === 'string' ? ctx.options['outputDir'] : '.';

      const files = nameArray.map((name) => {
        const testCase = {
          id: name,
          version: '1.0',
          name,
          steps: [
            {
              id: 'step-1',
              action: `echo "${name}"`,
            },
          ],
        };

        return {
          path: `${outputDir}/${name}.test-case.json`,
          content: JSON.stringify(testCase, null, 2) + '\n',
        };
      });

      return Promise.resolve({ files });
    },
  };
}