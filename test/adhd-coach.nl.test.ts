/**
 * Tests Fase 4 — capa NL conversacional ligera (sin LLM).
 *
 * Verifican:
 *   - Las nuevas intenciones explain_commands, explain_natural_language y
 *     what_can_you_do responden a frases NL del usuario, NO al fallback.
 *   - /help muestra texto curado (no nombres internos como add_reminder).
 *   - Fallback actualizado guía al usuario hacia lo que el bot sí entiende.
 *   - NL triggers nuevos para list_reminders, set_silence, agenda_start.
 *   - El pre-filter de crisis sigue ganando sobre cualquier intención NL.
 */

import { Orchestrator } from '../src/index';
import { CRISIS_FIXED_MESSAGE } from '../src/security/crisis.detector';
import { AdhdCoachDomainHandler } from '../src/examples/adhd-coach.domain';
import { MemoryStorageProvider } from '../src/core/storage/memory.storage';
import {
  GenericMessage,
  GenericResponse,
  IMessageAdapter,
} from '../src/core/types';
import { AppConfig } from '../src/core/config';
import { setLogLevel } from '../src/core/logger';

setLogLevel('error');

class MockAdapter implements IMessageAdapter {
  public sent: GenericResponse[] = [];
  private handler: ((msg: GenericMessage) => Promise<void>) | null = null;
  async start(h: (msg: GenericMessage) => Promise<void>): Promise<void> { this.handler = h; }
  async sendResponse(r: GenericResponse): Promise<void> { this.sent.push(r); }
  async stop(): Promise<void> { this.handler = null; }
  async receive(text: string, userId = 'nl-user'): Promise<void> {
    if (!this.handler) throw new Error('handler not set');
    await this.handler({
      id: String(Date.now()) + Math.random().toString(36).slice(2),
      userId, chatId: userId, text,
      timestamp: new Date().toISOString(),
    });
  }
  last(): string { return this.sent[this.sent.length - 1]?.text ?? ''; }
  reset(): void { this.sent = []; }
}

function cfg(): AppConfig {
  return {
    telegram: { botToken: 'test', mode: 'polling', webhookSecret: '', publicWebhookUrl: '', port: 0 },
    llm: { enabled: false, provider: 'openai', openaiApiKey: '' },
    storage: { provider: 'memory', databaseUrl: '' },
    logLevel: 'error',
  };
}

describe('Fase 4 — NL conversacional ligera', () => {
  let storage: MemoryStorageProvider;
  let adapter: MockAdapter;
  let domain: AdhdCoachDomainHandler;
  let orch: Orchestrator;

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('nl-test');
    adapter = new MockAdapter();
    domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
    orch = new Orchestrator(adapter, domain, cfg(), storage.sessionStore);
    await orch.start();
  });

  afterEach(async () => {
    await orch.stop();
    await storage.disconnect();
  });

  // ── explain_commands ───────────────────────────────────────────────────
  test('"¿Para qué me sirve cada comando?" → explain_commands', async () => {
    await adapter.receive('¿Para qué me sirve cada comando?');
    const r = adapter.last();
    expect(r).toMatch(/te explico/i);
    expect(r).toContain('/agenda');
    expect(r).toContain('/recordar');
    expect(r).not.toMatch(/no entend/i);
  });

  test('"qué hace cada comando" → explain_commands', async () => {
    await adapter.receive('qué hace cada comando');
    expect(adapter.last()).toContain('/agenda');
  });

  test('"para qué sirve /agenda" → explain_commands', async () => {
    await adapter.receive('para qué sirve /agenda');
    expect(adapter.last()).toMatch(/agenda/i);
    expect(adapter.last()).not.toMatch(/no entend/i);
  });

  // ── explain_natural_language ───────────────────────────────────────────
  test('"¿No dices que puedo escribir en lenguaje natural?" → explain_natural_language', async () => {
    await adapter.receive('¿No dices que puedo escribir en lenguaje natural?');
    const r = adapter.last();
    expect(r).toMatch(/natural/i);
    expect(r).toMatch(/recu[ée]rdame|quiero ordenar|me rindo/i);
    expect(r).not.toMatch(/no entend/i);
  });

  test('"cómo te hablo" → explain_natural_language', async () => {
    await adapter.receive('cómo te hablo');
    expect(adapter.last()).toMatch(/natural|ejemplos/i);
    expect(adapter.last()).not.toMatch(/no entend/i);
  });

  // ── what_can_you_do ────────────────────────────────────────────────────
  test('"¿Qué puedes hacer?" → what_can_you_do', async () => {
    await adapter.receive('¿Qué puedes hacer?');
    const r = adapter.last();
    expect(r).toMatch(/puedo ayudarte/i);
    expect(r).toMatch(/recordatorios/i);
    expect(r).not.toMatch(/no entend/i);
  });

  test('"para qué sirves" → what_can_you_do', async () => {
    await adapter.receive('para qué sirves');
    expect(adapter.last()).toMatch(/puedo ayudarte/i);
  });

  test('"cómo me ayudas" → what_can_you_do', async () => {
    await adapter.receive('cómo me ayudas');
    expect(adapter.last()).toMatch(/puedo ayudarte/i);
  });

  // ── NL para acciones existentes ────────────────────────────────────────
  test('"quiero ordenar mi día" → agenda_start', async () => {
    await adapter.receive('quiero ordenar mi día');
    expect(adapter.last()).toMatch(/ordenar el d|vuélcame|laboral|personal/i);
    expect(adapter.last()).not.toMatch(/no entend/i);
  });

  test('"estoy bloqueado" → agenda_start', async () => {
    await adapter.receive('estoy bloqueado');
    expect(adapter.last()).not.toMatch(/no entend/i);
  });

  test('"no sé por dónde empezar" → agenda_start', async () => {
    await adapter.receive('no sé por dónde empezar');
    expect(adapter.last()).not.toMatch(/no entend/i);
  });

  test('"quiero ver mis recordatorios" → list_reminders', async () => {
    await adapter.receive('quiero ver mis recordatorios');
    expect(adapter.last()).toMatch(/recordatorios pendientes|no tienes recordatorios/i);
  });

  test('"muéstrame mis recordatorios" → list_reminders', async () => {
    await adapter.receive('muéstrame mis recordatorios');
    expect(adapter.last()).toMatch(/recordatorios pendientes|no tienes recordatorios/i);
  });

  test('"necesito silencio por 2 horas" → set_silence con duración', async () => {
    await adapter.receive('necesito silencio por 2 horas');
    expect(adapter.last()).toMatch(/silencio/i);
    const until = await storage.adhdCoachStore.getSilenceUntil('nl-user');
    expect(until).not.toBeNull();
    const diffMs = new Date(until as string).getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(1.9 * 3600_000);
    expect(diffMs).toBeLessThan(2.1 * 3600_000);
  });

  test('"pausa mensajes por 3 horas" → set_silence con duración', async () => {
    await adapter.receive('pausa mensajes por 3 horas');
    const until = await storage.adhdCoachStore.getSilenceUntil('nl-user');
    expect(until).not.toBeNull();
    const diffMs = new Date(until as string).getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(2.9 * 3600_000);
    expect(diffMs).toBeLessThan(3.1 * 3600_000);
  });

  test('"qué guardas de mí" → show_privacy', async () => {
    await adapter.receive('qué guardas de mí');
    expect(adapter.last()).toMatch(/contexto declarado|guardo/i);
  });

  test('"borra mis datos" → delete_all_state (pide confirmación)', async () => {
    await adapter.receive('borra mis datos');
    expect(adapter.last()).toMatch(/Confirmación requerida/i);
  });

  // ── /help curado ───────────────────────────────────────────────────────
  test('/help muestra texto curado SIN nombres internos de capabilities', async () => {
    await adapter.receive('/help');
    const r = adapter.last();
    expect(r).toContain('/agenda');
    expect(r).toContain('/recordar');
    expect(r).toContain('/recordatorios');
    expect(r).toContain('/silencio');
    expect(r).toMatch(/frases como|lenguaje natural/i);
    // NO debe filtrar nombres técnicos al usuario:
    expect(r).not.toContain('add_reminder');
    expect(r).not.toContain('list_reminders');
    expect(r).not.toContain('agenda_classify');
    expect(r).not.toContain('complete_reminder_with_time');
    expect(r).not.toContain('show_overdue_reminders');
  });

  // ── Fallback nuevo ─────────────────────────────────────────────────────
  test('mensaje totalmente irreconocible → fallback orientador, NO solo "No entendí"', async () => {
    await adapter.receive('asdfqwerzxcv');
    const r = adapter.last();
    // El fallback debe guiar al usuario, no solo decir "no entendí".
    expect(r.length).toBeGreaterThan(40);
    expect(r).toMatch(/agenda|recordatorios|silencio|privacidad|qué puedes hacer/i);
    expect(r).toMatch(/\/help/);
  });

  // ── Crisis SIGUE ganando sobre cualquier NL ───────────────────────────
  test('crisis siempre gana: "no quiero seguir" → crisis fixed message', async () => {
    await adapter.receive('no quiero seguir');
    expect(adapter.last()).toBe(CRISIS_FIXED_MESSAGE);
  });

  test('crisis gana incluso si tiene forma de pregunta', async () => {
    await adapter.receive('mejor desaparecer');
    expect(adapter.last()).toBe(CRISIS_FIXED_MESSAGE);
  });
});
