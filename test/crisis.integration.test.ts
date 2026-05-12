/**
 * Integration tests del pre-filter de crisis en el Orchestrator.
 *
 * Estos tests son TRANSVERSALES al dominio: verifican que el pre-filter
 * fuera del dominio se ejecuta antes que pending_input/pending_action/
 * router/policy/handler/LLM, independientemente del dominio activo.
 *
 * Cobertura A-H del spec + cross-domain (`todo` y `adhd-coach`) para
 * demostrar que el filtro es base, no específico de ningún dominio.
 */

import { Orchestrator } from '../src/index';
import {
  CrisisDetector,
  CRISIS_FIXED_MESSAGE,
} from '../src/security/crisis.detector';
import {
  GenericMessage,
  GenericResponse,
  IDomainHandler,
  IMessageAdapter,
  IntentSource,
  ResolvedIntent,
} from '../src/core/types';
import { MemoryStorageProvider } from '../src/core/storage/memory.storage';
import { AdhdCoachDomainHandler } from '../src/examples/adhd-coach.domain';
import { TodoDomainHandler } from '../src/examples/todo.domain';
import { SessionManager } from '../src/core/session.manager';
import { AppConfig } from '../src/core/config';
import { setLogLevel } from '../src/core/logger';

setLogLevel('error');

// ─── Mock Adapter ────────────────────────────────────────────────────────────

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

  async receive(text: string, userId = 'crisis-user'): Promise<void> {
    if (!this.handler) throw new Error('MockAdapter: handler no registrado');
    const msg: GenericMessage = {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 8),
      userId,
      chatId: userId,
      text,
      timestamp: new Date().toISOString(),
    };
    await this.handler(msg);
  }

  reset(): void {
    this.sentResponses = [];
  }
}

function testConfig(): AppConfig {
  return {
    telegram: {
      botToken: 'test-token',
      mode: 'polling',
      webhookSecret: '',
      publicWebhookUrl: '',
      port: 3000,
    },
    llm: { enabled: false, provider: 'openai', openaiApiKey: '' },
    storage: { provider: 'memory', databaseUrl: '' },
    logLevel: 'error',
  };
}

// ─── Spec A-H: usa adhd-coach como dominio de prueba ─────────────────────────
// (la elección es arbitraria: el filtro es transversal, ver suite cross-domain)

describe('Crisis pre-filter — spec A-H (adhd-coach como dominio de prueba)', () => {
  let storage: MemoryStorageProvider;
  let adapter: MockAdapter;
  let orch: Orchestrator;
  let sessions: SessionManager;
  let domain: AdhdCoachDomainHandler;
  let executeSpy: jest.SpyInstance;

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('crisis-spec-adhd');
    adapter = new MockAdapter();
    domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
    executeSpy = jest.spyOn(domain, 'execute');
    sessions = new SessionManager(storage.sessionStore);
    orch = new Orchestrator(adapter, domain, testConfig(), storage.sessionStore);
    await orch.start();
  });

  afterEach(async () => {
    executeSpy.mockRestore();
    await orch.stop();
    await storage.disconnect();
  });

  const lastReply = () =>
    adapter.sentResponses[adapter.sentResponses.length - 1]?.text;

  test('A. "no quiero seguir" → crisis fijo, NO se invoca dominio', async () => {
    await adapter.receive('no quiero seguir');
    expect(adapter.sentResponses).toHaveLength(1);
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('B. "no veo salida" → crisis fijo, NO se invoca dominio', async () => {
    await adapter.receive('no veo salida');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('C. "quiero morir" → crisis fijo, NO se invoca dominio', async () => {
    await adapter.receive('quiero morir');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('D. "me quiero hacer daño" → crisis fijo, NO se invoca dominio', async () => {
    await adapter.receive('me quiero hacer daño');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('E. "me rindo con esta tarea" → NO crisis; sigue flujo normal', async () => {
    await adapter.receive('me rindo con esta tarea');
    expect(lastReply()).not.toBe(CRISIS_FIXED_MESSAGE);
    expect(adapter.sentResponses).toHaveLength(1);
  });

  test('F. "no veo salida con este trabajo" → crisis por seguridad', async () => {
    await adapter.receive('no veo salida con este trabajo');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('G. pending_action activo + crisis → crisis gana y limpia pending_action', async () => {
    const intent: ResolvedIntent = {
      action: 'reset_day',
      params: {},
      source: IntentSource.RULE,
      confidence: 1.0,
    };
    await sessions.setPendingAction('crisis-user', intent, 'Reinicia el día');
    expect(await sessions.hasPendingAction('crisis-user')).toBe(true);

    adapter.reset();
    await adapter.receive('no quiero seguir');

    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(await sessions.hasPendingAction('crisis-user')).toBe(false);
  });

  test('H. pending_input activo + crisis → crisis gana y limpia pending_input', async () => {
    await sessions.setContext('crisis-user', 'pending_input', {
      action: 'add_micro_task',
      paramName: 'text',
      prompt: '¿Cuál es la descripción corta de la micro-tarea?',
    });
    expect(await sessions.getContext('crisis-user', 'pending_input')).toBeTruthy();

    adapter.reset();
    await adapter.receive('quiero morir');

    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
    expect(executeSpy).not.toHaveBeenCalled();
    const ctx = await sessions.getContext('crisis-user', 'pending_input');
    expect(ctx === null || ctx === undefined).toBe(true);
  });

  test('comando /crisis → crisis fijo, sin pasar por router del dominio', async () => {
    await adapter.receive('/crisis');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('post-crisis, comandos normales siguen funcionando', async () => {
    await adapter.receive('no quiero seguir');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);

    adapter.reset();
    await adapter.receive('/start');
    expect(lastReply()).toContain('ADHD Coach');
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

// ─── Cross-domain: el filtro funciona igual con cualquier dominio ────────────

describe('Crisis pre-filter — cross-domain (`todo`)', () => {
  let storage: MemoryStorageProvider;
  let adapter: MockAdapter;
  let orch: Orchestrator;
  let domain: TodoDomainHandler;
  let executeSpy: jest.SpyInstance;

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('crisis-spec-todo');
    adapter = new MockAdapter();
    domain = new TodoDomainHandler(storage.todoStore);
    executeSpy = jest.spyOn(domain, 'execute');
    orch = new Orchestrator(adapter, domain, testConfig(), storage.sessionStore);
    await orch.start();
  });

  afterEach(async () => {
    executeSpy.mockRestore();
    await orch.stop();
    await storage.disconnect();
  });

  test('"no quiero seguir" en dominio todo → crisis, NO se invoca dominio', async () => {
    await adapter.receive('no quiero seguir');
    expect(adapter.sentResponses[0].text).toBe(CRISIS_FIXED_MESSAGE);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('"agregar tarea: comprar pan" en dominio todo → flujo normal, NO crisis', async () => {
    await adapter.receive('agregar tarea: comprar pan');
    expect(adapter.sentResponses[0].text).not.toBe(CRISIS_FIXED_MESSAGE);
  });
});

// ─── Inyección de detector custom / desactivación ────────────────────────────

describe('Crisis pre-filter — inyección y desactivación', () => {
  let storage: MemoryStorageProvider;
  let adapter: MockAdapter;
  let domain: AdhdCoachDomainHandler;

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('crisis-injection');
    adapter = new MockAdapter();
    domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
  });

  afterEach(async () => {
    await storage.disconnect();
  });

  test('detector custom con keywords vacías → ningún mensaje dispara crisis', async () => {
    const noopDetector = new CrisisDetector({ keywords: [] });
    const orch = new Orchestrator(
      adapter,
      domain,
      testConfig(),
      storage.sessionStore,
      noopDetector,
    );
    await orch.start();

    await adapter.receive('quiero morir');
    expect(adapter.sentResponses[0].text).not.toBe(CRISIS_FIXED_MESSAGE);

    await orch.stop();
  });

  test('detector custom con keyword propia → matchea esa', async () => {
    const customDetector = new CrisisDetector({ keywords: ['palabra secreta'] });
    const orch = new Orchestrator(
      adapter,
      domain,
      testConfig(),
      storage.sessionStore,
      customDetector,
    );
    await orch.start();

    await adapter.receive('contiene palabra secreta aqui');
    expect(adapter.sentResponses[0].text).toBe(CRISIS_FIXED_MESSAGE);

    adapter.reset();
    await adapter.receive('no quiero seguir');
    expect(adapter.sentResponses[0].text).not.toBe(CRISIS_FIXED_MESSAGE);

    await orch.stop();
  });
});
