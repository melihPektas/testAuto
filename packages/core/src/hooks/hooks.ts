import { HookError } from '../errors/index.js';

export type HookName =
  | 'beforeRun'
  | 'afterRun'
  | 'beforeTest'
  | 'afterTest'
  | 'beforeStep'
  | 'afterStep';

export type HookHandler<Ctx> = (ctx: Ctx) => Promise<void> | void;

export interface Hooks<Ctx> {
  on(name: HookName, handler: HookHandler<Ctx>): () => void;
  off(name: HookName, handler: HookHandler<Ctx>): void;
  once(name: HookName, handler: HookHandler<Ctx>): () => void;
  emit(name: HookName, ctx: Ctx): Promise<void>;
  list(name: HookName): readonly HookHandler<Ctx>[];
  clear(name?: HookName): void;
}

export interface HooksImpl<Ctx> extends Hooks<Ctx> {
  readonly handlerCount: number;
}

const HOOK_NAMES: readonly HookName[] = [
  'beforeRun',
  'afterRun',
  'beforeTest',
  'afterTest',
  'beforeStep',
  'afterStep',
] as const;

const HOOK_NAME_SET: ReadonlySet<string> = new Set(HOOK_NAMES);

function assertHookName(name: string): asserts name is HookName {
  if (!HOOK_NAME_SET.has(name)) {
    throw new HookError(
      'ORCH_HOOK_ERROR',
      `Unknown hook name: ${name}`,
      { context: { name, known: HOOK_NAMES } },
    );
  }
}

/**
 * Create a new lifecycle hook registry.
 *
 * Handlers are invoked in registration order. `emit` waits for all handlers to
 * settle via `Promise.allSettled` but rethrows the first failure as
 * {@link HookError} so subsequent handlers always run.
 *
 * @public
 */
export function createHooks<Ctx>(): HooksImpl<Ctx> {
  const handlers: Map<HookName, Set<HookHandler<Ctx>>> = new Map();
  for (const name of HOOK_NAMES) {
    handlers.set(name, new Set());
  }

  let handlerCount = 0;

  function bucket(name: HookName): Set<HookHandler<Ctx>> {
    const set = handlers.get(name);
    if (!set) {
      throw new HookError(
        'ORCH_HOOK_ERROR',
        `Unknown hook name: ${name}`,
        { context: { name } },
      );
    }
    return set;
  }

  function add(name: HookName, handler: HookHandler<Ctx>): () => void {
    bucket(name).add(handler);
    handlerCount += 1;
    return () => {
      const before = handlerCount;
      if (bucket(name).delete(handler)) {
        handlerCount = Math.max(0, before - 1);
      }
    };
  }

  return {
    get handlerCount() {
      return handlerCount;
    },
    on(name, handler) {
      assertHookName(name);
      return add(name, handler);
    },
    off(name, handler) {
      assertHookName(name);
      const before = handlerCount;
      if (bucket(name).delete(handler)) {
        handlerCount = Math.max(0, before - 1);
      }
    },
    once(name, handler) {
      assertHookName(name);
      const wrapper: HookHandler<Ctx> = async (ctx) => {
        const before = handlerCount;
        if (bucket(name).delete(wrapper)) {
          handlerCount = Math.max(0, before - 1);
        }
        await handler(ctx);
      };
      return add(name, wrapper);
    },
    async emit(name, ctx) {
      assertHookName(name);
      const snapshot = Array.from(bucket(name));
      if (snapshot.length === 0) return;
      const results = await Promise.allSettled(snapshot.map(async (h) => h(ctx)));
      for (const result of results) {
        if (result.status === 'rejected') {
          const cause: unknown = result.reason;
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new HookError('ORCH_HOOK_ERROR', `Hook "${name}" failed: ${message}`, {
            cause,
            context: { hook: name },
          });
        }
      }
    },
    list(name) {
      assertHookName(name);
      return Array.from(bucket(name));
    },
    clear(name) {
      if (name === undefined) {
        for (const set of handlers.values()) {
          set.clear();
        }
        handlerCount = 0;
        return;
      }
      assertHookName(name);
      const before = handlerCount;
      const set = bucket(name);
      const removed = set.size;
      set.clear();
      handlerCount = Math.max(0, before - removed);
    },
  };
}
