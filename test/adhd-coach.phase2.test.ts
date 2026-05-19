/**
 * Tests Fase 2 del dominio adhd-coach:
 *   /silencio, /privacidad, borrado total, /abandonar, /reinicio, /agenda.
 *
 * Estos tests son específicos del dominio y NO tocan el core. Verifican:
 *   - Las capabilities y rules del dominio responden correctamente.
 *   - El pre-filter de crisis global (transversal) sigue ganando sobre
 *     cualquier capacidad nueva en frases ambiguas.
 *   - Las acciones HIGH_RISK preservan su confirmación.
 */

import { Orchestrator } from '../src/index';
import { CRISIS_FIXED_MESSAGE } from '../src/security/crisis.detector';
import {
  GenericMessage,
  GenericResponse,
  IMessageAdapter,
} from '../src/core/types';
import { MemoryStorageProvider } from '../src/core/storage/memory.storage';
import { AdhdCoachDomainHandler } from '../src/examples/adhd-coach.domain';
import { AppConfig } from '../src/core/config';
import { setLogLevel } from '../src/core/logger';

setLogLevel('error');

// ─── Helpers ─────────────────────────────────────────────────────────────────

class MockAdapter implements IMessageAdapter {
  public sentResponses: GenericResponse[] = [];
  private handler: ((msg: GenericMessage) => Promise<void>) | null = null;

  async start(handler: (msg: GenericMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }
  async sendResponse(response: GenericResponse): Promise<void> {
    this.sentResponses.push(response);
  }
  async stop(): Promise<void> {
    this.handler = null;
  }
  async receive(text: string, userId = 'phase2-user'): Promise<void> {
    if (!this.handler) throw new Error('handler no registrado');
    const msg: GenericMessage = {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 8),
      userId,
      chatId: userId,
      text,
      timestamp: new Date().toISOString(),
    };
    await this.handler(msg);
  }
  reset(): void { this.sentResponses = []; }
}

function testConfig(): AppConfig {
  return {
    telegram: {
      botToken: 'test', mode: 'polling', webhookSecret: '',
      publicWebhookUrl: '', port: 3000,
    },
    llm: { enabled: false, provider: 'openai', openaiApiKey: '' },
    storage: { provider: 'memory', databaseUrl: '' },
    logLevel: 'error',
  };
}

// ─── Suites ──────────────────────────────────────────────────────────────────

describe('adhd-coach Fase 2 — capabilities nuevas', () => {
  let storage: MemoryStorageProvider;
  let adapter: MockAdapter;
  let domain: AdhdCoachDomainHandler;
  let orch: Orchestrator;

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('adhd-phase2-test');
    adapter = new MockAdapter();
    domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
    orch = new Orchestrator(adapter, domain, testConfig(), storage.sessionStore);
    await orch.start();
  });

  afterEach(async () => {
    await orch.stop();
    await storage.disconnect();
  });

  const lastReply = () =>
    adapter.sentResponses[adapter.sentResponses.length - 1]?.text;

  // 1) /silencio activa silencio
  test('/silencio activa silencio (default hasta mañana 08:00)', async () => {
    await adapter.receive('/silencio');
    expect(lastReply()).toMatch(/Modo silencio hasta /);
    expect(lastReply()).toContain('Te respondo si me escribes');
    // Persistió en store
    const until = await storage.adhdCoachStore.getSilenceUntil('phase2-user');
    expect(until).not.toBeNull();
    expect(new Date(until as string).getTime()).toBeGreaterThan(Date.now());
  });

  test('/silencio 2h activa silencio con duración custom', async () => {
    await adapter.receive('/silencio 2h');
    const until = await storage.adhdCoachStore.getSilenceUntil('phase2-user');
    expect(until).not.toBeNull();
    const diffMs = new Date(until as string).getTime() - Date.now();
    // ~2 horas (con holgura por tiempo de ejecución)
    expect(diffMs).toBeGreaterThan(1.9 * 3600_000);
    expect(diffMs).toBeLessThan(2.1 * 3600_000);
  });

  // 2) Crisis interrumpe silencio (el pre-filter global gana)
  test('Crisis interrumpe modo silencio', async () => {
    await adapter.receive('/silencio');
    expect(lastReply()).toContain('Modo silencio');

    adapter.reset();
    await adapter.receive('no quiero seguir');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
  });

  // 3) /privacidad incluye "Contexto declarado por ti: TDAH"
  test('/privacidad incluye contexto TDAH', async () => {
    await adapter.receive('/privacidad');
    expect(lastReply()).toContain('Contexto declarado por ti: TDAH');
  });

  // 4) /privacidad NO contiene lenguaje clínico
  test('/privacidad NO usa "diagnóstico" ni "padecimiento"', async () => {
    await adapter.receive('/privacidad');
    const reply = (lastReply() ?? '').toLowerCase();
    for (const forbidden of ['diagnóstico', 'diagnostico', 'padecimiento', 'te diagnostiqué', 'tu diagnóstico es']) {
      expect(reply).not.toContain(forbidden);
    }
  });

  test('/privacidad lista las áreas de datos esperadas', async () => {
    await adapter.receive('/privacidad');
    const r = lastReply() ?? '';
    expect(r).toContain('Estado de tareas/microtareas');
    expect(r).toContain('Sesión de enfoque');
    expect(r).toContain('Modo silencio');
    expect(r).toContain('Preferencias básicas');
    expect(r).toContain('A) borrar todo');
  });

  // 5) "borrar todo" borra estado del usuario
  test('"borrar todo" requiere confirmación y luego borra el estado', async () => {
    // Sembramos estado
    await storage.adhdCoachStore.addMicroTask('phase2-user', 'enviar informe');
    await storage.adhdCoachStore.setSilenceUntil(
      'phase2-user', new Date(Date.now() + 3600_000).toISOString(),
    );

    // Turno 1: rule "borrar todo" → HIGH_RISK_ACTION pide confirmación
    await adapter.receive('borrar todo');
    expect(lastReply()).toMatch(/Confirmación requerida/i);

    // Verifica que aún no se borró
    expect((await storage.adhdCoachStore.getMicroTasks('phase2-user')).length).toBe(1);
    expect(await storage.adhdCoachStore.getSilenceUntil('phase2-user')).not.toBeNull();

    // Turno 2: confirmar
    adapter.reset();
    await adapter.receive('sí');
    expect(lastReply()).toContain('Borré el estado');

    // Verifica borrado real
    expect((await storage.adhdCoachStore.getMicroTasks('phase2-user')).length).toBe(0);
    expect(await storage.adhdCoachStore.getSilenceUntil('phase2-user')).toBeNull();
  });

  // 6) /abandonar activa anti-abandono (S0.5: turno 1 pide diagnóstico)
  test('/abandonar pide el diagnóstico primero (S0.5)', async () => {
    await adapter.receive('/abandonar');
    expect(lastReply()).toContain('Antes de abandonar, hagamos una pausa');
    // Turno 1: bot lista palabras de diagnóstico, NO letras A/B/C todavía.
    expect(lastReply()).toMatch(/cansancio/);
    expect(lastReply()).toMatch(/miedo/);
    expect(lastReply()).toMatch(/frustraci[oó]n/);
  });

  // 7) "me rindo" (NL) activa anti-abandono
  test('"me rindo" activa anti-abandono, NO crisis', async () => {
    await adapter.receive('me rindo');
    expect(lastReply()).not.toBe(CRISIS_FIXED_MESSAGE);
    expect(lastReply()).toContain('Antes de abandonar');
  });

  test('"me rindo con esta tarea" activa anti-abandono, NO crisis', async () => {
    await adapter.receive('me rindo con esta tarea');
    expect(lastReply()).not.toBe(CRISIS_FIXED_MESSAGE);
    expect(lastReply()).toContain('Antes de abandonar');
  });

  // 8) "no quiero seguir" activa crisis, NO anti-abandono
  test('"no quiero seguir" → crisis, NO anti-abandono', async () => {
    await adapter.receive('no quiero seguir');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
  });

  // 9) /reinicio responde sin culpa
  test('/reinicio responde sin lenguaje de culpa', async () => {
    await adapter.receive('/reinicio');
    const r = lastReply() ?? '';
    expect(r).toContain('Romper una racha no borra lo aprendido');
    for (const w of ['fallaste', 'deberías', 'deberias', 'culpa', 'vergüenza', 'fracaso']) {
      expect(r.toLowerCase()).not.toContain(w);
    }
  });

  test('"rompí la racha" (NL) → reinicio sin culpa', async () => {
    await adapter.receive('rompi la racha');
    expect(lastReply()).toContain('Romper una racha no borra lo aprendido');
  });

  // 10) /agenda invita a volcar
  test('/agenda invita a volcar tareas en bruto', async () => {
    await adapter.receive('/agenda');
    const r = lastReply() ?? '';
    expect(r).toContain('Vamos a ordenar el día');
    expect(r).toContain('bruto');
    for (const cat of ['laboral', 'personal', 'mantenimiento', 'espiritual']) {
      expect(r.toLowerCase()).toContain(cat);
    }
  });

  // 11) Volcado clasifica
  test('Volcado "junta, pagar tarjeta, orar, ejercicio, responder correos" clasifica', async () => {
    await adapter.receive(
      'junta a las 12, pagar tarjeta, orar, hacer ejercicio, responder correos',
    );
    const r = lastReply() ?? '';
    expect(r).toContain('Lo separé así');
    // Formato nuevo (refactor): lista numerada "N. <texto> — <categoría>".
    expect(r).toMatch(/junta.*— laboral/i);
    expect(r).toMatch(/responder correos.*— laboral/i);
    expect(r).toMatch(/pagar tarjeta.*— mantenimiento/i);
    expect(r).toMatch(/orar.*— espiritual/i);
    expect(r).toMatch(/hacer ejercicio.*— personal/i);
    // El refactor pide selección, no "elige 3 importantes y 1 de mantenimiento".
    expect(r).toMatch(/Cu[áa]les eliges/i);
    expect(r).toMatch(/n[úu]meros|todos|repitiendo/i);
  });

  // Bonus: agenda con menos de 3 items NO debe disparar la rule de clasificación
  test('Dump con 2 items no dispara clasificación automática', async () => {
    await adapter.receive('comprar pan, llamar al doctor');
    // No empieza con "Lo separé así"
    expect(lastReply()).not.toContain('Lo separé así');
  });
});
