import type { Plugin, PluginRegistry } from '../types.js';

export interface PluginConfigInput {
  readonly name: string;
  readonly path: string;
  readonly options?: Record<string, unknown>;
  readonly enabled?: boolean;
}

export interface LoadedPlugin {
  readonly name: string;
  readonly path: string;
  readonly loaded: boolean;
  readonly error?: string;
}

/**
 * Load the plugins declared in a config: each entry's `path` is imported and its
 * exported plugin (default export, or a named `plugin` export) is registered and
 * installed into the given registry.
 *
 * Failures are reported per plugin rather than aborting the whole run.
 *
 * @public
 */
export async function loadPlugins(
  plugins: readonly PluginConfigInput[],
  registry: PluginRegistry,
): Promise<LoadedPlugin[]> {
  const results: LoadedPlugin[] = [];
  for (const entry of plugins) {
    if (entry.enabled === false) {
      results.push({ name: entry.name, path: entry.path, loaded: false, error: 'disabled' });
      continue;
    }
    try {
      const module = (await import(entry.path)) as { default?: Plugin; plugin?: Plugin };
      const plugin = module.default ?? module.plugin;
      if (plugin === undefined) {
        throw new Error('module exports no plugin (expected a default or `plugin` export)');
      }
      registry.register(plugin);
      await plugin.install(registry, entry.options);
      results.push({ name: entry.name, path: entry.path, loaded: true });
    } catch (err) {
      results.push({
        name: entry.name,
        path: entry.path,
        loaded: false,
        error: (err as Error).message,
      });
    }
  }
  return results;
}
