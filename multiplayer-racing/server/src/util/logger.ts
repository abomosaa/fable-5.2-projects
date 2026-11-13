import type { LogLevel } from '../config';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Minimal structured logger: one JSON object per line on stdout/stderr. */
export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];
  const write = (lvl: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < threshold) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg: message, ...fields });
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

export const silentLogger: Logger = createLogger('silent');
