/**
 * Tests Fase 3 del dominio adhd-coach:
 *   - Parser de tiempo (relativo/absoluto, "mañana sin hora").
 *   - Capabilities: add_reminder, list_reminders, cancel_reminder.
 *   - Despachador proactivo `tick()`.
 *   - Interacción con /silencio: 1 vencido → envío normal, 2+ → resumen.
 *   - El pre-filter de crisis NO se aplica a envíos proactivos.
 *
 * Solo MemoryStorageProvider; el Postgres es mismo contrato (probado en
 * integración manual con Railway).
 */

import { Orchestrator } from '../src/index';
import {
  parseReminderSpec,
  parseTimeOnly,
  parseTimeForHint,
  AdhdCoachDomainHandler,
} from '../src/examples/adhd-coach.domain';
import {
  GenericMessage,
  GenericResponse,
  IMessageAdapter,
} from '../src/core/types';
import { MemoryStorageProvider } from '../src/core/storage/memory.storage';
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
  async receive(text: string, userId = 'reminders-user'): Promise<void> {
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

// ─── Suite 1: Parser ─────────────────────────────────────────────────────────

/**
 * Extrae los componentes de un Date interpretados en una TZ específica.
 * Hace los tests deterministas sin depender de la TZ del runtime.
 */
function wallInTz(date: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour: parseInt(map.hour === '24' ? '0' : map.hour, 10),
    minute: parseInt(map.minute, 10),
  };
}

describe('parseReminderSpec — tiempos absolutos/relativos (TZ-aware MX)', () => {
  const MX = 'America/Mexico_City';
  // now = 2026-05-12T16:00:00.000Z = 10:00 MX (Mayo, MX en UTC-6, sin DST).
  // Elegido para que: 8am MX ya pasó, 11am/15:00/18:00 MX siguen siendo futuros.
  const now = new Date('2026-05-12T16:00:00.000Z');
  let prevTz: string | undefined;

  beforeAll(() => {
    prevTz = process.env.REMINDER_TZ;
    process.env.REMINDER_TZ = MX;
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.REMINDER_TZ;
    else process.env.REMINDER_TZ = prevTz;
  });

  test('"en 2h tomar agua" → +2h, texto "Tomar agua" (relativo, TZ-independent)', () => {
    const r = parseReminderSpec('en 2h tomar agua', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe('Tomar agua');
      expect(r.dueAt.getTime() - now.getTime()).toBe(2 * 3600_000);
    }
  });

  test('"en 30 min estirar" → +30min', () => {
    const r = parseReminderSpec('en 30 min estirar', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.getTime() - now.getTime()).toBe(30 * 60_000);
      expect(r.text).toBe('Estirar');
    }
  });

  test('"mañana 9am llamar al doctor" → 9am MX mañana (ISO 15:00 UTC)', () => {
    const r = parseReminderSpec('mañana 9am llamar al doctor', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = wallInTz(r.dueAt, MX);
      expect(w).toEqual({ year: 2026, month: 5, day: 13, hour: 9, minute: 0 });
      // En MX (UTC-6, sin DST en mayo): 9am MX = 15:00 UTC.
      expect(r.dueAt.toISOString()).toBe('2026-05-13T15:00:00.000Z');
      expect(r.text).toBe('Llamar al doctor');
    }
  });

  test('"mañana tomar pastilla" SIN hora → tomorrow_needs_hour', () => {
    const r = parseReminderSpec('mañana tomar pastilla', now);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'tomorrow_needs_hour') {
      expect(r.text).toBe('Tomar pastilla');
    }
  });

  test('"hoy 18:00 salir" → 18:00 MX hoy (ISO 00:00 UTC siguiente día)', () => {
    const r = parseReminderSpec('hoy 18:00 salir', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = wallInTz(r.dueAt, MX);
      expect(w).toEqual({ year: 2026, month: 5, day: 12, hour: 18, minute: 0 });
      // 18:00 MX = 24:00 UTC = 00:00 UTC del día siguiente.
      expect(r.dueAt.toISOString()).toBe('2026-05-13T00:00:00.000Z');
      expect(r.text).toBe('Salir');
    }
  });

  test('"15:00 reunión" → 15:00 MX hoy (porque 10:00 MX < 15:00 MX, futuro)', () => {
    const r = parseReminderSpec('15:00 reunion', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = wallInTz(r.dueAt, MX);
      expect(w).toEqual({ year: 2026, month: 5, day: 12, hour: 15, minute: 0 });
      expect(r.dueAt.toISOString()).toBe('2026-05-12T21:00:00.000Z');
    }
  });

  test('"8am leer" cuando ya pasó (en MX) → mañana 8am MX', () => {
    // now = 10:00 MX. 8am MX ya pasó hoy → tomorrow.
    const r = parseReminderSpec('8am leer', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = wallInTz(r.dueAt, MX);
      expect(w).toEqual({ year: 2026, month: 5, day: 13, hour: 8, minute: 0 });
      expect(r.dueAt.toISOString()).toBe('2026-05-13T14:00:00.000Z');
    }
  });

  test('texto vacío → missing_time', () => {
    const r = parseReminderSpec('', now);
    expect(r.ok).toBe(false);
  });

  test('parseTimeOnly("9am", tomorrow) → 9am MX mañana', () => {
    const r = parseTimeOnly('9am', 'tomorrow', now);
    expect(r).not.toBeNull();
    const w = wallInTz(r!, MX);
    expect(w).toEqual({ year: 2026, month: 5, day: 13, hour: 9, minute: 0 });
    expect(r!.toISOString()).toBe('2026-05-13T15:00:00.000Z');
  });

  test('parseTimeOnly("a las 15:30", today) → 15:30 MX hoy', () => {
    const r = parseTimeOnly('a las 15:30', 'today', now);
    expect(r).not.toBeNull();
    const w = wallInTz(r!, MX);
    expect(w).toEqual({ year: 2026, month: 5, day: 12, hour: 15, minute: 30 });
    expect(r!.toISOString()).toBe('2026-05-12T21:30:00.000Z');
  });

  test('parseTimeOnly("xyz") → null', () => {
    const r = parseTimeOnly('xyz', 'today', now);
    expect(r).toBeNull();
  });

  // ── Regresión bug producción (screenshot del usuario) ───────────────────
  test('regresión TZ prod: "mañana 11am ir con Manuel" → 11am MX, NO 11am UTC', () => {
    const r = parseReminderSpec('mañana 11am ir con Manuel', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = wallInTz(r.dueAt, MX);
      expect(w.hour).toBe(11);
      expect(w.minute).toBe(0);
      // 11am MX = 17:00 UTC. ANTES del fix: el bot guardaba 11:00 UTC y
      // mostraba 05:00 MX (lo del screenshot). Después del fix: 17:00 UTC,
      // se ve como 11:00 MX en /recordatorios.
      expect(r.dueAt.toISOString()).toBe('2026-05-13T17:00:00.000Z');
    }
  });

  // ── Fechas naturales en español (nueva expansión del parser) ────────────
  // now = 2026-05-12T16:00:00.000Z = martes 10:00 MX.

  test('"pasado mañana 10:30am ir al pediatra" → 10:30 MX +2d', () => {
    const r = parseReminderSpec('pasado mañana 10:30am ir al pediatra', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = wallInTz(r.dueAt, MX);
      expect(w).toEqual({ year: 2026, month: 5, day: 14, hour: 10, minute: 30 });
      expect(r.dueAt.toISOString()).toBe('2026-05-14T16:30:00.000Z');
      expect(r.text).toBe('Ir al pediatra');
    }
  });

  test('"pasado mañana a las 10:30 ir al pediatra" → +2d con prefijo "a las"', () => {
    const r = parseReminderSpec('pasado mañana a las 10:30 ir al pediatra', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.toISOString()).toBe('2026-05-14T16:30:00.000Z');
    }
  });

  test('"pasado mañana ir al pediatra" SIN hora → date_needs_hour con dayHint=date:YYYY-MM-DD', () => {
    const r = parseReminderSpec('pasado mañana ir al pediatra', now);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'date_needs_hour') {
      expect(r.text).toBe('Ir al pediatra');
      expect(r.dayHint).toBe('date:2026-05-14');
    }
  });

  test('"jueves 10:30am ir al pediatra" → próximo jueves futuro (May 14)', () => {
    // martes May 12 + 2d = jueves May 14
    const r = parseReminderSpec('jueves 10:30am ir al pediatra', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = wallInTz(r.dueAt, MX);
      expect(w).toEqual({ year: 2026, month: 5, day: 14, hour: 10, minute: 30 });
      expect(r.dueAt.toISOString()).toBe('2026-05-14T16:30:00.000Z');
    }
  });

  test('"el jueves a las 10:30 ir con doctor" → próximo jueves 10:30 MX', () => {
    const r = parseReminderSpec('el jueves a las 10:30 ir con doctor', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.toISOString()).toBe('2026-05-14T16:30:00.000Z');
      expect(r.text).toBe('Ir con doctor');
    }
  });

  test('"jueves ir al pediatra" SIN hora → date_needs_hour con dayHint=dow:4', () => {
    const r = parseReminderSpec('jueves ir al pediatra', now);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'date_needs_hour') {
      expect(r.text).toBe('Ir al pediatra');
      expect(r.dayHint).toBe('dow:4');
    }
  });

  test('"jueves 14 de mayo 10:30am ir al pediatra" → fecha explícita', () => {
    const r = parseReminderSpec('jueves 14 de mayo 10:30am ir al pediatra', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.toISOString()).toBe('2026-05-14T16:30:00.000Z');
      expect(r.text).toBe('Ir al pediatra');
    }
  });

  test('"el jueves 14 de mayo a las 10:30am ir con doctor"', () => {
    const r = parseReminderSpec('el jueves 14 de mayo a las 10:30am ir con doctor', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.toISOString()).toBe('2026-05-14T16:30:00.000Z');
      expect(r.text).toBe('Ir con doctor');
    }
  });

  test('"14/05 10:30 ir al pediatra" → 14 mayo (año actual si futuro)', () => {
    const r = parseReminderSpec('14/05 10:30 ir al pediatra', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.toISOString()).toBe('2026-05-14T16:30:00.000Z');
    }
  });

  test('"14-05 10:30 ir al pediatra" → guion también funciona', () => {
    const r = parseReminderSpec('14-05 10:30 ir al pediatra', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.toISOString()).toBe('2026-05-14T16:30:00.000Z');
    }
  });

  test('"14/05 ir al pediatra" SIN hora → date_needs_hour', () => {
    const r = parseReminderSpec('14/05 ir al pediatra', now);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'date_needs_hour') {
      expect(r.text).toBe('Ir al pediatra');
      expect(r.dayHint).toBe('date:2026-05-14');
    }
  });

  test('"01/03 ir al pediatra" → marzo ya pasó → próximo año (2027)', () => {
    const r = parseReminderSpec('01/03 10:30 ir al pediatra', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 1 marzo 2027 10:30 MX = 1 marzo 2027 16:30 UTC
      expect(r.dueAt.toISOString()).toBe('2027-03-01T16:30:00.000Z');
    }
  });

  test('"2026-05-14 10:30 ir al pediatra" → ISO directo, hora local MX', () => {
    const r = parseReminderSpec('2026-05-14 10:30 ir al pediatra', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.toISOString()).toBe('2026-05-14T16:30:00.000Z');
    }
  });

  test('"2026-02-30 10:30 inválido" → null (fecha inexistente)', () => {
    const r = parseReminderSpec('2026-02-30 10:30 invalido', now);
    expect(r.ok).toBe(false);
  });

  test('parseTimeForHint con "date:2026-05-14" y "9am" → ISO 15:00 UTC', () => {
    const r = parseTimeForHint('9am', 'date:2026-05-14', now);
    expect(r).not.toBeNull();
    expect(r!.toISOString()).toBe('2026-05-14T15:00:00.000Z');
  });

  test('parseTimeForHint con "dow:4" (jueves) y "9am" en martes → próximo jueves 9am', () => {
    const r = parseTimeForHint('9am', 'dow:4', now);
    expect(r).not.toBeNull();
    // martes May 12 → jueves May 14 9am MX = 15:00 UTC
    expect(r!.toISOString()).toBe('2026-05-14T15:00:00.000Z');
  });
});

// ─── Suite 2: Capabilities (add/list/cancel) ─────────────────────────────────

describe('Capabilities Fase 3 — add/list/cancel', () => {
  let storage: MemoryStorageProvider;
  let adapter: MockAdapter;
  let domain: AdhdCoachDomainHandler;
  let orch: Orchestrator;
  const user = 'reminders-user';

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('reminders-test');
    adapter = new MockAdapter();
    domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
    orch = new Orchestrator(adapter, domain, testConfig(), storage.sessionStore);
    await orch.start();
  });

  afterEach(async () => {
    await orch.stop();
    await storage.disconnect();
  });

  const lastReply = () => adapter.sentResponses[adapter.sentResponses.length - 1]?.text ?? '';

  test('/recordar en 1h tomar agua → crea recordatorio', async () => {
    await adapter.receive('/recordar en 1h tomar agua');
    expect(lastReply()).toMatch(/recordatorio guardado|recordatorio programado/i);
    expect(lastReply()).toContain('Tomar agua');

    const list = await storage.adhdCoachStore.listReminders(user);
    expect(list.length).toBe(1);
    expect(list[0].text).toBe('Tomar agua');
  });

  test('/recordar mañana llamar (sin hora) → guarda draft y pide hora', async () => {
    await adapter.receive('/recordar mañana llamar');
    expect(lastReply()).toMatch(/A qué hora mañana/i);

    const draft = await storage.adhdCoachStore.getPendingReminderDraft(user);
    expect(draft).not.toBeNull();
    expect(draft!.text).toBe('Llamar');
    expect(draft!.dayHint).toBe('tomorrow');

    // No debe haber recordatorios todavía
    const list = await storage.adhdCoachStore.listReminders(user);
    expect(list.length).toBe(0);

    // Usuario responde con hora → completa el recordatorio
    adapter.reset();
    await adapter.receive('9am');
    expect(lastReply()).toMatch(/te recuerdo "Llamar"/i);

    const list2 = await storage.adhdCoachStore.listReminders(user);
    expect(list2.length).toBe(1);
    expect(list2[0].text).toBe('Llamar');

    // Draft consumido
    const draft2 = await storage.adhdCoachStore.getPendingReminderDraft(user);
    expect(draft2).toBeNull();
  });

  test('/recordatorios → lista pendientes', async () => {
    await adapter.receive('/recordar en 1h tomar agua');
    await adapter.receive('/recordar en 2h estirar');
    adapter.reset();
    await adapter.receive('/recordatorios');
    expect(lastReply()).toMatch(/recordatorios pendientes/i);
    expect(lastReply()).toContain('Tomar agua');
    expect(lastReply()).toContain('Estirar');
  });

  test('/cancelar_recordatorio 1 cancela el primero', async () => {
    await adapter.receive('/recordar en 1h tomar agua');
    await adapter.receive('/recordar en 2h estirar');
    adapter.reset();
    await adapter.receive('/cancelar_recordatorio 1');
    expect(lastReply()).toMatch(/Cancelado/);

    const list = await storage.adhdCoachStore.listReminders(user);
    expect(list.length).toBe(1);
    // El que queda debe ser "Estirar"
    expect(list[0].text).toBe('Estirar');
  });

  test('/cancelar_recordatorio 99 → error claro', async () => {
    await adapter.receive('/recordar en 1h tomar agua');
    adapter.reset();
    await adapter.receive('/cancelar_recordatorio 99');
    expect(lastReply()).toMatch(/No encontré/i);
  });

  test('/recordar sin args → orquestador pide el spec via pending_input', async () => {
    await adapter.receive('/recordar');
    // El orquestador detecta param requerido "spec" vacío y emite prompt.
    expect(lastReply()).toMatch(/cuál es|cuál|qué/i);
  });

  // ── Regresión reportada: tras completar draft con hora, /recordatorios
  //    debe seguir respondiendo (estado pendiente correctamente limpiado).
  test('regresión: /recordatorios funciona tras completar draft con hora (8am)', async () => {
    await adapter.receive('/recordar mañana llamar al doctor');
    expect(lastReply()).toMatch(/A qué hora mañana/i);

    adapter.reset();
    await adapter.receive('8am');
    expect(lastReply()).toMatch(/te recuerdo "Llamar al doctor"/i);

    // Estado pendiente debe estar limpio
    const draft = await storage.adhdCoachStore.getPendingReminderDraft(user);
    expect(draft).toBeNull();
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).toBeNull();
    const pa = await storage.sessionStore.getPendingAction(user);
    expect(pa).toBeNull();

    adapter.reset();
    await adapter.receive('/recordatorios');
    expect(lastReply()).toContain('Llamar al doctor');
    expect(lastReply()).toMatch(/recordatorios pendientes/i);
  });

  test('regresión: /cancel limpia draft y /recordatorios vuelve a responder', async () => {
    await adapter.receive('/recordar mañana llamar al doctor');
    expect(lastReply()).toMatch(/A qué hora mañana/i);

    adapter.reset();
    await adapter.receive('/cancel');
    // El orchestrator solo limpia pending_input/pending_action; el draft del
    // dominio NO se limpia con /cancel — pero /recordatorios debe responder
    // igualmente porque el draft no bloquea slash commands.
    adapter.reset();
    await adapter.receive('/recordatorios');
    expect(lastReply()).toMatch(/recordatorios pendientes|No tienes recordatorios/i);
  });

  test('regresión: slash commands tienen prioridad sobre draft pendiente', async () => {
    // Si hay un draft pendiente y el usuario manda un slash command, el
    // comando debe ejecutarse normalmente (no debe ser tragado por el draft).
    await adapter.receive('/recordar mañana llamar al doctor');
    expect(lastReply()).toMatch(/A qué hora mañana/i);

    adapter.reset();
    await adapter.receive('/recordatorios');
    // El draft sigue ahí (no se ha completado), pero /recordatorios
    // debe responder. La lista estará vacía (aún no se creó el recordatorio).
    expect(lastReply()).toMatch(/recordatorios pendientes|No tienes recordatorios/i);
  });

  test('regresión: pending_input persistido NO traga slash commands', async () => {
    // Simula el caso producción: pending_input quedó persistido en la sesión
    // (p.ej. de un reinicio anterior con Postgres). El siguiente /recordatorios
    // debe ejecutarse normalmente, NO ser consumido como valor del pending.
    await storage.sessionStore.setPendingInput(user, {
      action: 'add_micro_task',
      paramName: 'text',
      prompt: 'fake-prompt',
    });

    await adapter.receive('/recordatorios');
    // Debe responder como list_reminders, NO como add_micro_task con
    // text="/recordatorios".
    expect(lastReply()).toMatch(/No tienes recordatorios|recordatorios pendientes/i);

    // El pending_input debe quedar limpio tras el escape.
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).toBeNull();
  });

  test('regresión: pending_input persistido SÍ traga texto plano (comportamiento original)', async () => {
    // Para que el escape de slash commands sea quirúrgico: el texto plano
    // (no-slash) SIGUE siendo consumido como valor del pending. Esto
    // preserva el flujo "agregar microtarea" → "revisar correo".
    await storage.sessionStore.setPendingInput(user, {
      action: 'add_micro_task',
      paramName: 'text',
      prompt: 'fake-prompt',
    });

    await adapter.receive('revisar correo');
    expect(lastReply()).toMatch(/Micro-tarea agregada/);

    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).toBeNull();
  });

  // ─── Regresión producción: /recordatorios mudo cuando hay pendientes ──
  // Causa raíz: legacy Markdown rompía con "_Cancela uno con /cancelar_recordatorio_"
  // (underscore del slash command rompe pareo de cursiva). El adapter de
  // Telegram tragaba el HTTP 400 silenciosamente. Fix: salida sin markdown
  // riesgoso + escape defensivo + try/catch.

  test('regresión prod: /recordar + hora → /privacidad cuenta > 0 → /recordatorios lista', async () => {
    await adapter.receive('/recordar mañana llamar al doctor');
    expect(lastReply()).toMatch(/A qué hora mañana/i);
    adapter.reset();
    await adapter.receive('9');
    expect(lastReply()).toMatch(/te recuerdo "Llamar al doctor"/i);

    // /privacidad refleja el conteo
    adapter.reset();
    await adapter.receive('/privacidad');
    expect(lastReply()).toMatch(/Recordatorios programados: 1 pendiente/);

    // /recordatorios SÍ responde con id + texto + fecha
    adapter.reset();
    await adapter.receive('/recordatorios');
    const r = lastReply();
    expect(r).toMatch(/Tus recordatorios pendientes/);
    expect(r).toContain('1.');
    expect(r).toContain('Llamar al doctor');
    // Fecha local renderizada (no la cadena "fecha no disponible")
    expect(r).not.toContain('fecha no disponible');
    // Salida sin markdown riesgoso que rompa Telegram
    expect(r).not.toContain('*');
    expect(r).not.toMatch(/(^|[^\\])_/m); // sin underscores sin escapar
  });

  test('regresión prod: 2 recordatorios pendientes → /recordatorios lista ambos', async () => {
    await adapter.receive('/recordar en 1h tomar agua');
    await adapter.receive('/recordar en 2h estirar');
    adapter.reset();
    await adapter.receive('/recordatorios');
    const r = lastReply();
    expect(r).toMatch(/Tus recordatorios pendientes/);
    expect(r).toContain('1.');
    expect(r).toContain('2.');
    expect(r).toContain('Tomar agua');
    expect(r).toContain('Estirar');
  });

  test('regresión prod: dueAt inválido/null → "fecha no disponible", no se queda mudo', async () => {
    // Sembramos directamente un recordatorio con dueAt corrupto, saltándonos
    // el handler para simular datos en mal estado en producción.
    await storage.adhdCoachStore.addReminder(user, 'Reminder bueno', new Date(Date.now() + 3600_000).toISOString());
    // Inyectar uno corrupto via API interna del Map (workaround para test)
    // Como Memory store no expone setter para date inválido, manipulamos via
    // un store wrapper: aquí usamos un trick simple — corromper el ISO
    // pasando una cadena obviamente inválida.
    await storage.adhdCoachStore.addReminder(user, 'Reminder roto', 'no-es-fecha');

    adapter.reset();
    await adapter.receive('/recordatorios');
    const r = lastReply();
    expect(r).toMatch(/Tus recordatorios pendientes/);
    expect(r).toContain('Reminder bueno');
    expect(r).toContain('Reminder roto');
    expect(r).toContain('fecha no disponible');
  });

  test('regresión prod: si store.listReminders lanza, responde mensaje claro (no mudo)', async () => {
    // Reemplazamos temporalmente listReminders por una versión que lanza.
    const origList = storage.adhdCoachStore.listReminders.bind(storage.adhdCoachStore);
    (storage.adhdCoachStore as { listReminders: typeof origList }).listReminders =
      (async () => { throw new Error('boom'); }) as typeof origList;

    try {
      adapter.reset();
      await adapter.receive('/recordatorios');
      expect(lastReply()).toMatch(/No pude listar tus recordatorios/);
    } finally {
      (storage.adhdCoachStore as { listReminders: typeof origList }).listReminders = origList;
    }
  });

  test('regresión prod: texto con underscores se escapa y NO rompe el render', async () => {
    // Caso clásico de Markdown v1 roto: texto con un solo underscore.
    await storage.adhdCoachStore.addReminder(user, 'maria_perez confirmar', new Date(Date.now() + 3600_000).toISOString());

    adapter.reset();
    await adapter.receive('/recordatorios');
    const r = lastReply();
    expect(r).toMatch(/Tus recordatorios pendientes/);
    // El texto del usuario aparece, con su underscore escapado para
    // sobrevivir a Markdown v1.
    expect(r).toMatch(/maria\\_perez confirmar/);
  });

  // ── Fechas naturales — flujo completo via /recordar ─────────────────────
  // Estas pruebas usan Date.now() real, así que solo verifican estructura
  // (mensaje y persistencia), no fecha exacta. Las pruebas de TZ exacta
  // viven en la suite del parser arriba con `now` fijo.

  test('/recordar pasado mañana 10:30am ir al pediatra → crea recordatorio', async () => {
    await adapter.receive('/recordar pasado mañana 10:30am ir al pediatra');
    expect(lastReply()).toMatch(/recordatorio guardado|recordatorio programado/i);
    expect(lastReply()).toContain('Ir al pediatra');
    const list = await storage.adhdCoachStore.listReminders(user);
    expect(list.length).toBe(1);
    expect(list[0].text).toBe('Ir al pediatra');
  });

  test('/recordar pasado mañana ir al pediatra (sin hora) → pide hora, no crea', async () => {
    await adapter.receive('/recordar pasado mañana ir al pediatra');
    expect(lastReply()).toMatch(/A qué hora quieres que te lo recuerde ese día/i);
    const list = await storage.adhdCoachStore.listReminders(user);
    expect(list.length).toBe(0);
    const draft = await storage.adhdCoachStore.getPendingReminderDraft(user);
    expect(draft).not.toBeNull();
    expect(draft!.text).toBe('Ir al pediatra');
    expect(draft!.dayHint).toMatch(/^date:\d{4}-\d{2}-\d{2}$/);

    // Completa con "9am" → crea recordatorio para esa fecha
    adapter.reset();
    await adapter.receive('9am');
    expect(lastReply()).toMatch(/te recuerdo "Ir al pediatra"/i);
    const list2 = await storage.adhdCoachStore.listReminders(user);
    expect(list2.length).toBe(1);
  });

  test('/recordar jueves ir al pediatra (sin hora) → pide hora con draft dow:N', async () => {
    await adapter.receive('/recordar jueves ir al pediatra');
    expect(lastReply()).toMatch(/A qué hora quieres que te lo recuerde ese día/i);
    const draft = await storage.adhdCoachStore.getPendingReminderDraft(user);
    expect(draft).not.toBeNull();
    expect(draft!.dayHint).toMatch(/^dow:[0-6]$/);

    adapter.reset();
    await adapter.receive('9am');
    expect(lastReply()).toMatch(/te recuerdo "Ir al pediatra"/i);
  });

  test('/recordar 14/05 ir al pediatra (sin hora) → pide hora, completa con 9am', async () => {
    await adapter.receive('/recordar 14/05 ir al pediatra');
    expect(lastReply()).toMatch(/A qué hora quieres que te lo recuerde ese día/i);
    const draft = await storage.adhdCoachStore.getPendingReminderDraft(user);
    expect(draft!.dayHint).toMatch(/^date:\d{4}-05-14$/);

    adapter.reset();
    await adapter.receive('9am');
    expect(lastReply()).toMatch(/te recuerdo "Ir al pediatra"/i);
    expect(lastReply()).not.toMatch(/T\d{2}:\d{2}:\d{2}/); // sin ISO crudo
  });

  test('/recordar 2026-05-14 10:30 ir al pediatra → crea recordatorio', async () => {
    await adapter.receive('/recordar 2026-05-14 10:30 ir al pediatra');
    expect(lastReply()).toMatch(/recordatorio guardado|recordatorio programado/i);
    expect(lastReply()).toContain('Ir al pediatra');
  });

  test('fallback de error actualizado menciona los nuevos formatos', async () => {
    await adapter.receive('/recordar texto basura sin tiempo');
    const r = lastReply();
    expect(r).toMatch(/No entendí el tiempo/);
    expect(r).toMatch(/pasado mañana/);
    expect(r).toMatch(/jueves/);
    expect(r).toMatch(/14\/05|dd\/mm/);
  });

  // ─── Regresión prod: la confirmación de add NO debe ser muda ────────
  test('regresión prod: confirmación de /recordar es Markdown-safe (visible)', async () => {
    await adapter.receive('/recordar en 1h tomar agua');
    const r = lastReply();
    expect(r).toMatch(/recordatorio guardado|recordatorio programado/i);
    expect(r).toContain('Tomar agua');
    // El Markdown legacy de Telegram NO procesa "\_". La única forma segura
    // es NO incluir "_" en absoluto (escapado o no). Lo mismo para asterisco
    // suelto y backticks. Si esto se rompe, Telegram devuelve 400 y el
    // adapter traga el mensaje → bot mudo en producción.
    expect(r).not.toMatch(/_/);
    expect(r.match(/\*/g)?.length ?? 0).toBe(0);
    expect(r.match(/`/g)?.length ?? 0).toBe(0);
    // Tampoco debe contener el slash command que el bug anterior incluía.
    expect(r).not.toMatch(/cancelar_recordatorio/);
    expect(r).not.toMatch(/cancelar\\_recordatorio/);
  });

  test('regresión prod: confirmación tras completar draft es Markdown-safe', async () => {
    await adapter.receive('/recordar mañana llamar a maria_perez');
    adapter.reset();
    await adapter.receive('9am');
    const r = lastReply();
    expect(r).toMatch(/te recuerdo/i);
    // El texto del usuario tenía un "_": debe estar escapado.
    expect(r).toContain('maria\\_perez');
    const unescapedUnderscore = /(^|[^\\])_/m;
    expect(r).not.toMatch(unescapedUnderscore);
  });

  test('regresión prod: cancelar recordatorio con "_" en texto NO se queda mudo', async () => {
    await storage.adhdCoachStore.addReminder(user, 'pagar luz_2024', new Date(Date.now() + 3600_000).toISOString());
    adapter.reset();
    await adapter.receive('/cancelar_recordatorio 1');
    const r = lastReply();
    expect(r).toMatch(/Cancelado/);
    expect(r).toContain('luz\\_2024');
  });

  test('fechas se muestran en hora LOCAL, nunca como ISO UTC crudo', async () => {
    await adapter.receive('/recordar en 1h tomar agua');
    const r = lastReply();
    expect(r).not.toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(r).not.toMatch(/T\d{2}:\d{2}:\d{2}Z/);
    // Debe contener un formato local DD/MM/YYYY, HH:MM o similar
    expect(r).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });
});

// ─── Suite 3: Tick dispatcher + silencio ─────────────────────────────────────

describe('Tick dispatcher — envío proactivo + silencio', () => {
  let storage: MemoryStorageProvider;
  let domain: AdhdCoachDomainHandler;
  const user = 'tick-user';

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('tick-test');
    domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
  });

  afterEach(async () => {
    await storage.disconnect();
  });

  test('1 vencido sin silencio → envío normal y marca done', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await storage.adhdCoachStore.addReminder(user, 'Tomar agua', past);

    const sent: Array<{ userId: string; text: string }> = [];
    const send = async (uid: string, text: string) => { sent.push({ userId: uid, text }); };

    await domain.tick(send);

    expect(sent.length).toBe(1);
    expect(sent[0].userId).toBe(user);
    expect(sent[0].text).toContain('Tomar agua');
    expect(sent[0].text).toMatch(/Recordatorio/);

    const stillPending = await storage.adhdCoachStore.listReminders(user);
    expect(stillPending.length).toBe(0);
  });

  test('2+ vencidos sin silencio → resumen (no avalancha)', async () => {
    const past1 = new Date(Date.now() - 120_000).toISOString();
    const past2 = new Date(Date.now() - 90_000).toISOString();
    await storage.adhdCoachStore.addReminder(user, 'Tomar agua', past1);
    await storage.adhdCoachStore.addReminder(user, 'Estirar', past2);

    const sent: Array<{ userId: string; text: string }> = [];
    const send = async (uid: string, text: string) => { sent.push({ userId: uid, text }); };

    await domain.tick(send);

    // Solo UN mensaje (resumen), NO uno por recordatorio
    expect(sent.length).toBe(1);
    expect(sent[0].text).toMatch(/acumulados/i);
    expect(sent[0].text).toMatch(/verlos/);

    // Ambos marcados como entregados (no quedan pendientes)
    const stillPending = await storage.adhdCoachStore.listReminders(user);
    expect(stillPending.length).toBe(0);

    // Hay summary que mostrar a "verlos"
    const summary = await storage.adhdCoachStore.getPendingOverdueSummary(user);
    expect(summary).not.toBeNull();
    expect(summary!.reminderIds.length).toBe(2);
  });

  test('silencio activo → recordatorio vencido se pospone, NO se envía', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await storage.adhdCoachStore.addReminder(user, 'Tomar agua', past);

    // Silencio por 1 hora más
    const silenceUntil = new Date(Date.now() + 3600_000).toISOString();
    await storage.adhdCoachStore.setSilenceUntil(user, silenceUntil);

    const sent: Array<{ userId: string; text: string }> = [];
    const send = async (uid: string, text: string) => { sent.push({ userId: uid, text }); };

    await domain.tick(send);

    // NO se envió nada
    expect(sent.length).toBe(0);

    // El recordatorio sigue pendiente pero con dueAt > silenceUntil
    const list = await storage.adhdCoachStore.listReminders(user);
    expect(list.length).toBe(1);
    expect(new Date(list[0].dueAt).getTime()).toBeGreaterThan(new Date(silenceUntil).getTime());

    // Está acumulado en overdue_summary
    const summary = await storage.adhdCoachStore.getPendingOverdueSummary(user);
    expect(summary).not.toBeNull();
    expect(summary!.reminderIds.length).toBe(1);
  });

  test('silencio termina con 1 recordatorio acumulado → envío normal', async () => {
    // Crear un recordatorio que ya estaba acumulado durante silencio
    // (simulamos lo que pasa cuando silencio termina y queda 1 solo vencido)
    const past = new Date(Date.now() - 1000).toISOString();
    await storage.adhdCoachStore.addReminder(user, 'Único pendiente', past);
    // NO marcar overdue_summary previo (= solo 1 vencido en total)

    const sent: Array<{ userId: string; text: string }> = [];
    const send = async (uid: string, text: string) => { sent.push({ userId: uid, text }); };

    await domain.tick(send);

    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Único pendiente');
    expect(sent[0].text).toMatch(/Recordatorio/);
  });

  test('múltiples usuarios → cada uno recibe los suyos', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await storage.adhdCoachStore.addReminder('user-a', 'A1', past);
    await storage.adhdCoachStore.addReminder('user-b', 'B1', past);

    const sent: Array<{ userId: string; text: string }> = [];
    const send = async (uid: string, text: string) => { sent.push({ userId: uid, text }); };

    await domain.tick(send);

    expect(sent.length).toBe(2);
    const a = sent.find((s) => s.userId === 'user-a');
    const b = sent.find((s) => s.userId === 'user-b');
    expect(a?.text).toContain('A1');
    expect(b?.text).toContain('B1');
  });

  test('no hay vencidos → no envía nada', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    await storage.adhdCoachStore.addReminder(user, 'Futuro', future);

    const sent: Array<{ userId: string; text: string }> = [];
    const send = async (uid: string, text: string) => { sent.push({ userId: uid, text }); };

    await domain.tick(send);
    expect(sent.length).toBe(0);
  });
});

// ─── Suite 4: Show overdue + interacción "verlos" ────────────────────────────

describe('show_overdue_reminders — flujo de "verlos"', () => {
  let storage: MemoryStorageProvider;
  let adapter: MockAdapter;
  let domain: AdhdCoachDomainHandler;
  let orch: Orchestrator;
  const user = 'reminders-user';

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('overdue-test');
    adapter = new MockAdapter();
    domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
    orch = new Orchestrator(adapter, domain, testConfig(), storage.sessionStore);
    await orch.start();
  });

  afterEach(async () => {
    await orch.stop();
    await storage.disconnect();
  });

  const lastReply = () => adapter.sentResponses[adapter.sentResponses.length - 1]?.text ?? '';

  test('"verlos" sin summary previo → mensaje informativo (no rompe)', async () => {
    await adapter.receive('verlos');
    // Sin summary previo: el handler informa que no hay acumulados.
    expect(lastReply()).toMatch(/No hay recordatorios acumulados/i);
  });

  test('tras 2+ vencidos, "verlos" muestra resumen y limpia el summary', async () => {
    // Sembrar 2 vencidos
    const past1 = new Date(Date.now() - 120_000).toISOString();
    const past2 = new Date(Date.now() - 60_000).toISOString();
    await storage.adhdCoachStore.addReminder(user, 'Tomar agua', past1);
    await storage.adhdCoachStore.addReminder(user, 'Estirar', past2);

    // Ejecutar tick directamente para no depender de timers reales
    await domain.tick(async (uid, text) => {
      // Simular envío externo (lo que normalmente hace orchestrator.sendProactive)
      void uid; void text;
    });

    // Ahora el usuario pide verlos
    await adapter.receive('verlos');
    expect(lastReply()).toMatch(/acumulados/i);

    // Summary debe estar limpio tras ver
    const summary = await storage.adhdCoachStore.getPendingOverdueSummary(user);
    expect(summary).toBeNull();
  });

  test('/ver_recordatorios (comando) funciona igual que "verlos"', async () => {
    await adapter.receive('/ver_recordatorios');
    expect(lastReply()).toMatch(/No hay recordatorios acumulados/i);
  });
});
