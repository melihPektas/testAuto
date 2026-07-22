import type { GenerateContext, GeneratedFile, GeneratedSuite, Generator } from '../types.js';

export function createTemplateGenerator(): Generator {
  return {
    kind: 'generator',
    name: 'template',
    type: 'template',
    generate: async (ctx: GenerateContext): Promise<GeneratedSuite> => {
      const names = ctx.options?.['names'];
      const nameArray = Array.isArray(names) ? names : ['sample'];
      
      const outputDir = typeof ctx.options?.['outputDir'] === 'string' 
        ? ctx.options['outputDir'] 
        : '.';

      const files = await Promise.all(
        nameArray.map(async (name) => {
          const testCase = {
            id: name,
            version: '1.0',
            name,
            steps: [
              {
                id: 'step-1',
                action: `echo "${name}"`
              }
            ]
          };

          return {
            path: `${outputDir}/${name}.test-case.json`,
            content: JSON.stringify(testCase, null, 2) + '\n'
          };
        })
      );

      return { files };
    }
  };
}