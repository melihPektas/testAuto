export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
  debug(message: string, ...args: readonly unknown[]): void;
  info(message: string, ...args: readonly unknown[]): void;
  warn(message: string, ...args: readonly unknown[]): void;
  error(message: string, ...args: readonly unknown[]): void;
  child(scope: string): Logger;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  scope?: string;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function shouldEmit(current: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER[current] >= LEVEL_ORDER[threshold];
}

export function createLogger(options?: CreateLoggerOptions): Logger {
  const level: LogLevel = options?.level ?? 'info';
  const scope = options?.scope ?? '.to';

  function emit(current: LogLevel, message: string, args: readonly unknown[]): void {
    if (!shouldEmit(current, level)) {
      return;
    }
    const stream = current === 'error' || current === 'warn' ? console.warn : console.log;
    stream(`${current.toUpperCase().padEnd(5)} [${scope}] ${message}`, ...args);
  }

  function makeLogger(currentScope: string): Logger {
    return {
      debug: (m, ...a) => emit('debug', m, a),
      info: (m, ...a) => emit('info', m, a),
      warn: (m, ...a) => emit('warn', m, a),
      error: (m, ...a) => emit('error', m, a),
      child: (s) => makeLogger(`${currentScope}/${s}`),
    };
  }

  return makeLogger(scope);
}
