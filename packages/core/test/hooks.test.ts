import { describe, expect, it } from 'vitest';

import { HookError } from '../src/errors/errors.js';
import { createHooks } from '../src/hooks/hooks.js';

describe('createHooks', () => {
  it('invokes registered handlers in order on emit', async () => {
    const hooks = createHooks<{ log: string[] }>();
    const ctx = { log: [] as string[] };
    hooks.on('beforeRun', (c) => {
      c.log.push('first');
    });
    hooks.on('beforeRun', (c) => {
      c.log.push('second');
    });
    await hooks.emit('beforeRun', ctx);
    expect(ctx.log).toEqual(['first', 'second']);
  });

  it('tracks handlerCount and supports unsubscribe', () => {
    const hooks = createHooks<void>();
    const off = hooks.on('afterRun', () => undefined);
    expect(hooks.handlerCount).toBe(1);
    off();
    expect(hooks.handlerCount).toBe(0);
  });

  it('once handlers fire a single time', async () => {
    const hooks = createHooks<{ n: number }>();
    const ctx = { n: 0 };
    hooks.once('beforeStep', (c) => {
      c.n += 1;
    });
    await hooks.emit('beforeStep', ctx);
    await hooks.emit('beforeStep', ctx);
    expect(ctx.n).toBe(1);
  });

  it('emit rethrows a failing handler as HookError', async () => {
    const hooks = createHooks<void>();
    hooks.on('afterTest', () => {
      throw new Error('handler blew up');
    });
    await expect(hooks.emit('afterTest', undefined)).rejects.toBeInstanceOf(HookError);
  });

  it('clear removes handlers', () => {
    const hooks = createHooks<void>();
    hooks.on('beforeRun', () => undefined);
    hooks.on('afterRun', () => undefined);
    hooks.clear('beforeRun');
    expect(hooks.list('beforeRun')).toHaveLength(0);
    expect(hooks.list('afterRun')).toHaveLength(1);
    hooks.clear();
    expect(hooks.handlerCount).toBe(0);
  });
});
