import { RegistryError } from '../errors/index.js';

export interface RegistryItemBase {
  readonly name: string;
  readonly type: string;
}

export interface RegistryOptions {
  readonly allowDuplicates?: boolean;
}

/**
 * Generic, type-safe registry for items keyed by `type::name` composite key.
 *
 * @public
 */
export class Registry<T extends RegistryItemBase> implements Iterable<T> {
  private readonly items: Map<string, T> = new Map();
  private readonly allowDuplicates: boolean;

  public constructor(options?: RegistryOptions) {
    this.allowDuplicates = options?.allowDuplicates === true;
  }

  public get size(): number {
    return this.items.size;
  }

  public register(item: T): this {
    const key = this.keyOf(item.type, item.name);
    if (!this.allowDuplicates && this.items.has(key)) {
      throw new RegistryError(
        'ORCH_DUPLICATE_REGISTRY_ITEM',
        `Registry item already registered for type="${item.type}" name="${item.name}"`,
        { context: { type: item.type, name: item.name } },
      );
    }
    this.items.set(key, item);
    return this;
  }

  public unregister(name: string, type: string): boolean {
    return this.items.delete(this.keyOf(type, name));
  }

  public get(name: string, type: string): T | undefined {
    return this.items.get(this.keyOf(type, name));
  }

  public getByType(type: string): T[] {
    const result: T[] = [];
    for (const item of this.items.values()) {
      if (item.type === type) {
        result.push(item);
      }
    }
    return result;
  }

  public has(name: string, type: string): boolean {
    return this.items.has(this.keyOf(type, name));
  }

  public list(): readonly T[] {
    return Array.from(this.items.values());
  }

  public clear(): void {
    this.items.clear();
  }

  public [Symbol.iterator](): Iterator<T> {
    return this.items.values();
  }

  private keyOf(type: string, name: string): string {
    return `${type}::${name}`;
  }
}
