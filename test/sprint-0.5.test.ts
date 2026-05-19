/**
 * Sprint 0.5 — tests para la clase "pending_input ignorado".
 *
 * Cubre los 6 handlers reescritos para que dejen de ser fachadas vacías:
 *   - /abandonar  (antiAbandono → 2 turnos)
 *   - /reinicio   (restartNoGuilt → 3 turnos)
 *   - cola de /prioriza  (captureFirstStep)
 *   - /oracion    (captureSpiritualAction)
 *   - /devocional (captureDevotionalAction)
 *   - cola de /procrastinacion  (avoidanceChoice)
 *
 * Cada flujo prueba los 5 criterios del contrato:
 *   1. Path feliz
 *   2. Respuesta natural (palabra cuando hay letras)
 *   3. Re-prompt preservando estado si no parsea
 *   4. Abandono por TTL  (cubierto en test/session.ttl.test.ts)
 *   5. Crisis gana siempre  (cubierto en test/crisis.integration.test.ts)
 *
 * Ver docs/contracts/sprint-0.5-pending-input.md.
 */

import { Orchestrator } from '../src/index';
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
  async s(text: string, uid = 's05') {
    if (!this.h) throw new Error('no handler');
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

describe('Sprint 0.5 — pending_input no se evapora', () => {
  let storage: MemoryStorageProvider;
  let adapter: A;
  let domain: AdhdCoachDomainHandler;
  let orch: Orchestrator;
  const user = 's05';

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('s05');
    adapter = new A();
    domain = new AdhdCoachDomainHandler(storage.adhdCoachStore, storage.sessionStore);
    orch = new Orchestrator(adapter, domain, cfg, storage.sessionStore);
    await orch.start();
  });

  afterEach(async () => {
    await orch.stop();
    await storage.disconnect();
  });

  // ── /abandonar ──────────────────────────────────────────────────────────
  describe('/abandonar — 2 turnos', () => {
    test('path feliz natural: "frustración" → ofrece opciones contextuales → "B"', async () => {
      await adapter.s('/abandonar');
      expect(adapter.last()).toMatch(/Antes de abandonar/);
      expect(adapter.last()).toMatch(/cansancio.*miedo.*frustraci/is);

      adapter.reset();
      await adapter.s('Frustración'); // respuesta natural, no letra
      // Turno 2 debe ser específico para frustración (menciona reencuadre).
      expect(adapter.last()).toMatch(/Frustraci[oó]n escuchada/i);
      expect(adapter.last()).toMatch(/reencuadre/i);

      adapter.reset();
      await adapter.s('B'); // 2 minutos de aire
      // Cierre debe mencionar "2 min" o "aire".
      expect(adapter.last()).toMatch(/2\s*min|aire/i);
      // pendingFlowDraft limpio.
      const draft = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(draft).toBeNull();
    });

    test('respuesta natural en turno 2: "cerrar" en vez de "C"', async () => {
      await adapter.s('/abandonar');
      await adapter.s('cansancio');
      adapter.reset();
      await adapter.s('cerrar el día'); // palabra clave, no letra
      expect(adapter.last()).toMatch(/cerrando el d[ií]a/i);
    });

    test('re-prompt si turno 1 no parsea, preservando pending_flow_draft', async () => {
      await adapter.s('/abandonar');
      const before = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(before?.flow).toBe('abandon');
      expect(before?.step).toBe(1);

      adapter.reset();
      await adapter.s('no sé, todo'); // no parsea
      expect(adapter.last()).toMatch(/no alcanc[eé]/i);

      // El draft sigue en step 1 — estado preservado.
      const after = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(after?.flow).toBe('abandon');
      expect(after?.step).toBe(1);

      // Y ahora sí responde bien — el flujo continúa normalmente.
      adapter.reset();
      await adapter.s('cansancio');
      expect(adapter.last()).toMatch(/Cansancio escuchado/i);
    });

    test('re-prompt si turno 2 no parsea, preservando estado', async () => {
      await adapter.s('/abandonar');
      await adapter.s('miedo');
      adapter.reset();
      await adapter.s('no sé'); // no parsea como A/B/C
      expect(adapter.last()).toMatch(/Responde con A, B o C/i);
      // Estado preservado: sigue en step 2 con diagnosis='miedo'.
      const draft = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(draft?.step).toBe(2);
      expect(draft?.answers).toContain('miedo');
    });
  });

  // ── /reinicio ────────────────────────────────────────────────────────────
  describe('/reinicio — 3 turnos', () => {
    test('path feliz: prioridad → acción 2min → cierre', async () => {
      await adapter.s('/reinicio');
      expect(adapter.last()).toMatch(/¿Cu[áa]l es la prioridad/i);

      adapter.reset();
      await adapter.s('terminar la propuesta del cliente');
      expect(adapter.last()).toMatch(/Anotado: "terminar la propuesta/i);
      expect(adapter.last()).toMatch(/2 minutos/i);

      adapter.reset();
      await adapter.s('abrir el documento y leer el último párrafo');
      expect(adapter.last()).toMatch(/Acci[óo]n anotada/i);
      expect(adapter.last()).toMatch(/cierras/i);

      adapter.reset();
      await adapter.s('voy a empezar ya');
      expect(adapter.last()).toMatch(/Reinicio m[ií]nimo registrado/i);
      expect(adapter.last()).toMatch(/Prioridad:.*terminar la propuesta/i);

      const draft = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(draft).toBeNull();
    });

    test('sugiere recordatorio si la acción de 2 min trae marcador de tiempo', async () => {
      await adapter.s('/reinicio');
      await adapter.s('terminar reporte');
      adapter.reset();
      await adapter.s('revisar en 30 min si tengo borrador');
      expect(adapter.last()).toMatch(/marcador de tiempo|recordar/i);
    });

    test('re-prompt si prioridad viene vacía', async () => {
      await adapter.s('/reinicio');
      adapter.reset();
      await adapter.s('a');  // muy corto (<2 chars)
      expect(adapter.last()).toMatch(/necesito una frase/i);
      const draft = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(draft?.step).toBe(1);
    });
  });

  // ── Cola de /prioriza ────────────────────────────────────────────────────
  describe('cola de /prioriza — captureFirstStep', () => {
    test('siguiente acción + respuesta del usuario se registra como first_step', async () => {
      await storage.adhdCoachStore.addMicroTask(user, 'terminar X');
      const tasks = await storage.adhdCoachStore.getMicroTasks(user);
      await storage.adhdCoachStore.setMicroTaskPriorityById(user, tasks[0].id, 'now');

      await adapter.s('/siguiente');
      expect(adapter.last()).toMatch(/Tu siguiente acci[óo]n/i);
      expect(adapter.last()).toMatch(/primer paso peque/i);

      // El draft debe existir tras la cola — el bot está esperando respuesta.
      const before = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(before?.flow).toBe('capture_first_step');
      expect(before?.metadata?.taskText).toBe('terminar X');

      adapter.reset();
      await adapter.s('abrir el archivo y leer el primer párrafo');
      expect(adapter.last()).toMatch(/Anotado como primer paso/i);
      // Cleanup
      const after = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(after).toBeNull();
    });

    test('si la respuesta huele a recordatorio, sugiere /recordar', async () => {
      await storage.adhdCoachStore.addMicroTask(user, 'tarea');
      const tasks = await storage.adhdCoachStore.getMicroTasks(user);
      await storage.adhdCoachStore.setMicroTaskPriorityById(user, tasks[0].id, 'plan');
      await adapter.s('/siguiente');
      adapter.reset();
      await adapter.s('revisar en media hora si ya se secaron los trastes');
      expect(adapter.last()).toMatch(/recordatorio/i);
      expect(adapter.last()).toMatch(/\/recordar/);
    });
  });

  // ── /oracion y /devocional ──────────────────────────────────────────────
  describe('cola de /oracion y /devocional — captura acción espiritual', () => {
    test('/oracion: la respuesta a la pregunta final se registra', async () => {
      await adapter.s('/oracion');
      expect(adapter.last()).toMatch(/acci[óo]n peque/i);
      const draft = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(draft?.flow).toBe('capture_spiritual_action');

      adapter.reset();
      await adapter.s('llamar a mi mamá');
      expect(adapter.last()).toMatch(/Anotado.*llamar a mi/i);
      expect(adapter.last()).toMatch(/microtarea/i);
    });

    test('/devocional: la respuesta a la pregunta se registra', async () => {
      await adapter.s('/devocional');
      const draft = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(draft?.flow).toBe('capture_devotional_action');

      adapter.reset();
      await adapter.s('escribir un párrafo del informe');
      expect(adapter.last()).toMatch(/Anotado.*escribir un p[áa]rrafo/i);
    });
  });

  // ── Cola de /procrastinacion ─────────────────────────────────────────────
  describe('cola de /procrastinacion — opciones A/B/C/D', () => {
    test('A/B/C/D después de declarar la tarea evitada', async () => {
      await adapter.s('/procrastinacion');
      await adapter.s('terminar mi tesis');  // tarea evitada
      // Bot debe ahora ofrecer opciones y estar esperando.
      expect(adapter.last()).toMatch(/A\) abrir el archivo/);
      const draft = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(draft?.flow).toBe('avoidance_choice');
      expect(draft?.metadata?.task).toBe('terminar mi tesis');

      adapter.reset();
      await adapter.s('A');
      expect(adapter.last()).toMatch(/Abre el archivo/);
    });

    test('acepta palabra natural en vez de letra', async () => {
      await adapter.s('/procrastinacion');
      await adapter.s('escribir el reporte');
      adapter.reset();
      await adapter.s('temporizador');  // = C
      expect(adapter.last()).toMatch(/temporizador|\/recordar/i);
    });

    test('re-prompt si la respuesta no parsea, preservando estado', async () => {
      await adapter.s('/procrastinacion');
      await adapter.s('terminar X');
      adapter.reset();
      await adapter.s('no sé qué hacer');
      expect(adapter.last()).toMatch(/Responde con A, B, C o D/);
      const draft = await storage.adhdCoachStore.getPendingFlowDraft(user);
      expect(draft?.flow).toBe('avoidance_choice');
      expect(draft?.metadata?.task).toBe('terminar X');
    });
  });

  // ── Eisenhower copy explícito ─────────────────────────────────────────
  describe('S0.5 paralelo — copy de Eisenhower con rank visible', () => {
    test('/prioriza muestra rank explícito (ALTA, MÁXIMA, etc.) en cada opción', async () => {
      await storage.adhdCoachStore.addMicroTask(user, 'tarea x');
      await adapter.s('/prioriza');
      const msg = adapter.last();
      expect(msg).toMatch(/ALTA/);
      expect(msg).toMatch(/M[ÁA]XIMA/);
      expect(msg).toMatch(/media-baja/);
      expect(msg).toMatch(/Puede esperar/);
    });
  });
});
