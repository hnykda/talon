/**
 * Logging helper. ALL logging goes to stderr — stdout is the MCP stdio
 * transport and must never receive anything but protocol frames.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function minLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

export function log(level: LogLevel, message: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel()]) return;
  let suffix = '';
  if (extra !== undefined) {
    try {
      suffix = ` ${JSON.stringify(extra)}`;
    } catch {
      suffix = ` ${String(extra)}`;
    }
  }
  process.stderr.write(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${suffix}\n`);
}
