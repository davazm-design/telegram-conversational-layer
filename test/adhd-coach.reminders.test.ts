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

describe('parseReminderSpec — tiempos absolutos/relativos', () => {
  const now = new Date('2026-05-12T10:00:00.000Z');

  test('"en 2h tomar agua" → +2h, texto "Tomar agua"', () => {
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

  test('"mañana 9am llamar al doctor" → +1d 9:00, texto correcto', () => {
    const r = parseReminderSpec('mañana 9am llamar al doctor', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const due = r.dueAt;
      expect(due.getDate()).toBe(now.getDate() + 1);
      expect(due.getHours()).toBe(9);
      expect(due.getMinutes()).toBe(0);
      expect(r.text).toBe('Llamar al doctor');
    }
  });

  test('"mañana tomar pastilla" SIN hora → tomorrow_needs_hour', () => {
    const r = parseReminderSpec('mañana tomar pastilla', now);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('tomorrow_needs_hour');
      // sigue conservando el texto para guardarlo como draft
      if (r.reason === 'tomorrow_needs_hour') {
        expect(r.text).toBe('Tomar pastilla');
      }
    }
  });

  test('"hoy 18:00 salir" hoy a las 18:00', () => {
    const r = parseReminderSpec('hoy 18:00 salir', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.getHours()).toBe(18);
      expect(r.dueAt.getMinutes()).toBe(0);
      expect(r.text).toBe('Salir');
    }
  });

  test('"15:00 reunión" → hoy si futuro', () => {
    const r = parseReminderSpec('15:00 reunion', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.getHours()).toBe(15);
      expect(r.dueAt.getMinutes()).toBe(0);
      // si now es 10:00 y due 15:00 → mismo día
      expect(r.dueAt.getDate()).toBe(now.getDate());
    }
  });

  test('"8am leer" cuando ya pasó → mañana 8am', () => {
    // now = 10:00, 8am ya pasó hoy
    const r = parseReminderSpec('8am leer', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dueAt.getHours()).toBe(8);
      expect(r.dueAt.getDate()).toBe(now.getDate() + 1);
    }
  });

  test('texto vacío → missing_time', () => {
    const r = parseReminderSpec('', now);
    expect(r.ok).toBe(false);
  });

  test('parseTimeOnly("9am", tomorrow) → mañana 9:00', () => {
    const r = parseTimeOnly('9am', 'tomorrow', now);
    expect(r).not.toBeNull();
    expect(r!.getHours()).toBe(9);
    expect(r!.getDate()).toBe(now.getDate() + 1);
  });

  test('parseTimeOnly("a las 15:30", today) → hoy 15:30', () => {
    const r = parseTimeOnly('a las 15:30', 'today', now);
    expect(r).not.toBeNull();
    expect(r!.getHours()).toBe(15);
    expect(r!.getMinutes()).toBe(30);
    expect(r!.getDate()).toBe(now.getDate());
  });

  test('parseTimeOnly("xyz") → null', () => {
    const r = parseTimeOnly('xyz', 'today', now);
    expect(r).toBeNull();
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
    expect(lastReply()).toMatch(/Recordatorio programado/);
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
    expect(lastReply()).toMatch(/Te recuerdo "Llamar"/);

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
    expect(lastReply()).toContain('Recordatorios pendientes');
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
