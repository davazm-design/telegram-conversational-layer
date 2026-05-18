/**
 * Simple structured logger.
 * Respects LOG_LEVEL from config. No external dependencies.
 *
 * S0.3 — Redacción de secretos.
 * Por qué: cualquier log (un console.error con el error de grammy, una
 * config volcada por descuido) puede arrastrar el TELEGRAM_BOT_TOKEN o el
 * OPENAI_API_KEY a los logs de Railway, que son visibles y persistentes.
 * Un token filtrado = cuenta comprometida. La redacción corre sobre el
 * string final, en TODOS los niveles, así que es imposible saltársela
 * desde un call site.
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

// ── S0.3: redacción ────────────────────────────────────────────────────────
// Nombres de env vars cuyo VALOR exacto nunca debe aparecer en un log.
const SECRET_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'DATABASE_URL',
  'WEBHOOK_SECRET',
];

// Patrones de secreto que redactamos aunque NO vengan de una env var
// conocida (p.ej. un token que llega dentro de un mensaje de error de una
// librería). Defensa en profundidad.
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Telegram bot token: 123456789:AA... (30+ chars tras los dos puntos)
  { re: /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, label: '[REDACTED:TELEGRAM_BOT_TOKEN]' },
  // OpenAI API keys: sk-... / sk-proj-...
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, label: '[REDACTED:OPENAI_API_KEY]' },
  // Credenciales embebidas en una URL: postgres://user:pass@host
  { re: /([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s]+(@)/gi, label: '$1[REDACTED]$2' },
];

/**
 * Redacta secretos de un string ya serializado.
 * Exportada para que los tests verifiquen el contrato directamente.
 */
export function redactSecrets(input: string): string {
  let out = input;
  // 1) Valores exactos de env vars conocidas — la defensa más fuerte.
  for (const key of SECRET_ENV_KEYS) {
    const val = process.env[key];
    if (val && val.length >= 8) {
      out = out.split(val).join(`[REDACTED:${key}]`);
    }
  }
  // 2) Patrones genéricos — atrapa secretos que no vienen de env.
  for (const { re, label } of SECRET_PATTERNS) {
    out = out.replace(re, label);
  }
  return out;
}

function log(level: string, component: string, message: string, data?: unknown): void {
  if ((LEVELS[level] ?? 0) < currentLevel) return;
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level: level.toUpperCase(), component, message, ...(data ? { data } : {}) };
  // La redacción corre sobre el string final: cualquier secreto, venga del
  // `message` o anidado en `data`, queda cubierto.
  const line = redactSecrets(JSON.stringify(entry));
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (component: string, msg: string, data?: unknown) => log('debug', component, msg, data),
  info:  (component: string, msg: string, data?: unknown) => log('info', component, msg, data),
  warn:  (component: string, msg: string, data?: unknown) => log('warn', component, msg, data),
  error: (component: string, msg: string, data?: unknown) => log('error', component, msg, data),
};
