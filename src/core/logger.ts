/**
 * Simple structured logger.
 * Respects LOG_LEVEL from config. No external dependencies.
 */

const LEVELS: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel = LEVELS['info'];

export function setLogLevel(level: string): void {
  currentLevel = LEVELS[level.toLowerCase()] ?? LEVELS['info'];
}

function log(level: string, component: string, message: string, data?: unknown): void {
  if ((LEVELS[level] ?? 0) < currentLevel) return;
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level: level.toUpperCase(), component, message, ...(data ? { data } : {}) };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  debug: (component: string, msg: string, data?: unknown) => log('debug', component, msg, data),
  info:  (component: string, msg: string, data?: unknown) => log('info', component, msg, data),
  warn:  (component: string, msg: string, data?: unknown) => log('warn', component, msg, data),
  error: (component: string, msg: string, data?: unknown) => log('error', component, msg, data),
};
