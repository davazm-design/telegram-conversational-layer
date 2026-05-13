/**
 * Tests Fase 4.3 — matriz de Eisenhower (/prioriza, /siguiente).
 *
 * Ver docs/eisenhower-contract.md.
 */

import { Orchestrator } from '../src/index';
import { CRISIS_FIXED_MESSAGE } from '../src/security/crisis.detector';
import { AdhdCoachDomainHandler } from '../src/examples/adhd-coach.domain';
import { MemoryStorageProvider } from '../src/core/storage/memory.storage';
import { GenericMessage, GenericResponse, IMessageAdapter } from '../src/core/types';
import { AppConfig } from '../src/core/config';
import { setLogLevel } from '../src/core/logger';

setLogLevel('error');

class A implements IMessageAdapter {
  sent: GenericResponse[] = [];
  h: ((m: GenericMessage) => Promise<void>) | null = null;
  async start(h: (m: GenericMessage) => Promise<void>) { this.h = h; }
  async sendResponse(r: GenericResponse) { this.sent.push(r); }
  async stop() { this.h = null; }
  async s(text: string, uid = 'eis') {
    if (!this.h) throw new Error();
    await this.h({
      id: String(Date.now()) + Math.random(),
      userId: uid, chatId: uid, text,
      timestamp: new Date().toISOString(),
    });
  }
  last() { return this.sent[this.sent.length - 1]?.text ?? ''; }
  reset() { this.sent = []; }
}

const cfg: AppConfig = {
  telegram: { botToken: 'x', mode: 'polling', webhookSecret: '', publicWebhookUrl: '', port: 0 },
  llm: { enabled: false, provider: 'openai', openaiApiKey: '' },
  storage: { provider: 'memory', databaseUrl: '' },
  logLevel: 'error',
};

describe('Fase 4.3 — Eisenhower (/prioriza, /siguiente)', () => {
  let storage: MemoryStorageProvider;
  let adapter: A;
  let domain: AdhdCoachDomainHandler;
  let orch: Orchestrator;
  const user = 'eis';

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('eis');
    adapter = new A();
    domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
    orch = new Orchestrator(adapter, domain, cfg, storage.sessionStore);
    await orch.start();
  });

  afterEach(async () => {
    await orch.stop();
    await storage.disconnect();
  });

  // 1) /prioriza sin microtasks
  test('1) /prioriza sin microtasks → invita a /agenda', async () => {
    await adapter.s('/prioriza');
    expect(adapter.last()).toMatch(/no tienes tareas|empieza con \/agenda/i);
  });

  // 2) /prioriza con 3 microtasks, responder A/B/D
  test('2) /prioriza clasifica A/B/D y guarda prioridades correctas', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'tarea uno');
    await storage.adhdCoachStore.addMicroTask(user, 'tarea dos');
    await storage.adhdCoachStore.addMicroTask(user, 'tarea tres');
    adapter.reset();
    await adapter.s('/prioriza');
    expect(adapter.last()).toMatch(/Urgente.*Importante.*Ambas.*Puede esperar/is);
    expect(adapter.last()).toMatch(/tarea uno.*1\/3/i);

    adapter.reset();
    await adapter.s('A'); // urgente → quick
    expect(adapter.last()).toMatch(/tarea dos.*2\/3/i);

    adapter.reset();
    await adapter.s('B'); // importante → plan
    expect(adapter.last()).toMatch(/tarea tres.*3\/3/i);

    adapter.reset();
    await adapter.s('D'); // puede esperar → later
    expect(adapter.last()).toMatch(/clasificaci[óo]n terminada/i);

    // Verificar persistencia
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks[0].priority).toBe('quick');
    expect(tasks[1].priority).toBe('plan');
    expect(tasks[2].priority).toBe('later');
  });

  // 3) /prioriza con todas ya clasificadas
  test('3) /prioriza con todas ya clasificadas → invita a /siguiente', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'a');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 1, 'now');
    adapter.reset();
    await adapter.s('/prioriza');
    expect(adapter.last()).toMatch(/todas.*clasificadas|usa \/siguiente/i);
  });

  // 4) /siguiente con prioridades mixtas → muestra la "now" primero
  test('4) /siguiente prioriza now > plan > quick > later', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'esperar');
    await storage.adhdCoachStore.addMicroTask(user, 'rápido');
    await storage.adhdCoachStore.addMicroTask(user, 'ahora');
    await storage.adhdCoachStore.addMicroTask(user, 'planear');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 1, 'later');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 2, 'quick');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 3, 'now');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 4, 'plan');
    adapter.reset();
    await adapter.s('/siguiente');
    expect(adapter.last()).toMatch(/tu siguiente acci[óo]n/i);
    expect(adapter.last()).toContain('ahora');
    expect(adapter.last()).toMatch(/\(ahora\)/);
  });

  // 5) /siguiente sin clasificación → invita a /prioriza
  test('5) /siguiente con tareas sin clasificar → invita a /prioriza', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'tarea');
    adapter.reset();
    await adapter.s('/siguiente');
    expect(adapter.last()).toMatch(/sin clasificar|pasa por \/prioriza/i);
  });

  // 6) /siguiente sin nada
  test('6) /siguiente sin tareas → invita a /agenda', async () => {
    await adapter.s('/siguiente');
    expect(adapter.last()).toMatch(/no tienes tareas|empieza con \/agenda/i);
  });

  // 7) /focus con prioridades → marca la siguiente
  test('7) /focus con prioridades destaca "Siguiente"', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'A');
    await storage.adhdCoachStore.addMicroTask(user, 'B');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 1, 'plan');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 2, 'now');
    adapter.reset();
    await adapter.s('/focus');
    const r = adapter.last();
    expect(r).toMatch(/Siguiente.*"B".*\(ahora\)/i);
    // La tarea con prio "now" debe ir marcada con ⭐
    expect(r).toMatch(/2\.\s+B.*⭐|⭐.*2\.\s+B/);
  });

  // 8) /focus sin prioridades → formato simple
  test('8) /focus sin prioridades NO muestra "Siguiente"', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'A');
    await storage.adhdCoachStore.addMicroTask(user, 'B');
    adapter.reset();
    await adapter.s('/focus');
    expect(adapter.last()).not.toMatch(/Siguiente:/i);
    expect(adapter.last()).toContain('A');
    expect(adapter.last()).toContain('B');
  });

  // 9) NL "prioriza mi día"
  test('9) NL "prioriza mi día" → /prioriza', async () => {
    await adapter.s('prioriza mi día');
    expect(adapter.last()).toMatch(/no tienes tareas|Urgente/i);
  });

  // 10) NL "qué tengo que hacer ahora"
  test('10) NL "qué tengo que hacer ahora" → /siguiente', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'algo');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 1, 'now');
    adapter.reset();
    await adapter.s('qué tengo que hacer ahora');
    expect(adapter.last()).toMatch(/tu siguiente acci[óo]n/i);
  });

  // 11) /borrar funciona con priorities
  test('11) /borrar N respeta prioridades existentes', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'A');
    await storage.adhdCoachStore.addMicroTask(user, 'B');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 1, 'now');
    adapter.reset();
    await adapter.s('/borrar 1');
    expect(adapter.last()).toMatch(/Borrada.*A/i);
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks.length).toBe(1);
    expect(tasks[0].text).toBe('B');
  });

  // 12) setMicroTaskPriority persiste
  test('12) setMicroTaskPriority persiste y getMicroTasks lo devuelve', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'tarea');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 1, 'now');
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks[0].priority).toBe('now');
  });

  // 13) crisis durante /prioriza gana
  test('13) crisis durante /prioriza gana sobre el flujo', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'tarea');
    await adapter.s('/prioriza');
    adapter.reset();
    await adapter.s('no quiero seguir');
    expect(adapter.last()).toBe(CRISIS_FIXED_MESSAGE);
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).toBeNull();
  });

  // 14) prioritize_step con respuesta basura → re-prompt
  test('14) /prioriza con respuesta no válida → re-prompt', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'tarea');
    await adapter.s('/prioriza');
    adapter.reset();
    await adapter.s('no sé qué responder');
    expect(adapter.last()).toMatch(/Responde con A, B, C o D/i);
    // pending_input se preserva
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).not.toBeNull();
    expect(pi!.action).toBe('prioritize_step');
  });

  // 15) /prioriza solo procesa las sin prioridad
  test('15) /prioriza skip las ya clasificadas', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'A');
    await storage.adhdCoachStore.addMicroTask(user, 'B');
    await storage.adhdCoachStore.addMicroTask(user, 'C');
    await storage.adhdCoachStore.setMicroTaskPriority(user, 2, 'now');
    adapter.reset();
    await adapter.s('/prioriza');
    // Debe mostrar tarea A (1/2) — solo A y C sin clasificar
    expect(adapter.last()).toMatch(/"A".*1\/2/i);
  });

  // 16) Después de terminar /prioriza se invoca next_action automáticamente
  test('16) tras clasificar todas, sigue con "Tu siguiente acción"', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'única');
    await adapter.s('/prioriza');
    adapter.reset();
    await adapter.s('C'); // ambas → now
    expect(adapter.last()).toMatch(/clasificaci[óo]n terminada/i);
    expect(adapter.last()).toMatch(/tu siguiente acci[óo]n/i);
    expect(adapter.last()).toContain('única');
  });

  // 17) Slash command escapa /prioriza mid-flow
  test('17) /recordatorios durante /prioriza escapa el flujo', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'tarea');
    await adapter.s('/prioriza');
    adapter.reset();
    await adapter.s('/recordatorios');
    expect(adapter.last()).toMatch(/recordatorios pendientes|no tienes recordatorios/i);
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).toBeNull();
  });

  // 18) /help debe mencionar /prioriza y /siguiente
  test('18) /help menciona /prioriza y /siguiente', async () => {
    await adapter.s('/help');
    expect(adapter.last()).toContain('/prioriza');
    expect(adapter.last()).toContain('/siguiente');
  });
});
