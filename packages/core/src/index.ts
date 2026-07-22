export * from './errors/index.js';
export * from './registry/index.js';
export * from './hooks/index.js';
export * from './utils/index.js';
export * from './engine/index.js';
export * from './runners/index.js';
export * from './reporters/index.js';
export * from './generators/index.js';
export * from './types.js';

// Disambiguate: PluginRegistry is declared in both ./types.js and the registry
// module. The registry module owns the canonical definition (it ships the
// createPluginRegistry factory), so re-export it explicitly to resolve TS2308.
export type { PluginRegistry } from './registry/registries.js';
