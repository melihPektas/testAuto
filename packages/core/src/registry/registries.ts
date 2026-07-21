import type { Generator, Plugin, Reporter, Runner } from '../types.js';
import { Registry } from './registry.js';

/**
 * Registry specialised for {@link Runner} instances.
 *
 * @public
 */
export interface RunnerRegistry {
  readonly size: number;
  register(item: Runner): this;
  unregister(name: string, type: string): boolean;
  get(name: string, type: string): Runner | undefined;
  getByType(type: string): readonly Runner[];
  has(name: string, type: string): boolean;
  list(): readonly Runner[];
  clear(): void;
  [Symbol.iterator](): Iterator<Runner>;
}

/**
 * Registry specialised for {@link Generator} instances.
 *
 * @public
 */
export interface GeneratorRegistry {
  readonly size: number;
  register(item: Generator): this;
  unregister(name: string, type: string): boolean;
  get(name: string, type: string): Generator | undefined;
  getByType(type: string): readonly Generator[];
  has(name: string, type: string): boolean;
  list(): readonly Generator[];
  clear(): void;
  [Symbol.iterator](): Iterator<Generator>;
}

/**
 * Registry specialised for {@link Reporter} instances.
 *
 * @public
 */
export interface ReporterRegistry {
  readonly size: number;
  register(item: Reporter): this;
  unregister(name: string, type: string): boolean;
  get(name: string, type: string): Reporter | undefined;
  getByType(type: string): readonly Reporter[];
  has(name: string, type: string): boolean;
  list(): readonly Reporter[];
  clear(): void;
  [Symbol.iterator](): Iterator<Reporter>;
}

/**
 * Registry specialised for {@link Plugin} instances.
 *
 * @public
 */
export interface PluginRegistry {
  readonly size: number;
  register(item: Plugin): this;
  unregister(name: string, type: string): boolean;
  get(name: string, type: string): Plugin | undefined;
  getByType(type: string): readonly Plugin[];
  has(name: string, type: string): boolean;
  hasPlugin(name: string): boolean;
  list(): readonly Plugin[];
  clear(): void;
  [Symbol.iterator](): Iterator<Plugin>;
}

/**
 * Aggregate of all registries used by an orchestrator runtime instance.
 *
 * @public
 */
export interface OrchestratorRegistries {
  readonly label: string;
  readonly runners: RunnerRegistry;
  readonly generators: GeneratorRegistry;
  readonly reporters: ReporterRegistry;
  readonly plugins: PluginRegistry;
  reset(): void;
}

/**
 * Initialise a new {@link RunnerRegistry}.
 *
 * @public
 */
export function createRunnerRegistry(): RunnerRegistry {
  return new Registry<Runner>();
}

/**
 * Initialise a new {@link GeneratorRegistry}.
 *
 * @public
 */
export function createGeneratorRegistry(): GeneratorRegistry {
  return new Registry<Generator>();
}

/**
 * Initialise a new {@link ReporterRegistry}.
 *
 * @public
 */
export function createReporterRegistry(): ReporterRegistry {
  return new Registry<Reporter>();
}

/**
 * Initialise a new {@link PluginRegistry} with a `hasPlugin` convenience
 * method that looks a plugin up by name across all types.
 *
 * @public
 */
export function createPluginRegistry(): PluginRegistry {
  const inner = new Registry<Plugin>();
  return {
    get size() {
      return inner.size;
    },
    register(item) {
      inner.register(item);
      return this;
    },
    unregister: (name, type) => inner.unregister(name, type),
    get: (name, type) => inner.get(name, type),
    getByType: (type) => inner.getByType(type),
    has: (name, type) => inner.has(name, type),
    hasPlugin: (name) => inner.list().some((p) => p.name === name),
    list: () => inner.list(),
    clear: () => inner.clear(),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
  };
}

let registryCounter = 0;

/**
 * Create a fresh aggregate of orchestrator registries.
 *
 * @public
 */
export function createOchestratorRegistries(): OrchestratorRegistries {
  const label = `orchestrator-registries-${registryCounter.toString(10)}`;
  registryCounter += 1;
  const runners = createRunnerRegistry();
  const generators = createGeneratorRegistry();
  const reporters = createReporterRegistry();
  const plugins = createPluginRegistry();
  return {
    label,
    runners,
    generators,
    reporters,
    plugins,
    reset() {
      runners.clear();
      generators.clear();
      reporters.clear();
      plugins.clear();
    },
  };
}
