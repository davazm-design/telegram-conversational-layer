/**
 * Walkthrough humano: simula a un usuario con TDAH probando el bot de
 * forma natural, con todas las variantes que un humano usaría.
 *
 * Para cada caso:
 *   - expectAny: si CUALQUIERA matchea → PASS.
 *   - expectFallbackOk?: si es true, fallback es aceptable (caso ambiguo).
 *   - description: qué probaría un humano y por qué.
 *
 * Reporta PASS / FAIL / WARN. WARN = el bot respondió pero la respuesta
 * podría ser mejor (no es fallback pero no es el handler ideal).
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
  async s(text: string, uid = 'human') {
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

const FALLBACK = /No lo entend[íi] del todo/i;
// Otros mensajes de error "claros" (no son el fallback genérico).
// Si un caso fallbackOk acepta cualquiera de estos, lo contamos como WARN
// en vez de FAIL (el bot está respondiendo útilmente).
const CLEAR_ERROR = /No entend[íi]|necesito|no encontr[ée]|prueba con|⚠️/i;

interface Case {
  category: string;
  description: string;
  setup?: string[];
  input: string;
  expectAny: RegExp[];
  forbid?: RegExp[];
  // Si es true: caer en fallback es aceptable (caso intrínsecamente ambiguo).
  fallbackOk?: boolean;
}

const cases: Case[] = [
  // ── 1. CREAR RECORDATORIO — variantes naturales del verbo "recordar" ──
  { category: 'crear-recordatorio', description: '/recordar canónico', input: '/recordar mañana 9am llamar al doctor', expectAny: [/recordatorio guardado/i] },
  { category: 'crear-recordatorio', description: '/recordatorio singular', input: '/recordatorio mañana 9am llamar al doctor', expectAny: [/recordatorio guardado/i] },
  { category: 'crear-recordatorio', description: 'recuérdame con tilde', input: 'recuérdame mañana 9am llamar', expectAny: [/recordatorio guardado/i] },
  { category: 'crear-recordatorio', description: 'recuerdame sin tilde', input: 'recuerdame mañana 9am llamar', expectAny: [/recordatorio guardado/i] },
  { category: 'crear-recordatorio', description: 'recordarme (infinitivo+me)', input: 'recordarme mañana 9am llamar', expectAny: [/recordatorio guardado/i] },
  { category: 'crear-recordatorio', description: 'me recuerdas (NL)', input: 'me recuerdas mañana 9am llamar al doctor', expectAny: [/recordatorio guardado/i] },
  { category: 'crear-recordatorio', description: 'necesito que me recuerdes', input: 'necesito que me recuerdes mañana 9am llamar al doctor', expectAny: [/recordatorio guardado/i] },
  { category: 'crear-recordatorio', description: 'agrega un recordatorio', input: 'agrega un recordatorio para mañana 9am: llamar al doctor', expectAny: [/recordatorio guardado/i] },
  { category: 'crear-recordatorio', description: 'ponme un recordatorio', input: 'ponme un recordatorio mañana 9am llamar al doctor', expectAny: [/recordatorio guardado/i] },
  { category: 'crear-recordatorio', description: 'crea un recordatorio', input: 'crea un recordatorio mañana 9am llamar al doctor', expectAny: [/recordatorio guardado/i] },

  // ── 2. EXPRESIONES DE TIEMPO COLOQUIALES ──────────────────────────────
  { category: 'tiempo-coloquial', description: 'mediodía', input: '/recordar mañana al mediodía comer', expectAny: [/recordatorio guardado/i] },
  { category: 'tiempo-coloquial', description: 'medianoche', input: '/recordar mañana a medianoche algo', expectAny: [/recordatorio guardado/i] },
  { category: 'tiempo-coloquial', description: 'en la mañana', input: '/recordar mañana en la mañana algo', expectAny: [/recordatorio guardado/i], fallbackOk: true },
  { category: 'tiempo-coloquial', description: 'en la tarde', input: '/recordar mañana en la tarde algo', expectAny: [/recordatorio guardado/i], fallbackOk: true },
  { category: 'tiempo-coloquial', description: 'en la noche', input: '/recordar mañana en la noche algo', expectAny: [/recordatorio guardado/i], fallbackOk: true },
  { category: 'tiempo-coloquial', description: 'al rato', input: '/recordar al rato algo', expectAny: [/recordatorio guardado/i], fallbackOk: true },
  { category: 'tiempo-coloquial', description: 'en un rato', input: '/recordar en un rato algo', expectAny: [/recordatorio guardado/i], fallbackOk: true },
  { category: 'tiempo-coloquial', description: 'en 5 min', input: '/recordar en 5 min algo', expectAny: [/recordatorio guardado/i] },
  { category: 'tiempo-coloquial', description: 'en 30 segundos', input: '/recordar en 30 segundos algo', expectAny: [/recordatorio guardado/i], fallbackOk: true },
  { category: 'tiempo-coloquial', description: 'en 1 semana', input: '/recordar en 1 semana algo', expectAny: [/recordatorio guardado/i], fallbackOk: true },
  { category: 'tiempo-coloquial', description: 'la próxima semana', input: '/recordar la próxima semana algo', expectAny: [/recordatorio guardado/i], fallbackOk: true },

  // ── 3. DÍAS DE LA SEMANA Y FECHAS ─────────────────────────────────────
  { category: 'dias-semana', description: 'el próximo lunes', input: '/recordar el próximo lunes 9am llamar', expectAny: [/recordatorio guardado/i], fallbackOk: true },
  { category: 'dias-semana', description: 'lunes', input: '/recordar el lunes 9am llamar', expectAny: [/recordatorio guardado/i] },
  { category: 'dias-semana', description: 'viernes sin hora', input: '/recordar el viernes algo', expectAny: [/qu[eé] hora|hora ese d[ií]a/i] },
  { category: 'dias-semana', description: 'sábado 10am', input: '/recordar sábado 10am llamar', expectAny: [/recordatorio guardado/i] },
  { category: 'fechas', description: '21/05 9am', input: '/recordar 21/05 9am algo', expectAny: [/recordatorio guardado/i] },
  { category: 'fechas', description: 'ISO 2026-05-21 9am', input: '/recordar 2026-05-21 9am algo', expectAny: [/recordatorio guardado/i] },
  { category: 'fechas', description: 'el 21 de mayo 9am', input: '/recordar el 21 de mayo 9am algo', expectAny: [/recordatorio guardado/i] },
  { category: 'fechas', description: 'pasado mañana', input: '/recordar pasado mañana 9am algo', expectAny: [/recordatorio guardado/i] },

  // ── 4. RECORDATORIO SIN HORA O SIN TEXTO ──────────────────────────────
  { category: 'parcial', description: '/recordar sin args', input: '/recordar', expectAny: [/cu[áa]l es|cu[áa]l|qu[eé]/i] },
  { category: 'parcial', description: '/recordar solo hora sin texto', input: '/recordar mañana 9am', expectAny: [/qu[eé] quieres recordar|necesito tambi[eé]n|texto/i], fallbackOk: true },
  { category: 'parcial', description: '/recordar solo texto sin hora', input: '/recordar comprar pan', expectAny: [/no entend[íi] el tiempo|qu[eé] hora|hora/i] },

  // ── 5. EDITAR / CANCELAR RECORDATORIOS ────────────────────────────────
  { category: 'editar-recordatorio', description: 'cancelar por número', setup: ['/recordar mañana 9am algo'], input: '/cancelar_recordatorio 1', expectAny: [/Cancelado/i] },
  { category: 'editar-recordatorio', description: 'cancela el recordatorio 1', setup: ['/recordar mañana 9am algo'], input: 'cancela el recordatorio 1', expectAny: [/Cancelado/i], fallbackOk: true },
  { category: 'editar-recordatorio', description: 'borra recordatorio 1', setup: ['/recordar mañana 9am algo'], input: 'borra recordatorio 1', expectAny: [/Cancelado|Borrad/i], fallbackOk: true },
  { category: 'editar-recordatorio', description: 'elimina el recordatorio 2', setup: ['/recordar mañana 9am a', '/recordar mañana 10am b'], input: 'elimina el recordatorio 2', expectAny: [/Cancelado|Borrad/i], fallbackOk: true },
  { category: 'editar-recordatorio', description: 'cambia recordatorio 1 a las 10am', setup: ['/recordar mañana 9am algo'], input: 'cambia el recordatorio 1 a las 10am', expectAny: [/cambiado|modificado|actualizado/i], fallbackOk: true },

  // ── 6. VER RECORDATORIOS — variantes NL ──────────────────────────────
  { category: 'ver-recordatorios', description: '/recordatorios', setup: ['/recordar mañana 9am a'], input: '/recordatorios', expectAny: [/recordatorios pendientes/i] },
  { category: 'ver-recordatorios', description: 'cuáles son mis recordatorios', setup: ['/recordar mañana 9am a'], input: 'cuáles son mis recordatorios', expectAny: [/recordatorios pendientes/i] },
  { category: 'ver-recordatorios', description: 'qué recordatorios tengo', setup: ['/recordar mañana 9am a'], input: 'qué recordatorios tengo', expectAny: [/recordatorios pendientes/i], fallbackOk: true },
  { category: 'ver-recordatorios', description: 'mis pendientes', setup: ['/recordar mañana 9am a'], input: 'mis pendientes', expectAny: [/recordatorios pendientes|foco|micro/i], fallbackOk: true },

  // ── 7. AGENDA — variantes de volcado ──────────────────────────────────
  { category: 'agenda-volcado', description: 'lista con saltos de línea', input: '/agenda comprar pan\nllamar al doctor\nentregar reporte', expectAny: [/Lo separé/i] },
  { category: 'agenda-volcado', description: 'lista con comas', input: '/agenda comprar pan, llamar al doctor, entregar reporte', expectAny: [/Lo separé/i] },
  { category: 'agenda-volcado', description: 'lista con guiones', input: '/agenda - comprar pan\n- llamar al doctor\n- entregar reporte', expectAny: [/Lo separé/i] },
  { category: 'agenda-volcado', description: 'lista con números', input: '/agenda 1. comprar pan\n2. llamar al doctor\n3. entregar reporte', expectAny: [/Lo separé/i] },
  { category: 'agenda-volcado', description: 'mezcla con " y "', input: '/agenda comprar pan y leche y huevos', expectAny: [/Lo separé/i] },
  { category: 'agenda-volcado', description: 'frase con rango "entre 22 y 23"', input: '/agenda Entre 22 y 23 estudio\nvacuna VSR\nllamar doctor', expectAny: [/Lo separé/i] },

  // ── 8. SELECCIÓN EN /agenda ───────────────────────────────────────────
  { category: 'agenda-seleccion', description: 'números 1, 3', setup: ['/agenda A, B, C, D'], input: '1, 3', expectAny: [/Carg[uú]é/i] },
  { category: 'agenda-seleccion', description: '"todos"', setup: ['/agenda A, B, C'], input: 'todos', expectAny: [/Carg[uú]é/i] },
  { category: 'agenda-seleccion', description: '"todas"', setup: ['/agenda A, B, C'], input: 'todas', expectAny: [/Carg[uú]é/i] },
  { category: 'agenda-seleccion', description: '"los importantes" (NL vago)', setup: ['/agenda A, B, C'], input: 'los importantes', expectAny: [/Carg[uú]é/i], fallbackOk: true },
  { category: 'agenda-seleccion', description: '"primero y tercero"', setup: ['/agenda A, B, C'], input: 'primero y tercero', expectAny: [/Carg[uú]é/i], fallbackOk: true },
  { category: 'agenda-seleccion', description: '"todos menos el 2"', setup: ['/agenda A, B, C'], input: 'todos menos el 2', expectAny: [/Carg[uú]é/i], fallbackOk: true },
  { category: 'agenda-seleccion', description: '"ninguno"', setup: ['/agenda A, B, C'], input: 'ninguno', expectAny: [/no guardé nada/i] },

  // ── 9. EDITAR MICROTAREAS (Fase 4.1) ──────────────────────────────────
  { category: 'editar-microtask', description: '/borrar N', setup: ['/agenda A, B, C', 'todos'], input: '/borrar 2', expectAny: [/Borrada/i] },
  { category: 'editar-microtask', description: 'borra el 2 NL', setup: ['/agenda A, B, C', 'todos'], input: 'borra el 2', expectAny: [/Borrada/i] },
  { category: 'editar-microtask', description: 'elimina la 2', setup: ['/agenda A, B, C', 'todos'], input: 'elimina la 2', expectAny: [/Borrada/i], fallbackOk: true },
  { category: 'editar-microtask', description: 'quita el 2', setup: ['/agenda A, B, C', 'todos'], input: 'quita el 2', expectAny: [/Borrada/i] },
  { category: 'editar-microtask', description: '/editar N nuevo texto', setup: ['/agenda A, B, C', 'todos'], input: '/editar 2 nuevo texto', expectAny: [/Cambiada/i] },
  { category: 'editar-microtask', description: 'cambia el 2 a algo', setup: ['/agenda A, B, C', 'todos'], input: 'cambia el 2 a algo nuevo', expectAny: [/Cambiada/i] },

  // ── 10. SALUDOS, AGRADECIMIENTOS, CHARLA ─────────────────────────────
  { category: 'social', description: 'hola', input: 'hola', expectAny: [/hola|asistente|ayudarte/i], fallbackOk: true },
  { category: 'social', description: 'buenos días', input: 'buenos días', expectAny: [/check.?in|hola|d[ií]a/i] },
  { category: 'social', description: 'qué tal', input: 'qué tal', expectAny: [/hola|qué tal|ayudarte/i], fallbackOk: true },
  { category: 'social', description: 'gracias', input: 'gracias', expectAny: [/de nada|con gusto|para servir/i], fallbackOk: true },
  { category: 'social', description: 'perfecto', input: 'perfecto', expectAny: [/de nada|genial|me alegra|qué bien/i], fallbackOk: true },
  { category: 'social', description: 'adiós', input: 'adiós', expectAny: [/hasta|adi[óo]s|cu[íi]date/i], fallbackOk: true },

  // ── 11. MENSAJES AMBIGUOS Y EMOCIONALES (no crisis) ──────────────────
  { category: 'emocional', description: 'estoy cansado', input: 'estoy cansado', expectAny: [/pausa|cansancio|silencio/i], fallbackOk: true },
  { category: 'emocional', description: 'tengo mucho que hacer', input: 'tengo mucho que hacer', expectAny: [/ordenar|vuélcame|agenda/i], fallbackOk: true },
  { category: 'emocional', description: 'no logro concentrarme', input: 'no logro concentrarme', expectAny: [/pausa|modo alerta|focus|amenaza/i], fallbackOk: true },
  { category: 'emocional', description: 'hoy fue un día difícil', input: 'hoy fue un día difícil', expectAny: [/cu[eé]ntame|pausa|gracia/i], fallbackOk: true },
  { category: 'emocional', description: 'no me siento bien', input: 'no me siento bien', expectAny: [/qu[eé] necesitas|cu[eé]ntame|pausa/i], fallbackOk: true },

  // ── 12. ERRORES TÍPICOS — typos, mayúsculas, espacios ────────────────
  { category: 'errores-typo', description: '/RECORDAR mayúsculas', input: '/RECORDAR mañana 9am algo', expectAny: [/recordatorio guardado/i] },
  { category: 'errores-typo', description: '/Recordar capitalizado', input: '/Recordar mañana 9am algo', expectAny: [/recordatorio guardado/i] },
  { category: 'errores-typo', description: 'recordar mañana sin slash', input: 'recordar mañana 9am algo', expectAny: [/recordatorio guardado/i], fallbackOk: true },
  { category: 'errores-typo', description: 'espacios extra al inicio', input: '  /recordar mañana 9am algo', expectAny: [/recordatorio guardado/i] },
  { category: 'errores-typo', description: 'typo recodatorio', input: '/recodatorio mañana 9am algo', expectAny: [/recordatorio guardado/i], fallbackOk: true },
  { category: 'errores-typo', description: 'emoji al final', input: '/recordar mañana 9am tomar pastilla 💊', expectAny: [/recordatorio guardado/i] },

  // ── 13. CRISIS DURANTE FLUJOS — siempre gana ─────────────────────────
  { category: 'crisis', description: 'crisis directa', input: 'no quiero seguir', expectAny: [/quiero que est[ée]s a salvo/i] },
  { category: 'crisis', description: 'crisis durante /rpec', setup: ['/rpec'], input: 'mejor desaparecer', expectAny: [/quiero que est[ée]s a salvo/i] },
  { category: 'crisis', description: 'crisis durante /agenda volcado', setup: ['/agenda'], input: 'no veo salida', expectAny: [/quiero que est[ée]s a salvo/i] },
  { category: 'crisis', description: 'crisis durante selección', setup: ['/agenda A, B, C'], input: 'quiero morir', expectAny: [/quiero que est[ée]s a salvo/i] },

  // ── 14. PRIVACIDAD Y BORRADO ─────────────────────────────────────────
  { category: 'privacidad', description: '/privacidad', input: '/privacidad', expectAny: [/contexto declarado|cosmovis/i] },
  { category: 'privacidad', description: 'qué guardas de mí', input: 'qué guardas de mí', expectAny: [/contexto|cosmovis|guardo/i] },
  { category: 'privacidad', description: 'qué sabes de mí', input: 'qué sabes de mi', expectAny: [/contexto|cosmovis|guardo/i] },
  { category: 'privacidad', description: 'borrar todo', input: 'borrar todo', expectAny: [/Confirmaci[óo]n requerida/i] },
  { category: 'privacidad', description: 'borra mis datos', input: 'borra mis datos', expectAny: [/Confirmaci[óo]n requerida/i] },

  // ── 15. AGENDA — re-entrada y estado ─────────────────────────────────
  { category: 'agenda-estado', description: '/agenda con tareas existentes', setup: ['/agenda A, B, C', 'todos'], input: '/agenda', expectAny: [/Tienes ya .* micro-tarea/i] },
  { category: 'agenda-estado', description: '/focus muestra tareas guardadas', setup: ['/agenda A, B, C', 'todos'], input: '/focus', expectAny: [/foco/i] },
  { category: 'agenda-estado', description: 'qué tengo hoy', setup: ['/agenda A, B, C', 'todos'], input: 'qué tengo hoy', expectAny: [/foco|micro/i] },

  // ── 16. PROCRASTINACIÓN Y NEURO-RESET ────────────────────────────────
  { category: 'proc-neuro', description: '/reset90', input: '/reset90', expectAny: [/pausa|exhala/i] },
  { category: 'proc-neuro', description: 'estoy saturado', input: 'estoy saturado', expectAny: [/pausa|exhala/i] },
  { category: 'proc-neuro', description: '/procrastinacion', input: '/procrastinacion', expectAny: [/alivio r[áa]pido/i] },
  { category: 'proc-neuro', description: 'tarea evitada tras /procrastinacion', setup: ['/procrastinacion'], input: 'limpiar el garaje', expectAny: [/bajarla de amenaza|A\)/i] },

  // ── 17. TCC — flujos y respuestas válidas ────────────────────────────
  { category: 'tcc', description: '/rpec arranca', input: '/rpec', expectAny: [/qu[eé] pas[óo]/i] },
  { category: 'tcc', description: '/rpec con "no sé" como respuesta', setup: ['/rpec'], input: 'no sé', expectAny: [/qu[eé] pensamiento/i] },
  { category: 'tcc', description: '/reencuadre arranca', input: '/reencuadre', expectAny: [/hip[óo]tesis/i] },
  { category: 'tcc', description: '/dopar arranca', input: '/dopar', expectAny: [/define el problema/i] },
  { category: 'tcc', description: 'frase automática "no sirvo"', input: 'no sirvo para esto', expectAny: [/hip[óo]tesis/i] },

  // ── 18. ESPIRITUALIDAD ───────────────────────────────────────────────
  { category: 'espiritual', description: '/oracion', input: '/oracion', expectAny: [/Señor|amén/i] },
  { category: 'espiritual', description: '/oración con tilde', input: '/oración', expectAny: [/Señor|amén/i] },
  { category: 'espiritual', description: '/devocional', input: '/devocional', expectAny: [/verdad|amén/i] },
  { category: 'espiritual', description: '/espiritual', input: '/espiritual', expectAny: [/A\).*oraci[óo]n/i] },
  { category: 'espiritual', description: 'fe + procrastinación', input: 'Dios ayúdame con esta procrastinación', expectAny: [/neurociencia|espiritualidad|ambos/i] },

  // ── 19. ESCAPES Y CANCELACIÓN ────────────────────────────────────────
  { category: 'escape', description: '/cancel mid-flow', setup: ['/rpec'], input: '/cancel', expectAny: [/cancelada|cancelar/i] },
  { category: 'escape', description: 'slash command durante TCC', setup: ['/rpec'], input: '/recordatorios', expectAny: [/recordatorios pendientes|no tienes/i] },
  { category: 'escape', description: 'slash command durante /agenda', setup: ['/agenda'], input: '/focus', expectAny: [/foco|micro|no tienes/i] },
];

async function main() {
  const storage = new MemoryStorageProvider();
  await storage.connect('human');
  const adapter = new A();
  const domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
  const cfg: AppConfig = {
    telegram: { botToken: 'x', mode: 'polling', webhookSecret: '', publicWebhookUrl: '', port: 0 },
    llm: { enabled: false, provider: 'openai', openaiApiKey: '' },
    storage: { provider: 'memory', databaseUrl: '' },
    logLevel: 'error',
  };
  const orch = new Orchestrator(adapter, domain, cfg, storage.sessionStore);
  await orch.start();

  const results = { PASS: 0, FAIL: 0, WARN: 0 };
  const issues: Array<{ category: string; description: string; input: string; got: string; tag: 'FAIL' | 'WARN' }> = [];

  for (const c of cases) {
    // Reset estado del usuario para evitar fugas entre casos.
    await storage.adhdCoachStore.resetAllUserState('human');
    await storage.sessionStore.clearPendingInput('human');
    await storage.sessionStore.clearPendingAction('human');
    adapter.reset();

    if (c.setup) {
      for (const s of c.setup) await adapter.s(s);
    }
    adapter.reset();
    await adapter.s(c.input);
    const got = adapter.last();

    const matched = c.expectAny.some((re) => re.test(got));
    const forbidden = c.forbid?.some((re) => re.test(got)) ?? false;
    const isFallback = FALLBACK.test(got);

    if (matched && !forbidden) {
      results.PASS++;
    } else if (c.fallbackOk && (isFallback || CLEAR_ERROR.test(got))) {
      // Fallback genérico OK ó mensaje de error claro y orientador: WARN.
      results.WARN++;
      issues.push({ category: c.category, description: c.description, input: c.input, got: got.slice(0, 150), tag: 'WARN' });
    } else {
      results.FAIL++;
      issues.push({ category: c.category, description: c.description, input: c.input, got: got.slice(0, 150), tag: 'FAIL' });
    }
  }

  console.log(`\n=== RESUMEN ===`);
  console.log(`PASS:  ${results.PASS}`);
  console.log(`WARN:  ${results.WARN}  (fallback aceptable en casos ambiguos)`);
  console.log(`FAIL:  ${results.FAIL}  (bot debería entender pero falla)`);
  console.log(`TOTAL: ${cases.length}`);

  if (issues.length > 0) {
    const byCat = new Map<string, typeof issues>();
    for (const i of issues) {
      const arr = byCat.get(i.category) ?? [];
      arr.push(i);
      byCat.set(i.category, arr);
    }
    console.log(`\n=== DETALLE POR CATEGORÍA ===`);
    for (const [cat, list] of byCat) {
      console.log(`\n[${cat}]`);
      for (const i of list) {
        console.log(`  ${i.tag}  ${i.description}`);
        console.log(`        in:  "${i.input}"`);
        console.log(`        got: "${i.got.replace(/\n/g, ' | ')}"`);
      }
    }
  }

  await orch.stop();
  await storage.disconnect();
  process.exit(results.FAIL > 0 ? 1 : 0);
}

main();
