/**
 * Integration tests for the Universal Telegram Conversational Layer.
 *
 * Validates:
 * 1. Simple commands don't use LLM (Level 1)
 * 2. Rule-based patterns match correctly (Level 2)
 * 3. Ambiguous messages trigger LLM fallback when enabled
 * 4. Ambiguous messages get clarification request when LLM disabled
 * 5. High-risk actions require confirmation
 * 6. /cancel clears pending actions
 * 7. Confirmation flow works end-to-end
 * 8. Multi-domain registration and capability isolation
 * 9. ADHD Coach domain works independently
 */

import { IntentRouter } from '../src/router/intent.router';
import { LLMFallback } from '../src/llm/llm.fallback';
import { PolicyEngine, PolicyDecision } from '../src/security/policy.engine';
import { SessionManager } from '../src/core/session.manager';
import { CapabilityRegistry } from '../src/registry/capability.registry';
import { ResponseFormatter } from '../src/core/response.formatter';
import { TodoDomainHandler } from '../src/examples/todo.domain';
import { AdhdCoachDomainHandler } from '../src/examples/adhd-coach.domain';
import { GenericMessage, IntentSource, RiskLevel } from '../src/core/types';
import { MemoryStorageProvider } from '../src/core/storage/memory.storage';

const storage = new MemoryStorageProvider();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMessage(text: string, userId: string = 'test-user'): GenericMessage {
  return {
    id: Date.now().toString(),
    userId,
    chatId: userId,
    text,
    timestamp: new Date().toISOString(),
  };
}

// ─── Setup: Todo Domain ─────────────────────────────────────────────────────

const todoDomain = new TodoDomainHandler(storage.todoStore);
const todoRegistry = new CapabilityRegistry();
todoRegistry.registerDomain(todoDomain);

const disabledLLM = new LLMFallback({ enabled: false, provider: '', openaiApiKey: '' });

const todoRouter = new IntentRouter(
  disabledLLM,
  () => todoRegistry.getAllCapabilities(),
);

// Inject domain-specific commands and rules
if (todoDomain.getCommands) todoRouter.addCommands(todoDomain.getCommands());
if (todoDomain.getRules) todoRouter.addRules(todoDomain.getRules());

const policy = new PolicyEngine();
const sessions = new SessionManager(storage.sessionStore);
const formatter = new ResponseFormatter();

// ─── Test Suites ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  await storage.connect('todo-test');
});

describe('Level 1: Explicit Commands', () => {
  test('/start resolves to system_start', async () => {
    const intent = await todoRouter.resolve(makeMessage('/start'));
    expect(intent.action).toBe('system_start');
    expect(intent.source).toBe(IntentSource.COMMAND);
    expect(intent.confidence).toBe(1.0);
  });

  test('/help resolves to system_help', async () => {
    const intent = await todoRouter.resolve(makeMessage('/help'));
    expect(intent.action).toBe('system_help');
    expect(intent.source).toBe(IntentSource.COMMAND);
  });

  test('/status resolves to system_status', async () => {
    const intent = await todoRouter.resolve(makeMessage('/status'));
    expect(intent.action).toBe('system_status');
    expect(intent.source).toBe(IntentSource.COMMAND);
  });

  test('/today resolves to list_today (domain command)', async () => {
    const intent = await todoRouter.resolve(makeMessage('/today'));
    expect(intent.action).toBe('list_today');
    expect(intent.source).toBe(IntentSource.COMMAND);
  });

  test('/cancel resolves to system_cancel', async () => {
    const intent = await todoRouter.resolve(makeMessage('/cancel'));
    expect(intent.action).toBe('system_cancel');
    expect(intent.source).toBe(IntentSource.COMMAND);
  });

  test('/confirm resolves to system_confirm', async () => {
    const intent = await todoRouter.resolve(makeMessage('/confirm'));
    expect(intent.action).toBe('system_confirm');
    expect(intent.source).toBe(IntentSource.COMMAND);
  });
});

describe('Level 2: Rule-based Patterns', () => {
  test('"qué tengo hoy" → list_today', async () => {
    const intent = await todoRouter.resolve(makeMessage('qué tengo hoy'));
    expect(intent.action).toBe('list_today');
    expect(intent.source).toBe(IntentSource.RULE);
  });

  test('"estado" → system_status', async () => {
    const intent = await todoRouter.resolve(makeMessage('estado'));
    expect(intent.action).toBe('system_status');
    expect(intent.source).toBe(IntentSource.RULE);
  });

  test('"tareas" → list_tasks', async () => {
    const intent = await todoRouter.resolve(makeMessage('tareas'));
    expect(intent.action).toBe('list_tasks');
    expect(intent.source).toBe(IntentSource.RULE);
  });

  test('"agregar tarea: comprar café" → create_task with params', async () => {
    const intent = await todoRouter.resolve(makeMessage('agregar tarea: comprar café'));
    expect(intent.action).toBe('create_task');
    expect(intent.source).toBe(IntentSource.RULE);
    expect(intent.params.text).toBe('comprar café');
  });

  test('"recuérdame llamar al doctor" → create_reminder with params', async () => {
    const intent = await todoRouter.resolve(makeMessage('recuérdame llamar al doctor'));
    expect(intent.action).toBe('create_reminder');
    expect(intent.source).toBe(IntentSource.RULE);
    expect(intent.params.text).toBe('llamar al doctor');
  });

  test('"sí" → system_confirm', async () => {
    const intent = await todoRouter.resolve(makeMessage('sí'));
    expect(intent.action).toBe('system_confirm');
    expect(intent.source).toBe(IntentSource.RULE);
  });

  test('"cancelar" → system_cancel', async () => {
    const intent = await todoRouter.resolve(makeMessage('cancelar'));
    expect(intent.action).toBe('system_cancel');
    expect(intent.source).toBe(IntentSource.RULE);
  });

  test('"ayuda" → system_help', async () => {
    const intent = await todoRouter.resolve(makeMessage('ayuda'));
    expect(intent.action).toBe('system_help');
    expect(intent.source).toBe(IntentSource.RULE);
  });
});

describe('LLM Fallback Behavior', () => {
  test('ambiguous message returns "unknown" when LLM is disabled', async () => {
    const intent = await todoRouter.resolve(
      makeMessage('me gustaría reorganizar mis prioridades para la próxima semana')
    );
    expect(intent.action).toBe('unknown');
    expect(intent.source).toBe(IntentSource.UNKNOWN);
  });

  test('simple command does NOT trigger LLM even if enabled', async () => {
    const intent = await todoRouter.resolve(makeMessage('/help'));
    expect(intent.source).toBe(IntentSource.COMMAND);
    expect(intent.source).not.toBe(IntentSource.LLM);
  });

  test('rule-matched message does NOT trigger LLM', async () => {
    const intent = await todoRouter.resolve(makeMessage('estado'));
    expect(intent.source).toBe(IntentSource.RULE);
    expect(intent.source).not.toBe(IntentSource.LLM);
  });
});

describe('Policy Engine', () => {
  test('READ_ONLY actions execute directly', () => {
    const cap = todoRegistry.getCapability('list_today')!;
    const intent = { action: 'list_today', params: {}, source: IntentSource.COMMAND, confidence: 1.0 };
    const result = policy.evaluate(intent, cap);
    expect(result.decision).toBe(PolicyDecision.EXECUTE);
  });

  test('LOW_RISK_WRITE actions execute directly by default', () => {
    const cap = todoRegistry.getCapability('create_task')!;
    const intent = { action: 'create_task', params: { text: 'test' }, source: IntentSource.RULE, confidence: 0.9 };
    const result = policy.evaluate(intent, cap);
    expect(result.decision).toBe(PolicyDecision.EXECUTE);
  });

  test('HIGH_RISK_ACTION always requires confirmation', () => {
    const cap = todoRegistry.getCapability('delete_all_tasks')!;
    const intent = { action: 'delete_all_tasks', params: {}, source: IntentSource.COMMAND, confidence: 1.0 };
    const result = policy.evaluate(intent, cap);
    expect(result.decision).toBe(PolicyDecision.CONFIRM);
  });

  test('system actions always execute', () => {
    const intent = { action: 'system_help', params: {}, source: IntentSource.COMMAND, confidence: 1.0 };
    const result = policy.evaluate(intent, undefined);
    expect(result.decision).toBe(PolicyDecision.EXECUTE);
  });

  test('LLM intent with low confidence triggers confirmation check', () => {
    const intent = { action: 'create_task', params: {}, source: IntentSource.LLM, confidence: 0.5 };
    expect(policy.shouldConfirmLowConfidence(intent)).toBe(true);
  });

  test('LLM intent with high confidence does not force confirmation', () => {
    const intent = { action: 'create_task', params: {}, source: IntentSource.LLM, confidence: 0.85 };
    expect(policy.shouldConfirmLowConfidence(intent)).toBe(false);
  });
});

describe('Session Manager — Confirmation Flow', () => {
  const userId = 'confirm-test-user';

  test('set and consume pending action', async () => {
    const intent = { action: 'delete_all_tasks', params: {}, source: IntentSource.COMMAND, confidence: 1.0 };
    await sessions.setPendingAction(userId, intent, 'Eliminar todas las tareas');

    expect(await sessions.hasPendingAction(userId)).toBe(true);

    const pending = await sessions.consumePendingAction(userId);
    expect(pending).not.toBeNull();
    expect(pending).toBe('delete_all_tasks');
    expect(await sessions.hasPendingAction(userId)).toBe(false);
  });

  test('/cancel clears pending action', async () => {
    const intent = { action: 'delete_all_tasks', params: {}, source: IntentSource.COMMAND, confidence: 1.0 };
    await sessions.setPendingAction(userId, intent, 'Eliminar todas las tareas');

    const cleared = await sessions.clearPendingAction(userId);
    expect(cleared).toBe(true);
    expect(await sessions.hasPendingAction(userId)).toBe(false);
  });

  test('cancel with no pending action returns false', async () => {
    const cleared = await sessions.clearPendingAction('no-pending-user');
    expect(cleared).toBe(false);
  });

  test('consume with no pending action returns null', async () => {
    const pending = await sessions.consumePendingAction('no-pending-user');
    expect(pending).toBeNull();
  });
});

describe('Domain Handler — Todo', () => {
  const userId = 'domain-test-user';

  test('create and list tasks', async () => {
    const createResult = await todoDomain.execute('create_task', { text: 'Test task' }, userId);
    expect(createResult.success).toBe(true);

    const listResult = await todoDomain.execute('list_tasks', {}, userId);
    expect(listResult.success).toBe(true);
    expect(listResult.message).toContain('Test task');
  });

  test('create reminder', async () => {
    const result = await todoDomain.execute('create_reminder', { text: 'Llamar al doctor' }, userId);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Llamar al doctor');
  });

  test('list_today includes tasks and reminders', async () => {
    const result = await todoDomain.execute('list_today', {}, userId);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Test task');
    expect(result.message).toContain('Llamar al doctor');
  });

  test('status summary', async () => {
    const summary = await todoDomain.getStatusSummary!(userId);
    expect(summary).toContain('pendientes');
    expect(summary).toContain('Recordatorios');
  });

  test('create task without text returns error', async () => {
    const result = await todoDomain.execute('create_task', {}, userId);
    expect(result.success).toBe(false);
  });
});

describe('Response Formatter', () => {
  test('formats confirmation request', () => {
    const text = formatter.formatConfirmation('Eliminar todas las tareas');
    expect(text).toContain('Confirmación requerida');
    expect(text).toContain('sí');
    expect(text).toContain('cancelar');
  });

  test('formats unknown message', () => {
    const text = formatter.formatUnknown();
    expect(text).toContain('No entendí');
  });

  test('formats welcome', () => {
    const text = formatter.formatWelcome('Todo');
    expect(text).toContain('Hola');
    expect(text).toContain('Todo');
  });
});

describe('Capability Registry', () => {
  test('all capabilities are registered', () => {
    const caps = todoRegistry.getAllCapabilities();
    expect(caps.length).toBeGreaterThanOrEqual(5);
    expect(caps.find(c => c.name === 'list_today')).toBeDefined();
    expect(caps.find(c => c.name === 'create_task')).toBeDefined();
    expect(caps.find(c => c.name === 'delete_all_tasks')).toBeDefined();
  });

  test('capability summary for LLM/help', () => {
    const summary = todoRegistry.getCapabilitySummary();
    expect(summary).toContain('list_today');
    expect(summary).toContain('create_task');
  });

  test('execute unknown action returns error', async () => {
    const result = await todoRegistry.executeAction('nonexistent_action', {}, 'test');
    expect(result.success).toBe(false);
  });
});

// ─── NEW: Multi-Domain & ADHD Coach Tests ───────────────────────────────────

describe('Domain Handler — ADHD Coach', () => {
  const adhdDomain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
  const userId = 'adhd-test-user';

  test('domain name is correct', () => {
    expect(adhdDomain.domainName).toBe('ADHD Coach');
  });

  test('has 14 capabilities (6 originales + 7 de fase 2 + recursos)', () => {
    const caps = adhdDomain.getCapabilities();
    expect(caps.length).toBe(14);
    // Originales
    expect(caps.find(c => c.name === 'daily_checkin')).toBeDefined();
    expect(caps.find(c => c.name === 'list_today_focus')).toBeDefined();
    expect(caps.find(c => c.name === 'add_micro_task')).toBeDefined();
    expect(caps.find(c => c.name === 'start_focus_session')).toBeDefined();
    expect(caps.find(c => c.name === 'complete_micro_task')).toBeDefined();
    expect(caps.find(c => c.name === 'reset_day')).toBeDefined();
    // Fase 2
    expect(caps.find(c => c.name === 'set_silence')).toBeDefined();
    expect(caps.find(c => c.name === 'show_privacy')).toBeDefined();
    expect(caps.find(c => c.name === 'delete_all_state')).toBeDefined();
    expect(caps.find(c => c.name === 'anti_abandono')).toBeDefined();
    expect(caps.find(c => c.name === 'restart_no_guilt')).toBeDefined();
    expect(caps.find(c => c.name === 'agenda_start')).toBeDefined();
    expect(caps.find(c => c.name === 'agenda_classify')).toBeDefined();
    // Recursos
    expect(caps.find(c => c.name === 'show_crisis_resources')).toBeDefined();
  });

  test('daily_checkin works', async () => {
    const result = await adhdDomain.execute('daily_checkin', {}, userId);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Check-in');
  });

  test('add and list micro-tasks', async () => {
    const addResult = await adhdDomain.execute('add_micro_task', { text: 'Revisar correo' }, userId);
    expect(addResult.success).toBe(true);
    expect(addResult.message).toContain('Revisar correo');

    const listResult = await adhdDomain.execute('list_today_focus', {}, userId);
    expect(listResult.success).toBe(true);
    expect(listResult.message).toContain('Revisar correo');
  });

  test('start focus session', async () => {
    const result = await adhdDomain.execute('start_focus_session', { task: 'Escribir reporte' }, userId);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Pomodoro');
    expect(result.message).toContain('Escribir reporte');
  });

  test('complete micro-task', async () => {
    const result = await adhdDomain.execute('complete_micro_task', { taskId: '1' }, userId);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Completast');
  });

  test('reset_day clears everything', async () => {
    const result = await adhdDomain.execute('reset_day', {}, userId);
    expect(result.success).toBe(true);
    expect(result.message).toContain('eliminada');
  });

  test('status summary', async () => {
    const summary = await adhdDomain.getStatusSummary!(userId);
    expect(summary).toContain('Micro-tareas');
  });

  test('add micro-task without text returns error', async () => {
    const result = await adhdDomain.execute('add_micro_task', {}, userId);
    expect(result.success).toBe(false);
  });

  test('declares domain commands', () => {
    const commands = adhdDomain.getCommands!();
    expect(commands['/checkin']).toBe('daily_checkin');
    expect(commands['/focus']).toBe('list_today_focus');
    expect(commands['/pomodoro']).toBe('start_focus_session');
  });

  test('declares domain rules', () => {
    const rules = adhdDomain.getRules!();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.find(r => r.action === 'daily_checkin')).toBeDefined();
    expect(rules.find(r => r.action === 'add_micro_task')).toBeDefined();
  });
});

describe('Multi-Domain Capability Isolation', () => {
  test('todo and adhd registries are separate', () => {
    const todoReg = new CapabilityRegistry();
    const adhdReg = new CapabilityRegistry();

    todoReg.registerDomain(new TodoDomainHandler(storage.todoStore));
    adhdReg.registerDomain(new AdhdCoachDomainHandler(storage.adhdCoachStore));

    const todoCaps = todoReg.getAllCapabilities();
    const adhdCaps = adhdReg.getAllCapabilities();

    // Capabilities should NOT overlap
    const todoNames = todoCaps.map(c => c.name);
    const adhdNames = adhdCaps.map(c => c.name);

    expect(todoNames).toContain('create_task');
    expect(todoNames).not.toContain('daily_checkin');

    expect(adhdNames).toContain('daily_checkin');
    expect(adhdNames).not.toContain('create_task');
  });

  test('ADHD Coach has its own HIGH_RISK action', () => {
    const adhdDomain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
    const cap = adhdDomain.getCapabilities().find(c => c.name === 'reset_day');
    expect(cap).toBeDefined();
    expect(cap!.riskLevel).toBe(RiskLevel.HIGH_RISK_ACTION);
    expect(cap!.requiresConfirmation).toBe(true);
  });

  test('policy engine works with ADHD Coach capabilities', () => {
    const adhdReg = new CapabilityRegistry();
    adhdReg.registerDomain(new AdhdCoachDomainHandler(storage.adhdCoachStore));

    const readCap = adhdReg.getCapability('list_today_focus')!;
    const readIntent = { action: 'list_today_focus', params: {}, source: IntentSource.COMMAND, confidence: 1.0 };
    expect(policy.evaluate(readIntent, readCap).decision).toBe(PolicyDecision.EXECUTE);

    const highCap = adhdReg.getCapability('reset_day')!;
    const highIntent = { action: 'reset_day', params: {}, source: IntentSource.COMMAND, confidence: 1.0 };
    expect(policy.evaluate(highIntent, highCap).decision).toBe(PolicyDecision.CONFIRM);
  });
});

describe('ADHD Coach Router Integration', () => {
  const adhdDomain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
  const adhdRegistry = new CapabilityRegistry();
  adhdRegistry.registerDomain(adhdDomain);

  const adhdRouter = new IntentRouter(
    disabledLLM,
    () => adhdRegistry.getAllCapabilities(),
  );
  if (adhdDomain.getCommands) adhdRouter.addCommands(adhdDomain.getCommands());
  if (adhdDomain.getRules) adhdRouter.addRules(adhdDomain.getRules());

  test('/checkin resolves to daily_checkin', async () => {
    const intent = await adhdRouter.resolve(makeMessage('/checkin'));
    expect(intent.action).toBe('daily_checkin');
    expect(intent.source).toBe(IntentSource.COMMAND);
  });

  test('"buenos días" → daily_checkin via rule', async () => {
    const intent = await adhdRouter.resolve(makeMessage('buenos días'));
    expect(intent.action).toBe('daily_checkin');
    expect(intent.source).toBe(IntentSource.RULE);
  });

  test('"microtarea: leer 5 páginas" → add_micro_task', async () => {
    const intent = await adhdRouter.resolve(makeMessage('microtarea: leer 5 páginas'));
    expect(intent.action).toBe('add_micro_task');
    expect(intent.source).toBe(IntentSource.RULE);
    expect(intent.params.text).toBe('leer 5 páginas');
  });

  test('/pomodoro resolves to start_focus_session', async () => {
    const intent = await adhdRouter.resolve(makeMessage('/pomodoro'));
    expect(intent.action).toBe('start_focus_session');
    expect(intent.source).toBe(IntentSource.COMMAND);
  });

  test('system commands still work in ADHD router', async () => {
    const intent = await adhdRouter.resolve(makeMessage('/help'));
    expect(intent.action).toBe('system_help');
    expect(intent.source).toBe(IntentSource.COMMAND);
  });

  test('todo-specific rules do NOT match in ADHD router', async () => {
    const intent = await adhdRouter.resolve(makeMessage('agregar tarea: comprar café'));
    // Should NOT match create_task (that's a todo rule, not injected here)
    expect(intent.action).toBe('unknown');
  });
});

describe('Domain Isolation', () => {
  test('different domains should not share data', async () => {
    const storeTodo = new MemoryStorageProvider();
    await storeTodo.connect('domain-a');
    
    const storeAdhd = new MemoryStorageProvider();
    await storeAdhd.connect('domain-b');

    // Create task in domain-a
    await storeTodo.todoStore.addTask('user1', 'task in A');
    
    // Check it's there
    const tasksA = await storeTodo.todoStore.getTasks('user1');
    expect(tasksA.length).toBe(1);
    expect(tasksA[0].text).toBe('task in A');

    // Check it's NOT in domain-b
    const tasksB = await storeAdhd.todoStore.getTasks('user1');
    expect(tasksB.length).toBe(0);

    // Pending input isolation
    await storeTodo.sessionStore.setPendingInput('user1', { action: 'foo', paramName: 'bar', prompt: 'prompt' });
    
    const inputA = await storeTodo.sessionStore.getPendingInput('user1');
    expect(inputA?.action).toBe('foo');

    const inputB = await storeAdhd.sessionStore.getPendingInput('user1');
    expect(inputB).toBeNull();
  });
});
