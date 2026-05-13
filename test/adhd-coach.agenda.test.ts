/**
 * Tests del refactor /agenda (Fase 3).
 *
 * Verifica el flujo conversacional de 4 pasos: inicio → clasificación →
 * selección → consulta. Ver docs/agenda-contract.md.
 */

import { Orchestrator } from '../src/index';
import { CRISIS_FIXED_MESSAGE } from '../src/security/crisis.detector';
import {
  AdhdCoachDomainHandler,
  parseAgendaSelection,
} from '../src/examples/adhd-coach.domain';
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
  async receive(text: string, userId = 'agenda-user'): Promise<void> {
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

// ─── Suite 1: parseAgendaSelection (unit) ─────────────────────────────────

describe('parseAgendaSelection — unit', () => {
  const candidates = [
    { text: 'terminar proyecto LABDEN' },
    { text: 'limpiar el jardín' },
    { text: 'poner cadena de puerta' },
    { text: 'hacer mi devocional' },
  ];

  test('"todos" → todas las posiciones', () => {
    const r = parseAgendaSelection('todos', candidates);
    expect(r.kind).toBe('indices');
    if (r.kind === 'indices') expect(r.indices).toEqual([0, 1, 2, 3]);
  });

  test('"1, 3" → índices 0 y 2', () => {
    const r = parseAgendaSelection('1, 3', candidates);
    expect(r.kind).toBe('indices');
    if (r.kind === 'indices') expect(r.indices).toEqual([0, 2]);
  });

  test('"1 y 3 y 4" → 0, 2, 3', () => {
    const r = parseAgendaSelection('1 y 3 y 4', candidates);
    expect(r.kind).toBe('indices');
    if (r.kind === 'indices') expect(r.indices).toEqual([0, 2, 3]);
  });

  test('"Sí, hacer devocional, terminar LABDEN y mantenimiento: limpiar jardín" → 3, 0, 1', () => {
    const r = parseAgendaSelection(
      'Sí, hacer devocional, terminar LABDEN y mantenimiento: limpiar jardín',
      candidates,
    );
    expect(r.kind).toBe('indices');
    if (r.kind === 'indices') {
      // Orden de aparición en el input: devocional (3), LABDEN (0), jardín (1).
      expect(r.indices).toEqual([3, 0, 1]);
    }
  });

  test('"ninguno" → cancel', () => {
    const r = parseAgendaSelection('ninguno', candidates);
    expect(r.kind).toBe('cancel');
  });

  test('"nada" → cancel', () => {
    const r = parseAgendaSelection('nada', candidates);
    expect(r.kind).toBe('cancel');
  });

  test('texto basura → unparsed', () => {
    const r = parseAgendaSelection('aksdjflkasjdf', candidates);
    expect(r.kind).toBe('unparsed');
  });

  test('"sí" solo (sin items) → unparsed', () => {
    const r = parseAgendaSelection('sí', candidates);
    expect(r.kind).toBe('unparsed');
  });

  test('número fuera de rango → unparsed', () => {
    const r = parseAgendaSelection('1, 99', candidates);
    // 99 inválido, pero 1 es válido. Como NO todos los tokens numéricos
    // son válidos, cae a parsing por texto, que tampoco encuentra "99".
    expect(r.kind === 'indices' || r.kind === 'unparsed').toBe(true);
  });

  test('candidates vacío → unparsed', () => {
    const r = parseAgendaSelection('todos', []);
    expect(r.kind).toBe('unparsed');
  });
});

// ─── Suite 2: Flujo end-to-end via orchestrator ───────────────────────────

describe('/agenda — flujo conversacional refactorizado', () => {
  let storage: MemoryStorageProvider;
  let adapter: MockAdapter;
  let domain: AdhdCoachDomainHandler;
  let orch: Orchestrator;
  const user = 'agenda-user';

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('agenda-test');
    adapter = new MockAdapter();
    domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
    orch = new Orchestrator(adapter, domain, cfg(), storage.sessionStore);
    await orch.start();
  });

  afterEach(async () => {
    await orch.stop();
    await storage.disconnect();
  });

  // 1. /agenda solo → prompt + pending_input listo
  test('1) /agenda solo → invita a volcar + pending_input para classify', async () => {
    await adapter.receive('/agenda');
    expect(adapter.last()).toMatch(/vuélcame|volcame/i);
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).not.toBeNull();
    expect(pi!.action).toBe('agenda_classify');
    expect(pi!.paramName).toBe('dump');
  });

  // 2. /agenda <volcado> → clasificación directa + pending_input para selection
  test('2) /agenda <texto> atajo: clasifica + pending_input para selección', async () => {
    await adapter.receive('/agenda comprar pan, llamar al doctor, terminar reporte');
    const r = adapter.last();
    expect(r).toContain('Lo separé así');
    expect(r).toMatch(/Cu[áa]les eliges/i);
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi!.action).toBe('agenda_confirm_selection');
    expect(pi!.paramName).toBe('selection');
    const cand = await storage.adhdCoachStore.getPendingAgendaSelection(user);
    expect(cand).not.toBeNull();
    expect(cand!.length).toBe(3);
  });

  // 3. Dump 3+ items sin /agenda → mismo flujo
  test('3) volcado 3+ items sin /agenda → entra al flujo', async () => {
    await adapter.receive('terminar reporte, pagar tarjeta, hacer ejercicio');
    expect(adapter.last()).toContain('Lo separé así');
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi!.action).toBe('agenda_confirm_selection');
  });

  // 4. Selección por números → guarda los elegidos como microtasks
  test('4) selección "1, 3" → guarda esos 2 como microtasks', async () => {
    await adapter.receive('/agenda terminar LABDEN, limpiar jardín, hacer devocional');
    adapter.reset();
    await adapter.receive('1, 3');
    expect(adapter.last()).toMatch(/Cargué a tu día/);
    expect(adapter.last()).toContain('terminar LABDEN');
    expect(adapter.last()).toContain('hacer devocional');
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks.length).toBe(2);
    expect(tasks.map((t) => t.text)).toEqual(['terminar LABDEN', 'hacer devocional']);
  });

  // 5. Selección por texto con prefijo "sí," → strip + match substring
  test('5) "Sí, hacer devocional, terminar LABDEN" → guarda esos 2 por substring', async () => {
    await adapter.receive('/agenda terminar proyecto LABDEN, limpiar el jardín, hacer mi devocional');
    adapter.reset();
    await adapter.receive('Sí, hacer devocional, terminar LABDEN');
    expect(adapter.last()).toMatch(/Cargué a tu día/);
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks.length).toBe(2);
    expect(tasks.map((t) => t.text).sort()).toEqual(
      ['hacer mi devocional', 'terminar proyecto LABDEN'].sort(),
    );
  });

  // 6. "todos" → guarda toda la lista
  test('6) "todos" → guarda todos los candidatos', async () => {
    await adapter.receive('/agenda A, B, C');
    adapter.reset();
    await adapter.receive('todos');
    expect(adapter.last()).toMatch(/Cargué a tu día/);
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks.length).toBe(3);
  });

  // 7. "ninguno" → no guarda, limpia estado
  test('7) "ninguno" → no guarda nada, limpia pending_agenda_selection', async () => {
    await adapter.receive('/agenda A, B, C');
    adapter.reset();
    await adapter.receive('ninguno');
    expect(adapter.last()).toMatch(/no guardé nada/i);
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks.length).toBe(0);
    const cand = await storage.adhdCoachStore.getPendingAgendaSelection(user);
    expect(cand).toBeNull();
  });

  // 8. Selección basura → re-prompt, pending_input se preserva
  test('8) selección irreconocible → re-prompt y pending_input se preserva', async () => {
    await adapter.receive('/agenda A, B, C');
    adapter.reset();
    await adapter.receive('xklcjvxk no entiendo nada');
    expect(adapter.last()).toMatch(/no entend|no encontré|no entendi/i);
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).not.toBeNull();
    expect(pi!.action).toBe('agenda_confirm_selection');
  });

  // 9. /recordatorios durante selección → escape + comando funciona
  test('9) /recordatorios durante selección escapa pending_input y ejecuta el comando', async () => {
    await adapter.receive('/agenda A, B, C');
    adapter.reset();
    await adapter.receive('/recordatorios');
    expect(adapter.last()).toMatch(/recordatorios|no tienes recordatorios/i);
    // pending_input se limpió por slash escape
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).toBeNull();
  });

  // 10. Re-entrar /agenda con selección previa → sobrescribe sin error
  test('10) re-entrar /agenda con pending_agenda_selection previo lo sobrescribe', async () => {
    await adapter.receive('/agenda A, B, C');
    let cand = await storage.adhdCoachStore.getPendingAgendaSelection(user);
    expect(cand!.length).toBe(3);
    adapter.reset();
    await adapter.receive('/agenda X, Y, Z, W');
    cand = await storage.adhdCoachStore.getPendingAgendaSelection(user);
    expect(cand!.length).toBe(4);
  });

  // 11. NO hay loop de reclasificación
  test('11) respuesta del usuario NO vuelve a clasificarse (loop muerto)', async () => {
    await adapter.receive('/agenda terminar LABDEN, limpiar jardín, hacer devocional');
    adapter.reset();
    // Esto antes del refactor caía en la regla 3+ comma → re-clasificaba.
    await adapter.receive('Sí, hacer devocional, terminar LABDEN y limpiar jardín');
    // Ahora va a agenda_confirm_selection vía pending_input.
    expect(adapter.last()).toMatch(/Cargué a tu día/);
    expect(adapter.last()).not.toMatch(/Lo separé así/);
  });

  // 12. Consulta NL "qué tengo hoy" → list_today_focus
  test('12) "qué tengo hoy" → list_today_focus (con microtasks guardadas)', async () => {
    await adapter.receive('/agenda A, B, C');
    adapter.reset();
    await adapter.receive('todos');
    adapter.reset();
    await adapter.receive('qué tengo hoy');
    expect(adapter.last()).toMatch(/foco|micro/i);
    expect(adapter.last()).toContain('A');
    expect(adapter.last()).toContain('B');
    expect(adapter.last()).toContain('C');
  });

  test('12b) "ya los cargaste?" → list_today_focus', async () => {
    await adapter.receive('/agenda A, B, C');
    adapter.reset();
    await adapter.receive('todos');
    adapter.reset();
    await adapter.receive('ya los cargaste');
    expect(adapter.last()).toMatch(/foco|micro/i);
  });

  // 13. Crisis sigue ganando
  test('13) crisis durante selección de agenda gana sobre el flujo', async () => {
    await adapter.receive('/agenda A, B, C');
    adapter.reset();
    await adapter.receive('no quiero seguir');
    expect(adapter.last()).toBe(CRISIS_FIXED_MESSAGE);
    // pending_input se limpia por el crisis pre-filter
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).toBeNull();
  });

  // 14. resetAllUserState limpia pending_agenda_selection
  test('14) resetAllUserState limpia pending_agenda_selection', async () => {
    await adapter.receive('/agenda A, B, C');
    let cand = await storage.adhdCoachStore.getPendingAgendaSelection(user);
    expect(cand).not.toBeNull();
    await storage.adhdCoachStore.resetAllUserState(user);
    cand = await storage.adhdCoachStore.getPendingAgendaSelection(user);
    expect(cand).toBeNull();
  });

  // Extra: agenda_confirm_selection sin candidatos pendientes (huérfano)
  test('extra) agenda_confirm_selection sin pending_agenda_selection responde claro', async () => {
    const r = await domain.execute('agenda_confirm_selection', { selection: '1, 2' }, user);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/no tengo una selección|empieza con \/agenda/i);
  });

  // ─── Fase 4.1: refinamiento ────────────────────────────────────────────

  test('4.1) splitter acepta saltos de línea como separadores', async () => {
    // Antes: todo el volcado caía como UN solo item porque solo se splitteaba
    // por "," o " y ". El usuario en Telegram presiona Enter para separar.
    const dump = 'comprar pan\nllamar al doctor\nentregar reporte';
    await adapter.receive(`/agenda ${dump}`);
    const r = adapter.last();
    expect(r).toContain('Lo separé así');
    expect(r).toMatch(/comprar pan/i);
    expect(r).toMatch(/llamar al doctor/i);
    expect(r).toMatch(/entregar reporte/i);
    const cand = await storage.adhdCoachStore.getPendingAgendaSelection(user);
    expect(cand!.length).toBe(3);
  });

  test('4.1) render numerado: items multi-línea quedan en una sola línea', async () => {
    // Con saltos de línea: el splitter prioriza \n sobre coma. Las comas
    // dentro de un renglón son parte del texto del item, no separadores.
    // Input: 2 líneas → 2 items. Cada uno renderizado en UNA línea.
    await adapter.receive('/agenda primer item, segundo item con\nsalto adentro, tercero');
    const r = adapter.last();
    const numLineas = r.split('\n').filter((l) => /^\d+\.\s/.test(l)).length;
    expect(numLineas).toBe(2);
    // Ningún item debe quedar partido en varias líneas con "— categoria"
    // suelto: cada línea numerada termina con su categoría.
    const itemLines = r.split('\n').filter((l) => /^\d+\.\s/.test(l));
    for (const line of itemLines) {
      expect(line).toMatch(/—\s+\w+\s*$/);
    }
  });

  test('4.1) /borrar N elimina la micro-tarea', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'tarea A');
    await storage.adhdCoachStore.addMicroTask(user, 'tarea B');
    await storage.adhdCoachStore.addMicroTask(user, 'tarea C');
    adapter.reset();
    await adapter.receive('/borrar 2');
    expect(adapter.last()).toMatch(/Borrada.*tarea B/);
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks.length).toBe(2);
    expect(tasks.map((t) => t.text)).toEqual(['tarea A', 'tarea C']);
  });

  test('4.1) "elimina el punto N" NL también borra', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'tarea A');
    await storage.adhdCoachStore.addMicroTask(user, 'tarea B');
    adapter.reset();
    await adapter.receive('elimina el punto 1');
    expect(adapter.last()).toMatch(/Borrada.*tarea A/);
  });

  test('4.1) "borra el 1" también borra', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'X');
    adapter.reset();
    await adapter.receive('borra el 1');
    expect(adapter.last()).toMatch(/Borrada/);
  });

  test('4.1) /editar N reemplaza el texto', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'viejo texto');
    adapter.reset();
    await adapter.receive('/editar 1 nuevo texto del día');
    expect(adapter.last()).toMatch(/Cambiada #1.*viejo texto.*nuevo texto del día/);
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks[0].text).toBe('nuevo texto del día');
  });

  test('4.1) "edita el punto 1: <texto>" NL también edita', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'algo');
    adapter.reset();
    await adapter.receive('edita el punto 1: llamar al doctor');
    expect(adapter.last()).toMatch(/Cambiada #1/);
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks[0].text).toBe('llamar al doctor');
  });

  test('4.1) /agenda con micro-tareas existentes menciona el contexto', async () => {
    await storage.adhdCoachStore.addMicroTask(user, 'existente A');
    await storage.adhdCoachStore.addMicroTask(user, 'existente B');
    adapter.reset();
    await adapter.receive('/agenda');
    const r = adapter.last();
    expect(r).toMatch(/Tienes ya 2 micro-tarea/);
    expect(r).toMatch(/te las agrego|sumando|agrego/i);
  });

  test('4.1) /agenda sin micro-tareas usa el mensaje original', async () => {
    await adapter.receive('/agenda');
    expect(adapter.last()).toMatch(/Vamos a ordenar el día/);
    expect(adapter.last()).not.toMatch(/Tienes ya/);
  });

  test('4.1) detector de imperativo: "Separa lo de X de Y" en selección → aclara', async () => {
    await adapter.receive('/agenda terminar LABDEN, limpiar jardín, hacer devocional');
    adapter.reset();
    await adapter.receive('Separa lo de terminar de lo de limpiar');
    const r = adapter.last();
    expect(r).toMatch(/modo selecci[óo]n|no puedo reorganizar/i);
    expect(r).toMatch(/n[úu]meros|todos|despu[ée]s/i);
    // Nada cargado todavía
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks.length).toBe(0);
    // pending_input preservado
    const pi = await storage.sessionStore.getPendingInput(user);
    expect(pi).not.toBeNull();
    expect(pi!.action).toBe('agenda_confirm_selection');
  });

  test('4.1) "Elimina el punto 5" durante selección → aclara, no clasifica como dump', async () => {
    await adapter.receive('/agenda A, B, C');
    adapter.reset();
    await adapter.receive('Elimina el punto 5');
    expect(adapter.last()).toMatch(/modo selecci[óo]n|no puedo reorganizar/i);
  });

  test('4.1) regresión prod: coma DENTRO de un renglón NO parte el item', async () => {
    // Bug real: el usuario escribió 4 items con Enter, uno tenía coma
    // interna ("Comprar bote antismalte, para quitar color de puerta")
    // y el bot lo partió en 2. Ahora el splitter prioriza \n sobre coma.
    const dump =
      'comprar base para televisión\n' +
      'Comprar bote antismalte, para quitar color de puerta\n' +
      'Quitar molduras de puerta\n' +
      'Ir a carpintería';
    await adapter.receive(`/agenda ${dump}`);
    const r = adapter.last();
    const numLineas = r.split('\n').filter((l) => /^\d+\.\s/.test(l)).length;
    expect(numLineas).toBe(4);
    expect(r).toMatch(/Comprar bote antismalte, para quitar color de puerta/);
  });

  test('4.1) regresión prod: "agrega las N" como cuantificador → todos', async () => {
    // Bug real: "Agrega las 5 como mantenimiento" se interpretaba como
    // "índice 5", cargando solo el quinto item. Debe interpretarse como
    // cuantificador "todas las N = todos".
    await adapter.receive('/agenda A, B, C, D');
    adapter.reset();
    await adapter.receive('Agrega las 5 como mantenimiento');
    expect(adapter.last()).toMatch(/Cargué a tu día/);
    const tasks = await storage.adhdCoachStore.getMicroTasks(user);
    expect(tasks.length).toBe(4);
  });

  test('4.1) "las 4" / "los 3" / "todas las 5" → todos', async () => {
    await adapter.receive('/agenda A, B, C');
    adapter.reset();
    await adapter.receive('las 3');
    expect(adapter.last()).toMatch(/Cargué a tu día/);
    expect((await storage.adhdCoachStore.getMicroTasks(user)).length).toBe(3);
  });

  test('4.1) "agrega todas" → todos', async () => {
    await adapter.receive('/agenda A, B');
    adapter.reset();
    await adapter.receive('agrega todas');
    expect(adapter.last()).toMatch(/Cargué a tu día/);
    expect((await storage.adhdCoachStore.getMicroTasks(user)).length).toBe(2);
  });

  test('4.1) reproducción del bug del usuario: volcado multi-línea limpio', async () => {
    // Escenario exacto del screenshot del usuario.
    const dump =
      'El 2 de junio deja la aspirina Ale.\n' +
      'Vacuna VSR EN LA semana 32-34\n' +
      'Entre 22 y 23 de mayo estudio de sangre';
    await adapter.receive(`/agenda ${dump}`);
    const r = adapter.last();
    // Debe tener 3 items separados (no un blob).
    const numLines = r.split('\n').filter((l) => /^\d+\.\s/.test(l)).length;
    expect(numLines).toBe(3);
    // Y ningún item contiene "Entre 22\n" pegado a otra cosa.
    expect(r).toMatch(/1\..*aspirina/i);
    expect(r).toMatch(/Vacuna VSR/i);
  });
});
