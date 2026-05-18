/**
 * S0.3 — Tests del redactor de secretos del logger.
 *
 * Por qué cada test existe: si rompemos cualquiera, un secreto real puede
 * acabar en los logs de Railway. Es el tipo de bug que es invisible hasta
 * que un tercero te demuestra que tiene tu token.
 */

import { redactSecrets } from '../src/core/logger';

describe('redactSecrets (S0.3)', () => {
  test('redacta el TELEGRAM_BOT_TOKEN exacto de process.env', () => {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '123456789:AAxxxYYY-zzz-superSecret-1234567890_ABCD';
    try {
      const out = redactSecrets(
        `error: 401 unauthorized for token=${process.env.TELEGRAM_BOT_TOKEN}`,
      );
      expect(out).not.toContain(process.env.TELEGRAM_BOT_TOKEN!);
      expect(out).toContain('[REDACTED:TELEGRAM_BOT_TOKEN]');
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  });

  test('redacta el OPENAI_API_KEY exacto de process.env', () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-abcdefghijklmnop1234567890';
    try {
      const out = redactSecrets(`config: { key: "${process.env.OPENAI_API_KEY}" }`);
      expect(out).not.toContain(process.env.OPENAI_API_KEY!);
      expect(out).toContain('[REDACTED:OPENAI_API_KEY]');
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  test('redacta tokens de Telegram por patrón aunque no estén en env', () => {
    const fake = '987654321:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const out = redactSecrets(`grammy error with ${fake}`);
    expect(out).not.toContain(fake);
    expect(out).toContain('[REDACTED:TELEGRAM_BOT_TOKEN]');
  });

  test('redacta sk- keys de OpenAI por patrón', () => {
    const fake = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123';
    const out = redactSecrets(`OpenAI 401: invalid key ${fake}`);
    expect(out).not.toContain(fake);
    expect(out).toContain('[REDACTED:OPENAI_API_KEY]');
  });

  test('redacta password embebido en una connection string', () => {
    const out = redactSecrets('postgres://user:supersecret@host:5432/db');
    expect(out).not.toContain('supersecret');
    expect(out).toMatch(/postgres:\/\/user:\[REDACTED\]@host/);
  });

  test('no toca texto que no contiene secretos', () => {
    const s = 'todo ok — 2 microtasks creadas';
    expect(redactSecrets(s)).toBe(s);
  });
});
