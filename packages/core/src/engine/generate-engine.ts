import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { noopLogger } from '../utils/logger.js';
import type { GeneratorRegistry } from '../registry/registries.js';
import type { GenerateContext, Logger, TestOrchestratorConfig, Workspace } from '../types.js';

export interface GenerateRunOptions {
  readonly config: TestOrchestratorConfig;
  readonly generators: GeneratorRegistry;
  readonly workspace: Workspace;
  readonly logger?: Logger;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly options?: Record<string, unknown>;
}

export interface GenerateRunSummary {
  readonly files: string[];
  readonly count: number;
}

export async function executeGenerators(opts: GenerateRunOptions): Promise<GenerateRunSummary> {
  const logger: Logger = opts.logger ?? noopLogger;
  const env = opts.env ?? {};
  const options = opts.options ?? {};
  const signal = opts.signal ?? new AbortController().signal;
  
  const ctx: GenerateContext = {
    config: opts.config,
    env,
    logger,
    signal,
    workspace: opts.workspace,
    options
  };

  const files: string[] = [];

  for (const generator of opts.generators.list()) {
    const suite = await generator.generate(ctx);
    
    for (const file of suite.files) {
      const target = opts.workspace.resolve(file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, file.encoding ?? 'utf8');
      files.push(target);
      logger.info(`generated ${target}`);
    }
  }

  return { files, count: files.length };
}