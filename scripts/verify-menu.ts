/**
 * Verifica que cada comando y trigger NL del menú de Fase 4 funcione
 * end-to-end contra el orquestador real con MemoryStorage.
 *
 * Reporte: para cada caso, marca OK si la respuesta cumple un check
 * mínimo de contenido, FAIL si cayó al fallback o no cumple.
 */

import { Orchestrator } from '../src/index';
import { AdhdCoachDomainHandler } from '../src/examples/adhd-coach.domain';
import { MemoryStorageProvider } from '../src/core/storage/memory.storage';
import { GenericMessage, GenericResponse, IMessageAdapter } from '../src/core/types';
import { AppConfig } from '../src/core/config';
import { setLogLevel } from '../src/core/logger';

setLogLevel('error');

class CaptureAdapter implements IMessageAdapter {
  public sent: GenericResponse[] = [];
  private handler: ((m: GenericMessage) => Promise<void>) | null = null;
  async start(h: (m: GenericMessage) => Promise<void>) { this.handler = h; }
  async sendResponse(r: GenericResponse) { this.sent.push(r); }
  async stop() { this.handler = null; }
  async send(text: string, userId = 'menu') {
    if (!this.handler) throw new Error();
    await this.handler({
      id: String(Date.now()) + Math.random(),
      userId, chatId: userId, text,
      timestamp: new Date().toISOString(),
    });
  }
  last() { return this.sent[this.sent.length - 1]?.text ?? ''; }
  reset() { this.sent = []; }
}

function cfg(): AppConfig {
  return {
    telegram: { botToken: 'x', mode: 'polling', webhookSecret: '', publicWebhookUrl: '', port: 0 },
    llm: { enabled: false, provider: 'openai', openaiApiKey: '' },
    storage: { provider: 'memory', databaseUrl: '' },
    logLevel: 'error',
  };
}

interface Case {
  group: string;
  input: string;
  // Si pasa cualquiera de estos regex, OK. Si NINGUNO matchea, FAIL.
  expectAny: RegExp[];
  // Si CUALQUIERA matchea, FAIL (cosas que no deben aparecer).
  forbid?: RegExp[];
  // Si presente: tras enviar input, enviar este "follow-up" y testear contra
  // el último mensaje recibido en lugar del primero.
  followUp?: { input: string; expectAny: RegExp[]; forbid?: RegExp[] };
  // Antes de mandar input, ejecutar estos en el orden.
  setup?: string[];
}

const FALLBACK_RE = /No lo entend[íi] del todo/i;

const cases: Case[] = [
  // ── /start y /help ──────────────────────────────────────────────────
  { group: 'sistema', input: '/start', expectAny: [/Hola/i, /asistente/i] },
  {
    group: 'sistema',
    input: '/help',
    expectAny: [/Ayuda/i],
    forbid: [/add_reminder/, /list_reminders/, /agenda_classify/, /flow_step/, /complete_reminder_with_time/, /show_overdue_reminders/],
  },
  { group: 'sistema', input: '/cancel', expectAny: [/cancelada|cancelar/i] },

  // ── Comandos principales del menú ──────────────────────────────────
  { group: 'principal', input: '/agenda', expectAny: [/vuélcame|volcame|ordenar el d/i] },
  { group: 'principal', input: '/recordar', expectAny: [/qué quieres recordar|cuál|cu[áa]l/i] },
  { group: 'principal', input: '/recordatorios', expectAny: [/no tienes recordatorios|recordatorios pendientes/i] },
  { group: 'principal', input: '/silencio', expectAny: [/silencio|hasta/i] },
  { group: 'principal', input: '/silencio 2h', expectAny: [/silencio|hasta/i] },
  { group: 'principal', input: '/privacidad', expectAny: [/contexto|cosmovis/i] },
  { group: 'principal', input: '/abandonar', expectAny: [/antes de abandonar|pausa/i] },
  { group: 'principal', input: '/reinicio', expectAny: [/romper una racha|reinicio/i] },
  { group: 'principal', input: '/recursos', expectAny: [/línea|Lifeline|emergencias|988|112|911/i] },
  { group: 'principal', input: '/checkin', expectAny: [/check.in|racha|motivaci[óo]n/i] },
  { group: 'principal', input: '/focus', expectAny: [/foco|micro/i] },

  // ── Regulación y procrastinación (Fase 4B) ─────────────────────────
  { group: 'fase4B', input: '/reset90', expectAny: [/pausa|modo alerta|exhala/i] },
  { group: 'fase4B', input: '/soma', expectAny: [/pausa|modo alerta|exhala/i] },
  { group: 'fase4B', input: '/procrastinacion', expectAny: [/alivio r[áa]pido|amenaza|evitando/i] },
  // con tilde (autocorrector)
  { group: 'fase4B', input: '/procrastinación', expectAny: [/alivio r[áa]pido|amenaza|evitando/i] },

  // ── TCC (Fase 4C) ──────────────────────────────────────────────────
  { group: 'fase4C', input: '/rpec', expectAny: [/¿qu[eé] pas[óo]\?|no es terapia/i] },
  { group: 'fase4C', input: '/reencuadre', expectAny: [/hip[óo]tesis|sentencia|frase exacta/i] },
  { group: 'fase4C', input: '/dopar', expectAny: [/define el problema|DOPAR/i] },
  { group: 'fase4C', input: '/revision', expectAny: [/qu[eé] se repiti[óo]/i] },
  // con tilde
  { group: 'fase4C', input: '/revisión', expectAny: [/qu[eé] se repiti[óo]/i] },

  // ── Espiritualidad (Fase 4D) ───────────────────────────────────────
  { group: 'fase4D', input: '/oracion', expectAny: [/oramos|se[ñn]or|amén/i] },
  { group: 'fase4D', input: '/oración', expectAny: [/oramos|se[ñn]or|amén/i] },
  { group: 'fase4D', input: '/devocional', expectAny: [/verdad|fidelidad|amén/i] },
  { group: 'fase4D', input: '/espiritual', expectAny: [/A\).*oraci[óo]n.*B\).*gratitud/is] },

  // ── NL del menú (ejemplos que el bot promete entender) ─────────────
  { group: 'NL', input: 'recuérdame mañana a las 9 llamar al doctor', expectAny: [/recordatorio guardado|listo/i] },
  { group: 'NL', input: 'quiero ordenar mi día', expectAny: [/vuélcame|volcame|ordenar el d/i] },
  { group: 'NL', input: 'me rindo', expectAny: [/antes de abandonar|pausa/i] },
  { group: 'NL', input: 'estoy bloqueado', expectAny: [/pausa|modo alerta|exhala/i] },
  { group: 'NL', input: 'estoy procrastinando', expectAny: [/alivio r[áa]pido|amenaza/i] },
  { group: 'NL', input: 'qué puedes hacer', expectAny: [/puedo ayudarte/i] },
  { group: 'NL', input: 'para qué sirve /agenda', expectAny: [/agenda/i], forbid: [FALLBACK_RE] },

  // ── NL adicionales del contrato Fase 4 ─────────────────────────────
  { group: 'NL-fase4', input: 'estoy saturado', expectAny: [/pausa|modo alerta/i] },
  { group: 'NL-fase4', input: 'tengo la cabeza llena', expectAny: [/pausa|modo alerta/i] },
  { group: 'NL-fase4', input: 'no me da la vida', expectAny: [/pausa|modo alerta/i] },
  { group: 'NL-fase4', input: 'estoy colapsado', expectAny: [/pausa|modo alerta/i] },
  { group: 'NL-fase4', input: 'no sé por dónde empezar', expectAny: [/pausa|modo alerta/i] },
  { group: 'NL-fase4', input: 'no puedo empezar', expectAny: [/pausa|modo alerta/i] },
  { group: 'NL-fase4', input: 'no puedo dejar el celular', expectAny: [/alivio r[áa]pido|amenaza/i] },
  { group: 'NL-fase4', input: 'estoy evitando una tarea', expectAny: [/alivio r[áa]pido|amenaza/i] },
  { group: 'NL-fase4', input: 'sé qué hacer pero no empiezo', expectAny: [/alivio r[áa]pido|amenaza/i] },
  { group: 'NL-fase4', input: 'estoy postergando', expectAny: [/alivio r[áa]pido|amenaza/i] },
  { group: 'NL-fase4', input: 'estoy evadiendo', expectAny: [/alivio r[áa]pido|amenaza/i] },
  { group: 'NL-fase4', input: 'no sirvo para esto', expectAny: [/hip[óo]tesis|sentencia/i] },
  { group: 'NL-fase4', input: 'siempre arruino todo', expectAny: [/hip[óo]tesis|sentencia/i] },
  { group: 'NL-fase4', input: 'ya fallé', expectAny: [/hip[óo]tesis|sentencia/i] },
  { group: 'NL-fase4', input: 'si no lo hago perfecto no cuenta', expectAny: [/hip[óo]tesis|sentencia/i] },
  { group: 'NL-fase4', input: 'estoy pensando que soy un fraude', expectAny: [/hip[óo]tesis|sentencia/i] },
  { group: 'NL-fase4', input: 'siento que soy un desastre', expectAny: [/hip[óo]tesis|sentencia/i] },
  { group: 'NL-fase4', input: 'seguro va a salir mal', expectAny: [/hip[óo]tesis|sentencia/i] },
  { group: 'NL-fase4', input: 'qué guardas de mí', expectAny: [/contexto|cosmovis/i] },
  { group: 'NL-fase4', input: 'quiero ver mis recordatorios', expectAny: [/no tienes recordatorios|recordatorios pendientes/i] },
  { group: 'NL-fase4', input: 'muéstrame mis recordatorios', expectAny: [/no tienes recordatorios|recordatorios pendientes/i] },
  { group: 'NL-fase4', input: 'necesito silencio por 2 horas', expectAny: [/silencio/i] },
  { group: 'NL-fase4', input: 'pausa mensajes por 2 horas', expectAny: [/silencio/i] },

  // ── Integración fe + bloqueo ───────────────────────────────────────
  {
    group: 'fe+bloqueo',
    input: 'Dios ayúdame con esta procrastinación',
    expectAny: [/neurociencia.*espiritualidad.*ambos|neurociencia.*fe.*ambos/i],
  },
  {
    group: 'fe+bloqueo',
    input: 'necesito fe para no procrastinar más',
    expectAny: [/neurociencia.*espiritualidad.*ambos|neurociencia.*fe.*ambos/i],
  },

  // ── Flujos multi-paso (un follow-up cada uno) ──────────────────────
  {
    group: 'flujo',
    input: '/rpec',
    expectAny: [/¿qu[eé] pas[óo]\?/i],
    followUp: { input: 'mi jefe me llamó de imprevisto', expectAny: [/qu[eé] pensamiento/i] },
  },
  {
    group: 'flujo',
    input: '/procrastinacion',
    expectAny: [/alivio r[áa]pido/i],
    followUp: { input: 'terminar reporte trimestral', expectAny: [/A\).*B\).*C\).*D\)/is] },
  },
  {
    group: 'flujo',
    input: '/espiritual',
    expectAny: [/A\).*oraci[óo]n/i],
    followUp: { input: 'B', expectAny: [/gratitud/i] },
  },

  // ── Crisis sigue ganando ────────────────────────────────────────────
  { group: 'crisis', input: 'no quiero seguir', expectAny: [/quiero que est[ée]s a salvo|línea de crisis local|emergencias/i] },
  { group: 'crisis', input: 'quiero morir', expectAny: [/quiero que est[ée]s a salvo|línea de crisis local|emergencias/i] },
  { group: 'crisis', input: 'no veo salida', expectAny: [/quiero que est[ée]s a salvo|línea de crisis local|emergencias/i] },
  // Crisis durante un flujo abierto
  {
    group: 'crisis',
    input: '/rpec',
    expectAny: [/¿qu[eé] pas[óo]\?/i],
    followUp: { input: 'mejor desaparecer', expectAny: [/quiero que est[ée]s a salvo|línea de crisis local|emergencias/i] },
  },
];

async function main() {
  const storage = new MemoryStorageProvider();
  await storage.connect('verify');
  const adapter = new CaptureAdapter();
  const domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
  const orch = new Orchestrator(adapter, domain, cfg(), storage.sessionStore);
  await orch.start();

  let pass = 0, fail = 0;
  const fails: Array<{ group: string; input: string; got: string; reason: string }> = [];

  for (const c of cases) {
    // Cada caso empieza con sesión limpia para evitar fugas entre tests.
    await storage.adhdCoachStore.resetAllUserState('menu');
    await storage.sessionStore.clearPendingInput('menu');
    await storage.sessionStore.clearPendingAction('menu');
    adapter.reset();

    if (c.setup) {
      for (const s of c.setup) await adapter.send(s);
    }

    await adapter.send(c.input);
    const r1 = adapter.last();

    const target = c.followUp ? null : r1;
    let actual = r1;
    let label = c.input;

    if (c.followUp) {
      adapter.reset();
      await adapter.send(c.followUp.input);
      actual = adapter.last();
      label = `${c.input} → ${c.followUp.input}`;
    }

    const checks = c.followUp ? c.followUp.expectAny : c.expectAny;
    const forbid = c.followUp ? c.followUp.forbid : c.forbid;
    const ok =
      checks.some((re) => re.test(actual)) &&
      (!forbid || !forbid.some((re) => re.test(actual)));

    if (ok) {
      pass++;
      console.log(`  ✓ [${c.group}] ${label}`);
    } else {
      fail++;
      const reason = checks.some((re) => re.test(actual))
        ? 'forbidden pattern matched'
        : 'expected pattern did not match';
      fails.push({ group: c.group, input: label, got: actual.slice(0, 200), reason });
      console.log(`  ✗ [${c.group}] ${label}`);
      console.log(`      reason: ${reason}`);
      console.log(`      got:    ${actual.slice(0, 200).replace(/\n/g, ' | ')}`);
    }
  }

  console.log(`\n=== RESUMEN ===`);
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  console.log(`TOTAL: ${cases.length}`);
  if (fails.length > 0) {
    console.log(`\n=== FALLOS DETALLE ===`);
    for (const f of fails) {
      console.log(`[${f.group}] ${f.input}`);
      console.log(`  reason: ${f.reason}`);
      console.log(`  got: ${f.got.replace(/\n/g, ' | ')}`);
      console.log('');
    }
  }

  await orch.stop();
  await storage.disconnect();
  process.exit(fails.length > 0 ? 1 : 0);
}

main();
