import type { LogLevel } from '@test-orchestrator/schema';

import type { Logger } from '../types.js';

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly scopes?: string[];
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

function rank(level: LogLevel): number {
  return LEVELS.indexOf(level);
}

function shouldLog(active: number, level: LogLevel): boolean {
  if (level === 'silent') return false;
  return rank(level) >= active;
}

function format(level: LogLevel, message: string, scopes: string[]): string {
  const scopeStr = scopes.length > 0 ? ` [${scopes.join(' > ')}]` : '';
  return `${level.toUpperCase()}${scopeStr}: ${message}`;
}

/**
 * Create a console-backed {@link Logger}.
 *
 * @public
 * @param options - Optional level + initial scopes.
 */
export function createLogger(options?: LoggerOptions): Logger {
  const requested = options?.level ?? 'info';
  const minRank = rank(requested);
  const active = minRank === -1 ? rank('info') : minRank;
  const scopes = options?.scopes ?? [];

  function log(level: LogLevel, message: string, args: unknown[]): void {
    if (!shouldLog(active, level)) return;
    const fn =
      level === 'debug'
        ? console.debug
        : level === 'warn'
          ? console.warn
          : level === 'error'
            ? console.error
            : console.log;
    fn(format(level, message, scopes), ...args);
  }

  return {
    debug: (m, ...a) => log('debug', m, a),
    info: (m, ...a) => log('info', m, a),
    warn: (m, ...a) => log('warn', m, a),
    error: (m, ...a) => log('error', m, a),
    child: (scope) => createLogger({ level: requested, scopes: [...scopes, scope] }),
  };
}

/**
 * A {@link Logger} that performs no work. Useful as a default in tests and
 * contexts where logging should be suppressed entirely.
 *
 * @public
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
