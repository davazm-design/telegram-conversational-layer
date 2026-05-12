/**
 * Example Domain: ADHD Coach
 *
 * Coach para personas con TDAH. Capabilities:
 *  - Check-in diario, micro-tareas (≤15 min), Pomodoros, listado de foco, reset_day.
 *  - Fase 2 (acercamiento al MVP conceptual de Compás):
 *      • /silencio (con duración opcional)
 *      • /privacidad
 *      • Borrado total del estado (HIGH_RISK + confirmación)
 *      • /abandonar (anti-abandono)
 *      • /reinicio (sin culpa)
 *      • /agenda (volcado en bruto + clasificación)
 *
 * NO diagnostica, NO sustituye terapia. El pre-filter global de seguridad
 * (src/security/crisis.detector.ts) intercepta crisis antes de que cualquier
 * acción de este dominio se ejecute.
 */

import {
  IDomainHandler,
  Capability,
  ActionResult,
  RiskLevel,
  RulePattern,
} from '../core/types';

import { IAdhdCoachStore } from '../core/storage/interfaces';

// ─── Heurística ligera de clasificación de tareas ────────────────────────────
// Keyword-based, sin NLP. Mismo criterio que el MVP conceptual.

type Category = 'laboral' | 'personal' | 'mantenimiento' | 'espiritual' | 'otros';

const CATEGORY_KEYWORDS: Record<Exclude<Category, 'otros'>, string[]> = {
  laboral: [
    'junta', 'juntas', 'reunion', 'reunión', 'propuesta', 'propuestas',
    'correo', 'correos', 'email', 'emails', 'jefe', 'jefa', 'oficina',
    'cliente', 'clientes', 'informe', 'informes', 'presentacion',
    'presentación', 'deadline', 'entregable', 'proyecto', 'trabajo',
    'reporte', 'reportes',
  ],
  personal: [
    'ejercicio', 'gym', 'gimnasio', 'doctor', 'doctora', 'dentista',
    'medico', 'médico', 'cita medica', 'cita médica',
    'padre', 'madre', 'hijo', 'hija', 'pareja', 'familia',
    'amigo', 'amiga', 'correr', 'caminar',
  ],
  mantenimiento: [
    'pagar', 'factura', 'facturas', 'banco', 'cuenta', 'cuentas',
    'tarjeta', 'tarjetas', 'mercado', 'supermercado', 'comprar',
    'compra', 'lavar', 'limpieza', 'limpiar', 'ropa', 'comida',
    'casa', 'mantenimiento', 'recibo', 'renta',
  ],
  espiritual: [
    'orar', 'oracion', 'oración', 'rezar', 'meditar', 'meditacion',
    'meditación', 'gratitud', 'silencio espiritual',
    'examen de conciencia', 'misa', 'biblia', 'lectura espiritual',
    'intencion del dia', 'intención del día',
  ],
};

function stripAccentsLower(s: string): string {
  return s
    .toLowerCase()
    .replace(/[áéíóúüÁÉÍÓÚÜ]/g, (c) =>
      ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u',
         Á: 'a', É: 'e', Í: 'i', Ó: 'o', Ú: 'u', Ü: 'u' } as Record<string, string>)[c] ?? c,
    );
}

function classifyItem(item: string): Category {
  const n = stripAccentsLower(item);
  for (const cat of ['laboral', 'personal', 'mantenimiento', 'espiritual'] as const) {
    for (const kw of CATEGORY_KEYWORDS[cat]) {
      if (n.includes(kw)) return cat;
    }
  }
  return 'otros';
}

// ─── Fase 3: Parser de tiempo para recordatorios ─────────────────────────────
// Soporta: "en Xh/min/dias <texto>", "hoy [a las] HH[:MM][am|pm] <texto>",
// "mañana [a las] HH[:MM][am|pm] <texto>", "mañana <texto>" (sin hora → pide),
// "HH:MM <texto>", "HHam/pm <texto>" (hoy si futuro, mañana si pasó).

type ParseResult =
  | { ok: true; dueAt: Date; text: string }
  | { ok: false; reason: 'tomorrow_needs_hour'; text: string }
  | { ok: false; reason: 'missing_text' }
  | { ok: false; reason: 'missing_time' };

function normalizeForParse(s: string): string {
  return s
    .toLowerCase()
    .replace(/[áéíóúü]/g, (c) =>
      ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u' } as Record<string, string>)[c] ?? c)
    .replace(/ñ/g, 'n')
    .trim();
}

function hourTo24(h: number, ampm?: string): number | null {
  if (!Number.isFinite(h) || h < 0) return null;
  if (ampm) {
    const ap = ampm.toLowerCase();
    if (h < 1 || h > 12) return null;
    if (ap === 'pm') return h === 12 ? 12 : h + 12;
    if (ap === 'am') return h === 12 ? 0 : h;
  }
  if (h > 23) return null;
  return h;
}

function capFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// ─── Helpers de zona horaria ────────────────────────────────────────────────
// El parser DEBE interpretar horas en la TZ del usuario (REMINDER_TZ),
// no en la TZ del runtime. En Railway, runtime=UTC, así que `setHours(11)`
// guardaba "11am UTC", que al renderizar en MX (UTC-6) salía como 05:00.

function reminderTz(): string {
  return process.env.REMINDER_TZ || 'America/Mexico_City';
}

interface WallCalendar { year: number; month0: number; day: number; hour: number; minute: number }

/**
 * Devuelve los componentes de la fecha (year/month0/day/hour/minute) tal
 * como se ven en `tz`. Usado para saber qué día es "hoy" para el usuario.
 */
function getCalendarPartsInTz(date: Date, tz: string): WallCalendar {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  return {
    year: parseInt(map.year, 10),
    month0: parseInt(map.month, 10) - 1,
    day: parseInt(map.day, 10),
    hour: parseInt(map.hour === '24' ? '0' : map.hour, 10),
    minute: parseInt(map.minute, 10),
  };
}

/**
 * Construye un Date que representa la WALL TIME indicada (year/month0/day/
 * hour/minute) en la zona horaria `tz`. Devuelve el instante UTC correcto.
 *
 * Algoritmo robusto frente a DST: toma un candidato como si la wall time
 * fuera UTC, mide en cuánto se desplaza al expresarla en la TZ destino, y
 * compensa. Funciona tanto para TZs con DST como sin DST.
 */
function makeDateInTz(year: number, month0: number, day: number, hour: number, minute: number, tz: string): Date {
  const candidate = new Date(Date.UTC(year, month0, day, hour, minute));
  const wall = getCalendarPartsInTz(candidate, tz);
  const wallAsUtc = Date.UTC(wall.year, wall.month0, wall.day, wall.hour, wall.minute);
  const offsetMs = wallAsUtc - candidate.getTime();
  return new Date(candidate.getTime() - offsetMs);
}

/** Suma 1 día a una fecha de calendario, manejando wrap de mes/año. */
function addOneDay(d: WallCalendar): WallCalendar {
  const t = new Date(Date.UTC(d.year, d.month0, d.day));
  t.setUTCDate(t.getUTCDate() + 1);
  return { year: t.getUTCFullYear(), month0: t.getUTCMonth(), day: t.getUTCDate(), hour: 0, minute: 0 };
}

export function parseReminderSpec(spec: string, now: Date = new Date()): ParseResult {
  const norm = normalizeForParse(spec);
  if (!norm) return { ok: false, reason: 'missing_time' };
  const tz = reminderTz();
  const today = getCalendarPartsInTz(now, tz);

  // 1) "en X (min|h|d) <texto>" — relativo, TZ-independent
  let m = norm.match(/^en\s+(\d+)\s*(min(?:utos?)?|h|hora|horas|d|dia|dias)\b\s*(.*)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const text = (m[3] ?? '').trim();
    if (!text) return { ok: false, reason: 'missing_text' };
    let ms = 0;
    if (unit.startsWith('min')) ms = n * 60_000;
    else if (unit === 'h' || unit.startsWith('hora')) ms = n * 3_600_000;
    else ms = n * 86_400_000;
    return { ok: true, dueAt: new Date(now.getTime() + ms), text: capFirst(text) };
  }

  // 2) "hoy [a las] HH[:MM] [am|pm] <texto>" — wall time HOY en TZ del usuario
  m = norm.match(/^hoy\s+(?:a\s+las\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(.+)$/);
  if (m) {
    const h = hourTo24(parseInt(m[1], 10), m[3]);
    if (h === null) return { ok: false, reason: 'missing_time' };
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    if (mins < 0 || mins > 59) return { ok: false, reason: 'missing_time' };
    const text = m[4].trim();
    if (!text) return { ok: false, reason: 'missing_text' };
    const due = makeDateInTz(today.year, today.month0, today.day, h, mins, tz);
    return { ok: true, dueAt: due, text: capFirst(text) };
  }

  // 3) "manana [a las] HH[:MM] [am|pm] <texto>" — wall time MAÑANA en TZ
  m = norm.match(/^manana\s+(?:a\s+las\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(.+)$/);
  if (m) {
    const h = hourTo24(parseInt(m[1], 10), m[3]);
    if (h === null) return { ok: false, reason: 'missing_time' };
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    if (mins < 0 || mins > 59) return { ok: false, reason: 'missing_time' };
    const text = m[4].trim();
    if (!text) return { ok: false, reason: 'missing_text' };
    const tomorrow = addOneDay(today);
    const due = makeDateInTz(tomorrow.year, tomorrow.month0, tomorrow.day, h, mins, tz);
    return { ok: true, dueAt: due, text: capFirst(text) };
  }

  // 4) "manana <texto>" sin hora explícita → pedir hora
  m = norm.match(/^manana\s+(.+)$/);
  if (m) {
    const text = m[1].trim();
    if (!text) return { ok: false, reason: 'missing_text' };
    return { ok: false, reason: 'tomorrow_needs_hour', text: capFirst(text) };
  }

  // 5) "[a las] HH:MM <texto>" o "HHam/pm <texto>"
  //    → hoy si futuro (en TZ del usuario), mañana si ya pasó.
  m = norm.match(/^(?:a\s+las\s+)?(\d{1,2})(?::(\d{2})|\s*(am|pm))\s+(.+)$/);
  if (m) {
    const h = hourTo24(parseInt(m[1], 10), m[3]);
    if (h === null) return { ok: false, reason: 'missing_time' };
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    if (mins < 0 || mins > 59) return { ok: false, reason: 'missing_time' };
    const text = m[4].trim();
    if (!text) return { ok: false, reason: 'missing_text' };
    let due = makeDateInTz(today.year, today.month0, today.day, h, mins, tz);
    if (due.getTime() <= now.getTime()) {
      const tomorrow = addOneDay(today);
      due = makeDateInTz(tomorrow.year, tomorrow.month0, tomorrow.day, h, mins, tz);
    }
    return { ok: true, dueAt: due, text: capFirst(text) };
  }

  return { ok: false, reason: 'missing_time' };
}

/** Parsea SOLO una hora (sin texto). Usado para completar drafts pendientes. */
export function parseTimeOnly(input: string, dayHint: 'today' | 'tomorrow', now: Date = new Date()): Date | null {
  const norm = normalizeForParse(input);
  let m = norm.match(/^(?:manana\s+)?(?:a\s+las\s+)?(\d{1,2})(?::(\d{2})|\s*(am|pm))?$/);
  if (!m) return null;
  const h = hourTo24(parseInt(m[1], 10), m[3]);
  if (h === null) return null;
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  if (mins < 0 || mins > 59) return null;
  const tz = reminderTz();
  const today = getCalendarPartsInTz(now, tz);
  const target = (dayHint === 'tomorrow' || norm.startsWith('manana')) ? addOneDay(today) : today;
  let due = makeDateInTz(target.year, target.month0, target.day, h, mins, tz);
  if (dayHint === 'today' && due.getTime() <= now.getTime()) {
    // si era hoy pero ya pasó, pasa a mañana automáticamente
    const tomorrow = addOneDay(today);
    due = makeDateInTz(tomorrow.year, tomorrow.month0, tomorrow.day, h, mins, tz);
  }
  return due;
}

function splitTaskDump(text: string): string[] {
  return text
    .split(/,|\s+y\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// ─── Parseo de duración para /silencio ───────────────────────────────────────

function parseSilenceDuration(arg: string, now: Date = new Date()): Date {
  const a = stripAccentsLower(arg ?? '').trim();

  // "Xh" o "Xhoras" → now + X horas
  const m = a.match(/^(\d+)\s*h(oras)?$/);
  if (m) {
    const h = parseInt(m[1], 10);
    if (h > 0 && h < 168) {
      return new Date(now.getTime() + h * 3600_000);
    }
  }

  if (a === 'hoy') {
    const today = new Date(now);
    today.setHours(23, 59, 0, 0);
    return today;
  }

  // "hasta manana", "manana", "" (default)
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  return tomorrow;
}

function formatHasta(iso: string): string {
  // YYYY-MM-DD HH:MM (UTC implícito, formato simple y deterministic)
  return iso.replace('T', ' ').slice(0, 16);
}

/**
 * Formato local robusto para mostrar al usuario en el chat.
 * - Acepta null/undefined/string vacío → "fecha no disponible".
 * - Si el string no parsea a Date válido → "fecha no disponible".
 * - Locale/timezone por env (REMINDER_LOCALE, REMINDER_TZ).
 *   Default razonable para uso personal en MX: es-MX, America/Mexico_City.
 */
export function formatLocalDateTime(iso: string | null | undefined): string {
  if (!iso || typeof iso !== 'string') return 'fecha no disponible';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'fecha no disponible';
  try {
    const locale = process.env.REMINDER_LOCALE || 'es-MX';
    const tz = process.env.REMINDER_TZ || 'America/Mexico_City';
    return d.toLocaleString(locale, {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    // Fallback determinista si Intl/timezone fallan en el runtime.
    return iso.replace('T', ' ').slice(0, 16);
  }
}

/**
 * Escapa caracteres especiales de Telegram Markdown v1 (`_*` `[).
 * Necesario porque el adapter envía con parseMode='Markdown' y un
 * caracter sin pareja en el texto del usuario (o en un slash command con
 * `_` como `/cancelar_recordatorio`) hace que Telegram rechace el mensaje
 * con HTTP 400 y el adapter se lo come silenciosamente.
 */
export function escapeMdV1(s: string): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/([_*`\[])/g, '\\$1');
}

// ─── Domain Handler ─────────────────────────────────────────────────────────

export class AdhdCoachDomainHandler implements IDomainHandler {
  readonly domainName = 'ADHD Coach';

  constructor(private store: IAdhdCoachStore) {}

  getCapabilities(): Capability[] {
    return [
      // ── Capabilities existentes (sin cambios) ────────────────────────────
      {
        name: 'daily_checkin',
        description: 'Registra tu check-in diario y recibe motivación',
        parameters: {},
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'list_today_focus',
        description: 'Muestra tus micro-tareas y foco del día',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'add_micro_task',
        description: 'Agrega una micro-tarea (máximo 15 min)',
        parameters: {
          text: { type: 'string', description: 'Descripción corta de la micro-tarea', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'start_focus_session',
        description: 'Inicia una sesión de foco de 25 minutos (Pomodoro)',
        parameters: {
          task: { type: 'string', description: 'En qué te vas a enfocar' },
          minutes: { type: 'number', description: 'Duración en minutos (default: 25)' },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'complete_micro_task',
        description: 'Marca una micro-tarea como hecha',
        parameters: {
          taskId: { type: 'string', description: 'Número o ID de la micro-tarea', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'reset_day',
        description: 'Reinicia las micro-tareas del día (irreversible)',
        parameters: {},
        riskLevel: RiskLevel.HIGH_RISK_ACTION,
        requiresConfirmation: true,
      },

      // ── Fase 2 ───────────────────────────────────────────────────────────
      {
        name: 'set_silence',
        description: 'Activa modo silencio (no enviaré mensajes proactivos hasta que pase)',
        parameters: {
          duration: { type: 'string', description: 'Duración opcional: "2h", "hoy", "hasta mañana"' },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'show_privacy',
        description: 'Muestra qué datos guarda el dominio sobre ti',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'delete_all_state',
        description: 'Borra todo el estado guardado por este dominio (irreversible)',
        parameters: {},
        riskLevel: RiskLevel.HIGH_RISK_ACTION,
        requiresConfirmation: true,
      },
      {
        name: 'anti_abandono',
        description: 'Pausa antes de abandonar una tarea/hábito',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'restart_no_guilt',
        description: 'Reinicio sin culpa tras un parón o racha rota',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'agenda_start',
        description: 'Invita a volcar el día en bruto para ordenarlo',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'agenda_classify',
        description: 'Clasifica un volcado de tareas en categorías',
        parameters: {
          dump: { type: 'string', description: 'Lista en bruto separada por comas o "y"', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        // Solo derivación. NO sustituye al crisis pre-filter global —
        // el pre-filter sigue respondiendo PRIMERO a frases de riesgo.
        name: 'show_crisis_resources',
        description: 'Muestra líneas de crisis y emergencias por país',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      // ── Fase 3: recordatorios programados ────────────────────────────────
      {
        name: 'add_reminder',
        description: 'Crea un recordatorio con hora específica',
        parameters: {
          spec: { type: 'string', description: 'Especificación: tiempo + texto. Ej: "en 2h tomar agua"', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'list_reminders',
        description: 'Lista recordatorios pendientes',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'cancel_reminder',
        description: 'Cancela un recordatorio por número',
        parameters: {
          index: { type: 'string', description: 'Número del recordatorio (1, 2, ...)', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        // Acción interna: el usuario responde con la hora a un draft pendiente.
        name: 'complete_reminder_with_time',
        description: 'Completa un recordatorio pendiente con la hora indicada',
        parameters: {
          timeSpec: { type: 'string', description: 'Hora: ej. 9am, 15:00, a las 18:00', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'show_overdue_reminders',
        description: 'Muestra recordatorios acumulados durante modo silencio',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
    ];
  }

  getCommands(): Record<string, string> {
    return {
      '/checkin': 'daily_checkin',
      '/focus': 'list_today_focus',
      '/pomodoro': 'start_focus_session',
      // Fase 2 (sin args)
      '/privacidad': 'show_privacy',
      '/abandonar': 'anti_abandono',
      '/reinicio': 'restart_no_guilt',
      '/agenda': 'agenda_start',
      // Recursos de crisis (READ_ONLY, derivación)
      '/recursos': 'show_crisis_resources',
      '/crisis_recursos': 'show_crisis_resources',
      // Fase 3 (sin args): comandos directos
      '/recordatorios': 'list_reminders',
      '/ver_recordatorios': 'show_overdue_reminders',
      // NOTA: /silencio, /recordar y /cancelar_recordatorio NO se mapean aquí
      // porque sus rules capturan argumentos del usuario.
    };
  }

  getRules(): RulePattern[] {
    return [
      // ── Reglas existentes ────────────────────────────────────────────────
      {
        patterns: [/^(check.?in|buenos dias|buen dia|ya estoy|llegue|presente)$/],
        action: 'daily_checkin',
      },
      {
        patterns: [/^(mi foco|en que me enfoco|que hago|foco del dia|prioridad)$/],
        action: 'list_today_focus',
      },
      {
        patterns: [/^(micro.?tarea|tarea pequena|agregar micro)[:\s]*(.*)$/],
        action: 'add_micro_task',
        extractParams: (match, _normalized, rawText) => {
          const m = rawText.match(/(?:micro.?tarea|tarea pequeña|agregar micro)[:\s]+(.*)$/i);
          return { text: (m?.[1] ?? match[2] ?? '').trim() };
        },
      },
      {
        patterns: [/^(pomodoro|enfocame|enfocar(?:me)?|sesion de foco)[:\s]*(.*)$/],
        action: 'start_focus_session',
        extractParams: (match, _normalized, rawText) => {
          const m = rawText.match(/(?:pomodoro|enfócame|enfocarme|sesión de foco)[:\s]+(.*)$/i);
          return { task: (m?.[1] ?? match[2] ?? '').trim() || 'tarea actual' };
        },
      },
      {
        patterns: [/^(listo|hecho|termine|complete|✅)\s*(\d+)?$/],
        action: 'complete_micro_task',
        extractParams: (match) => {
          return { taskId: match[2] ?? '1' };
        },
      },

      // ── Fase 2 — /silencio (con duración opcional) ───────────────────────
      {
        patterns: [/^\/silencio(?:\s+(.+))?$/],
        action: 'set_silence',
        extractParams: (match) => ({ duration: (match[1] ?? '').trim() }),
      },
      {
        // NL: "dejame en paz", "no me escribas", "silencio hoy", etc.
        patterns: [
          /^(dejame en paz|no me escribas|silencio por hoy|silencio hoy|necesito silencio)$/,
        ],
        action: 'set_silence',
        extractParams: () => ({ duration: '' }),
      },

      // ── Fase 2 — /privacidad NL ──────────────────────────────────────────
      {
        patterns: [
          /^(que sabes de mi|que guardas|ver mis datos|que datos tienes|que datos guardas)$/,
        ],
        action: 'show_privacy',
      },

      // ── Fase 2 — Borrado ─────────────────────────────────────────────────
      {
        patterns: [
          /^(borrar todo|borralo todo|elimina mis datos|borra lo que sabes(?: de mi)?|elimina todo lo que tienes)$/,
        ],
        action: 'delete_all_state',
      },

      // ── Fase 2 — Anti-abandono ───────────────────────────────────────────
      // Reglas específicas; no incluyen frases ambiguas que el pre-filter
      // global de crisis ya intercepta ("no quiero seguir", "ya no quiero", etc.)
      {
        patterns: [
          /^(lo dejo|me rindo|me harte|esto no sirve|manana mejor|ya falle)$/,
          /^me rindo(?:\s+con\s+.+)?$/,
          /\bno puedo mas con esto\b/,
        ],
        action: 'anti_abandono',
      },

      // ── Fase 2 — Reinicio ────────────────────────────────────────────────
      {
        patterns: [
          /^(falle|rompi la racha|no hice nada|abandone(?:\s+la racha)?)$/,
        ],
        action: 'restart_no_guilt',
      },

      // ── Fase 2 — Agenda en lenguaje natural ─────────────────────────────
      {
        patterns: [
          /^(organiza mi dia|ordena mi dia|ayudame con el dia)$/,
        ],
        action: 'agenda_start',
      },
      {
        // 3+ items separados por comas o " y " → clasificar
        patterns: [
          /^[^,]+,\s*[^,]+,[^,]+/,
        ],
        action: 'agenda_classify',
        extractParams: (_match, _normalized, rawText) => ({ dump: rawText }),
      },

      // ── Fase 3 — Recordatorios programados ───────────────────────────────
      // /recordar con argumentos: captura todo lo que sigue como "spec"
      {
        patterns: [/^\/recordar(?:\s+(.+))?$/i],
        action: 'add_reminder',
        extractParams: (_match, _normalized, rawText) => {
          const m = rawText.match(/^\/recordar\s*(.*)$/i);
          return { spec: (m?.[1] ?? '').trim() };
        },
      },
      // /cancelar_recordatorio N
      {
        patterns: [/^\/cancelar_recordatorio\s+(\d+)$/i],
        action: 'cancel_reminder',
        extractParams: (match) => ({ index: match[1] }),
      },
      // "verlos" / "ver recordatorios" / "muestralos" → show overdue summary
      {
        patterns: [
          /^(verlos|ver recordatorios|mostrar recordatorios|muestralos|mostrarmelos)$/,
        ],
        action: 'show_overdue_reminders',
      },
      // Solo hora (respuesta a "¿a qué hora mañana?"): captura time spec
      {
        patterns: [
          /^(?:manana\s+)?(?:a\s+las\s+)?\d{1,2}(?::\d{2})?\s*(am|pm)?$/,
        ],
        action: 'complete_reminder_with_time',
        extractParams: (_match, _normalized, rawText) => ({ timeSpec: rawText.trim() }),
      },

      // ── Fase 2 — Recursos de crisis (READ_ONLY, derivación) ──────────────
      // NOTA: NO incluye frases de riesgo ("no quiero seguir", "quiero morir",
      // etc.) — esas las captura el pre-filter global ANTES de llegar aquí.
      // Solo se activa con peticiones explícitas de información de recursos.
      {
        patterns: [
          /^(recursos|recursos de crisis|recursos de apoyo|recursos de emergencia)$/,
          /^(linea de crisis|lineas de crisis|línea de crisis|líneas de crisis)$/,
          /^(emergencias|telefono de emergencias|teléfonos de emergencia|numero de emergencia|número de emergencia)$/,
          /^(donde pido ayuda|donde llamar|a quien llamo)$/,
        ],
        action: 'show_crisis_resources',
      },
    ];
  }

  async execute(action: string, params: Record<string, unknown>, userId: string): Promise<ActionResult> {
    switch (action) {
      case 'daily_checkin':
        return await this.dailyCheckin(userId);
      case 'list_today_focus':
        return await this.listTodayFocus(userId);
      case 'add_micro_task':
        return await this.addMicroTask(userId, params);
      case 'start_focus_session':
        return await this.startFocusSession(userId, params);
      case 'complete_micro_task':
        return await this.completeMicroTask(userId, params);
      case 'reset_day':
        return await this.resetDay(userId);
      // ── Fase 2 ──
      case 'set_silence':
        return await this.setSilence(userId, params);
      case 'show_privacy':
        return await this.showPrivacy(userId);
      case 'delete_all_state':
        return await this.deleteAllState(userId);
      case 'anti_abandono':
        return this.antiAbandono();
      case 'restart_no_guilt':
        return this.restartNoGuilt();
      case 'agenda_start':
        return this.agendaStart();
      case 'agenda_classify':
        return await this.agendaClassify(userId, params);
      case 'show_crisis_resources':
        return this.showCrisisResources();
      // ── Fase 3 ──
      case 'add_reminder':
        return await this.addReminder(userId, params);
      case 'list_reminders':
        return await this.listReminders(userId);
      case 'cancel_reminder':
        return await this.cancelReminder(userId, params);
      case 'complete_reminder_with_time':
        return await this.completeReminderWithTime(userId, params);
      case 'show_overdue_reminders':
        return await this.showOverdueReminders(userId);
      default:
        return { success: false, message: `Acción "${action}" no implementada en ADHD Coach.` };
    }
  }

  async getStatusSummary(userId: string): Promise<string> {
    const tasks = await this.store.getMicroTasks(userId);
    const pending = tasks.filter((t) => !t.completed).length;
    const done = tasks.filter((t) => t.completed).length;
    const sessions = await this.store.getFocusSessions(userId);
    const session = sessions.length > 0 ? sessions[sessions.length - 1] : null;
    const silence = await this.store.getSilenceUntil(userId);
    const parts: string[] = [];
    parts.push(`Micro-tareas: ${pending} pendientes, ${done} completadas.`);
    parts.push(session ? `🎯 En foco: "${session.task}"` : '💤 Sin sesión activa');
    if (silence) {
      const until = new Date(silence);
      if (until.getTime() > Date.now()) {
        parts.push(`🔕 Silencio hasta ${formatHasta(silence)}`);
      }
    }
    return parts.join(' ');
  }

  // ─── Existing actions (sin cambios funcionales) ────────────────────────

  private async dailyCheckin(userId: string): Promise<ActionResult> {
    const today = new Date().toISOString().split('T')[0];
    const checkins = await this.store.getCheckins(userId);

    if (checkins.some(c => c.date === today)) {
      return { success: true, message: '✅ Ya hiciste tu check-in hoy. ¡Sigue así! 💪' };
    }

    await this.store.addCheckin(userId, today);
    const streak = checkins.length + 1;
    const tasks = (await this.store.getMicroTasks(userId)).filter((t) => !t.completed);

    const motivations = [
      '🌟 ¡Excelente! Cada día que te presentas cuenta.',
      '💪 ¡Bien hecho! El progreso es progreso, sin importar el tamaño.',
      '🧠 Tu cerebro TDAH es un superpoder. Vamos a enfocarlo hoy.',
      '🚀 ¡Check-in registrado! Pequeños pasos, grandes resultados.',
    ];
    const motivation = motivations[streak % motivations.length];

    const lines = [
      `☀️ *Check-in del día* — Racha: ${streak} día(s)`,
      '',
      motivation,
    ];

    if (tasks.length > 0) {
      lines.push('', `📋 Tienes ${tasks.length} micro-tarea(s) pendiente(s). Escribe /focus para verlas.`);
    } else {
      lines.push('', '📝 No tienes micro-tareas. Usa "microtarea: ..." para agregar una pequeña.');
    }

    return { success: true, message: lines.join('\n') };
  }

  private async listTodayFocus(userId: string): Promise<ActionResult> {
    const tasks = await this.store.getMicroTasks(userId);
    const sessions = await this.store.getFocusSessions(userId);
    const session = sessions.length > 0 ? sessions[sessions.length - 1] : null;

    if (tasks.length === 0 && !session) {
      return {
        success: true,
        message: '🧘 No tienes micro-tareas ni sesiones de foco activas.\n\nAgrega una con: "microtarea: revisar correo"',
      };
    }

    const lines = ['🎯 *Tu foco de hoy:*', ''];

    if (session) {
      lines.push(`⏱️ *Sesión activa:* "${session.task}"`, '');
    }

    if (tasks.length > 0) {
      lines.push('*Micro-tareas:*');
      tasks.forEach((t, i) => {
        const check = t.completed ? '✅' : '⬜';
        lines.push(`  ${check} ${i + 1}. ${t.text}`);
      });
      const pending = tasks.filter((t) => !t.completed).length;
      lines.push('', `_${pending} pendiente(s). Escribe "listo 1" para completar._`);
    }

    return { success: true, message: lines.join('\n') };
  }

  private async addMicroTask(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const text = String(params.text ?? '').trim();
    if (!text) {
      return { success: false, message: '⚠️ Necesito el texto de la micro-tarea. Ejemplo: "microtarea: revisar correo"' };
    }

    await this.store.addMicroTask(userId, text);
    return { success: true, message: `✅ Micro-tarea agregada: "${text}"\n\n💡 _Recuerda: máximo 15 minutos por micro-tarea._` };
  }

  private async startFocusSession(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const task = String(params.task ?? 'tarea actual').trim();
    const minutes = Number(params.minutes) || 25;

    await this.store.addFocusSession(userId, task);

    return {
      success: true,
      message: `🍅 *Sesión Pomodoro iniciada*\n\n⏱️ Duración: ${minutes} minutos\n🎯 Foco: "${task}"\n\n_Concéntrate. Silencia notificaciones. Tú puedes._ 💪`,
    };
  }

  private async completeMicroTask(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const taskId = String(params.taskId ?? '').trim();
    const tasks = await this.store.getMicroTasks(userId);

    const index = parseInt(taskId, 10) - 1;
    const task = (index >= 0 && index < tasks.length) ? tasks[index] : null;

    if (!task) {
      return { success: false, message: `⚠️ No encontré la micro-tarea #${taskId}. Escribe /focus para ver la lista.` };
    }

    if (task.completed) {
      return { success: true, message: `ℹ️ La micro-tarea "${task.text}" ya estaba completada.` };
    }

    await this.store.completeMicroTask(userId, task.id);
    const remaining = tasks.filter((t) => !t.completed).length - 1;

    if (remaining <= 0) {
      return { success: true, message: `🎉 ¡Completaste "${task.text}"! *¡Todas las micro-tareas están hechas!* 🏆` };
    }

    return { success: true, message: `✅ ¡Completada! "${task.text}"\n\n📋 Quedan ${remaining} micro-tarea(s). ¡Sigue así!` };
  }

  private async resetDay(userId: string): Promise<ActionResult> {
    const tasks = await this.store.getMicroTasks(userId);
    const count = tasks.length;
    await this.store.resetDay(userId);
    return { success: true, message: `🗑️ ${count} micro-tarea(s) eliminada(s). Sesión de foco reiniciada. Día limpio. 🧘` };
  }

  // ─── Fase 2: nuevas acciones ────────────────────────────────────────────

  private async setSilence(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const duration = String(params.duration ?? '').trim();
    const until = parseSilenceDuration(duration);
    const iso = until.toISOString();
    await this.store.setSilenceUntil(userId, iso);
    return {
      success: true,
      message: `🔕 Modo silencio hasta ${formatHasta(iso)}. Te respondo si me escribes, pero no te molestaré.`,
    };
  }

  private async showPrivacy(userId: string): Promise<ActionResult> {
    const tasks = await this.store.getMicroTasks(userId);
    const sessions = await this.store.getFocusSessions(userId);
    const checkins = await this.store.getCheckins(userId);
    const silence = await this.store.getSilenceUntil(userId);

    const lines: string[] = ['Esto es lo que guardo ahora:', ''];
    // Contexto: nota intencional, NO lenguaje clínico ("diagnóstico" prohibido).
    lines.push('- Contexto declarado por ti: TDAH.');
    if (tasks.length > 0 || checkins.length > 0) {
      const pending = tasks.filter((t) => !t.completed).length;
      const done = tasks.filter((t) => t.completed).length;
      lines.push(`- Estado de tareas/microtareas: ${pending} pendientes, ${done} completadas, ${checkins.length} check-in(s).`);
    } else {
      lines.push('- Estado de tareas/microtareas: sin registros todavía.');
    }
    const activeSession = sessions[sessions.length - 1];
    if (activeSession) {
      lines.push(`- Sesión de enfoque activa: "${activeSession.task}".`);
    } else {
      lines.push('- Sesión de enfoque activa: ninguna.');
    }
    if (silence) {
      const until = new Date(silence);
      if (until.getTime() > Date.now()) {
        lines.push(`- Modo silencio: hasta ${formatHasta(silence)}.`);
      } else {
        lines.push('- Modo silencio: no activo.');
      }
    } else {
      lines.push('- Modo silencio: no activo.');
    }
    const pendingReminders = await this.store.listReminders(userId);
    if (pendingReminders.length > 0) {
      lines.push(`- Recordatorios programados: ${pendingReminders.length} pendiente(s).`);
    } else {
      lines.push('- Recordatorios programados: ninguno.');
    }
    lines.push('- Preferencias básicas: ninguna registrada todavía.');
    lines.push('');
    lines.push('Opciones: A) borrar todo, B) borrar una parte, C) cambiar consentimientos.');

    return { success: true, message: lines.join('\n') };
  }

  private async deleteAllState(userId: string): Promise<ActionResult> {
    await this.store.resetAllUserState(userId);
    return {
      success: true,
      message:
        '🗑️ Hecho. Borré el estado que este dominio guardaba sobre ti. ' +
        'Si la plataforma conserva logs técnicos, no los usaré para personalizar respuestas.',
    };
  }

  private antiAbandono(): ActionResult {
    return {
      success: true,
      message:
        'Antes de abandonar, hagamos una pausa. ¿Esto es cansancio, miedo, frustración o que realmente ya no tiene sentido? ' +
        'Luego eliges: A) 2 minutos, B) reprogramar, C) cerrar conscientemente.',
    };
  }

  private restartNoGuilt(): ActionResult {
    return {
      success: true,
      message:
        'Romper una racha no borra lo aprendido. Hoy reinicio mínimo: una prioridad, una acción de 2 minutos y cierre. ' +
        '¿Cuál es la prioridad?',
    };
  }

  private agendaStart(): ActionResult {
    return {
      success: true,
      message:
        'Vamos a ordenar el día. Vuélcame lo que tienes en bruto; yo lo separo en laboral, personal, mantenimiento, espiritual y otros.',
    };
  }

  private async agendaClassify(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const dump = String(params.dump ?? '').trim();
    if (!dump) {
      return { success: false, message: '⚠️ Necesito el volcado de tareas (separadas por comas o "y").' };
    }
    const items = splitTaskDump(dump);
    if (items.length === 0) {
      return { success: false, message: '⚠️ No pude leer ninguna tarea. Sepáralas por comas o "y".' };
    }

    const buckets: Record<Category, string[]> = {
      laboral: [], personal: [], mantenimiento: [], espiritual: [], otros: [],
    };
    for (const it of items) buckets[classifyItem(it)].push(it);

    const lines: string[] = ['Lo separé así:'];
    if (buckets.laboral.length)       lines.push(`- Laboral: ${buckets.laboral.join(', ')}.`);
    if (buckets.personal.length)      lines.push(`- Personal: ${buckets.personal.join(', ')}.`);
    if (buckets.mantenimiento.length) lines.push(`- Mantenimiento: ${buckets.mantenimiento.join(', ')}.`);
    if (buckets.espiritual.length)    lines.push(`- Espiritual: ${buckets.espiritual.join(', ')}.`);
    if (buckets.otros.length)         lines.push(`- Otros: ${buckets.otros.join(', ')}.`);
    lines.push('');
    lines.push('¿Eliges 3 importantes y 1 de mantenimiento para hoy?');

    return { success: true, message: lines.join('\n') };
  }

  private showCrisisResources(): ActionResult {
    // Mínimo: MX, US, ES. Ampliar con un mantenedor humano antes de exponer
    // el bot fuera de tu uso personal. Los números deben revisarse al menos
    // anualmente; cambian con frecuencia.
    const message = [
      'Recursos de apoyo:',
      '- México: Línea de la Vida 800 911 2000. Emergencias: 911.',
      '- Estados Unidos: 988 Suicide & Crisis Lifeline. Emergencias: 911.',
      '- España: Línea 024 de atención a la conducta suicida. Emergencias: 112.',
      '',
      'Si estás en peligro inmediato, contacta emergencias ahora.',
    ].join('\n');
    return { success: true, message };
  }

  // ─── Fase 3: recordatorios programados ───────────────────────────────────

  private async addReminder(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const spec = String(params.spec ?? '').trim();
    if (!spec) {
      return {
        success: false,
        message:
          '⚠️ ¿Qué quieres recordar y a qué hora? Ej: "/recordar en 2h tomar agua", ' +
          '"/recordar mañana 9am llamar al doctor".',
      };
    }
    const parsed = parseReminderSpec(spec);
    if (!parsed.ok) {
      if (parsed.reason === 'tomorrow_needs_hour') {
        // Guardar el draft y pedir hora explícita
        await this.store.setPendingReminderDraft(userId, {
          text: parsed.text,
          dayHint: 'tomorrow',
        });
        return {
          success: true,
          message: `🕒 ¿A qué hora mañana quieres que te recuerde "${parsed.text}"? (Ej: 9am, 15:00)`,
        };
      }
      if (parsed.reason === 'missing_text') {
        return {
          success: false,
          message: '⚠️ Necesito también qué quieres recordar. Ej: "en 2h tomar agua".',
        };
      }
      return {
        success: false,
        message:
          '⚠️ No entendí el tiempo. Usa: "en 2h <texto>", "hoy 18:00 <texto>", ' +
          '"mañana 9am <texto>", o "15:00 <texto>".',
      };
    }
    const { id } = await this.store.addReminder(userId, parsed.text, parsed.dueAt.toISOString());
    return {
      success: true,
      message:
        `⏰ Recordatorio programado: "${parsed.text}" para ${formatLocalDateTime(parsed.dueAt.toISOString())}. ` +
        `(id ${id}) Si quieres cancelarlo, escribe /cancelar_recordatorio <número>.`,
    };
  }

  private async listReminders(userId: string): Promise<ActionResult> {
    // Robusto contra: pendientes con date null/invalida, text vacio,
    // caracteres que rompan Markdown v1 (Telegram rechaza el mensaje y el
    // adapter se lo come), y cualquier excepcion del store.
    try {
      const list = await this.store.listReminders(userId);
      if (!list || list.length === 0) {
        return {
          success: true,
          message: '🗒️ No tienes recordatorios pendientes. Crea uno con /recordar.',
        };
      }
      const lines: string[] = ['Tus recordatorios pendientes:'];
      list.forEach((r, i) => {
        const rawText = (r?.text && String(r.text).trim()) ? String(r.text).trim() : '(sin texto)';
        const safeText = escapeMdV1(rawText);
        const when = formatLocalDateTime(r?.dueAt);
        lines.push(`${i + 1}. ${safeText} — ${when}`);
      });
      return { success: true, message: lines.join('\n') };
    } catch (err) {
      // No relanzamos para no caer al "Ocurrio un error inesperado" generico;
      // el orquestador NO ve la excepcion porque damos respuesta de fallback.
      return {
        success: false,
        message: 'No pude listar tus recordatorios ahora. Intenta de nuevo en un momento.',
      };
    }
  }

  private async cancelReminder(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const idxRaw = String(params.index ?? '').trim();
    const idx = parseInt(idxRaw, 10);
    if (!Number.isFinite(idx) || idx < 1) {
      return {
        success: false,
        message:
          '⚠️ Necesito un número. Ej: /cancelar_recordatorio 1. Mira la lista con /recordatorios.',
      };
    }
    const cancelledText = await this.store.cancelReminderByIndex(userId, idx);
    if (!cancelledText) {
      return {
        success: false,
        message: `⚠️ No encontré el recordatorio #${idx}. Revisa la lista con /recordatorios.`,
      };
    }
    return { success: true, message: `🗑️ Cancelado: "${cancelledText}".` };
  }

  private async completeReminderWithTime(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const draft = await this.store.getPendingReminderDraft(userId);
    if (!draft) {
      // Si no hay draft, esta acción no aplica — degradar a sugerencia.
      return {
        success: false,
        message:
          'ℹ️ No tengo un recordatorio pendiente de hora. Si quieres crear uno: ' +
          '"/recordar en 2h tomar agua" o "/recordar 18:00 llamar".',
      };
    }
    const timeSpec = String(params.timeSpec ?? '').trim();
    const hint: 'today' | 'tomorrow' =
      draft.dayHint === 'today' ? 'today' : 'tomorrow';
    const due = parseTimeOnly(timeSpec, hint);
    if (!due) {
      return {
        success: false,
        message: '⚠️ No entendí la hora. Prueba con 9am, 15:00, o "a las 18:00".',
      };
    }
    await this.store.clearPendingReminderDraft(userId);
    const { id } = await this.store.addReminder(userId, draft.text, due.toISOString());
    return {
      success: true,
      message:
        `⏰ Listo. Te recuerdo "${draft.text}" el ${formatLocalDateTime(due.toISOString())}. (id ${id})`,
    };
  }

  private async showOverdueReminders(userId: string): Promise<ActionResult> {
    const summary = await this.store.getPendingOverdueSummary(userId);
    if (!summary || summary.reminderIds.length === 0) {
      return {
        success: true,
        message:
          '🗒️ No hay recordatorios acumulados pendientes. ' +
          'Ver todos los pendientes con /recordatorios.',
      };
    }
    // Reconstruir los textos a partir de los IDs guardados
    const allPending = await this.store.listReminders(userId);
    const lines: string[] = ['🔔 *Recordatorios acumulados durante silencio:*', ''];
    // Como el resumen guarda IDs ya marcados como done, intentamos imprimirlos
    // con sus textos a partir del log persistente. Para simplicidad,
    // listamos los que aún están pendientes y mencionamos cuántos vencieron.
    const idsSet = new Set(summary.reminderIds);
    // Marcamos como hechos para que no vuelvan a sonar. Aquí ya están done.
    lines.push(`Tuviste ${summary.reminderIds.length} recordatorio(s) durante silencio. Ya fueron registrados como entregados.`);
    if (allPending.length > 0) {
      lines.push('', 'Pendientes a futuro:');
      allPending.forEach((r, i) => {
        if (!idsSet.has(r.id)) {
          lines.push(`  ${i + 1}. ${r.text} — ${formatHasta(r.dueAt)}`);
        }
      });
    }
    await this.store.clearPendingOverdueSummary(userId);
    return { success: true, message: lines.join('\n') };
  }

  /**
   * Tick del despachador proactivo. Se llama cada N segundos desde el host
   * (src/index.ts). Recibe un `send(userId, text)` para emitir mensajes
   * proactivos sin acoplarse al adapter.
   *
   * Reglas:
   *  - Lee los recordatorios vencidos de TODOS los usuarios del dominio.
   *  - Si un usuario está en /silencio, pospone los recordatorios al fin de
   *    silencio y los acumula en overdue_summary. No envía nada.
   *  - Si NO hay silencio y hay 1 vencido → lo envía y lo marca done.
   *  - Si NO hay silencio y hay 2+ vencidos (incluye silencio recién terminado)
   *    → envía un resumen agregado pidiendo "verlos" y marca todos done.
   *  - El pre-filter de crisis NO aplica a envíos proactivos.
   */
  async tick(send: (userId: string, text: string) => Promise<void>): Promise<void> {
    const nowIso = new Date().toISOString();
    const due = await this.store.getDueRemindersAllUsers(nowIso);
    if (due.length === 0) return;

    // Agrupar por usuario
    const byUser = new Map<string, typeof due>();
    for (const r of due) {
      const list = byUser.get(r.userId) ?? [];
      list.push(r);
      byUser.set(r.userId, list);
    }

    for (const [userId, list] of byUser.entries()) {
      const silenceIso = await this.store.getSilenceUntil(userId);
      const silenced = !!silenceIso && new Date(silenceIso).getTime() > Date.now();

      if (silenced) {
        // Posponer cada recordatorio al fin de silencio (+ pequeño offset
        // para que se reagrupen al despertarlo) y acumularlos en summary.
        const endOfSilence = new Date(silenceIso!);
        // Sumar 1 segundo para garantizar que due_at sea > silence_until,
        // y así dispararse al primer tick tras el silencio.
        const dispatchAt = new Date(endOfSilence.getTime() + 1000);
        const acumulados: string[] = [];
        for (const r of list) {
          await this.store.postponeReminder(r.id, dispatchAt.toISOString());
          acumulados.push(r.id);
        }
        // Mantener acumulación a lo largo de varios ticks durante silencio
        const prev = await this.store.getPendingOverdueSummary(userId);
        const merged = Array.from(new Set([...(prev?.reminderIds ?? []), ...acumulados]));
        await this.store.setPendingOverdueSummary(userId, merged);
        continue;
      }

      // Sin silencio: revisa si hay summary acumulado de un silencio previo
      const accumulated = await this.store.getPendingOverdueSummary(userId);
      const totalCount = list.length + (accumulated?.reminderIds.length ?? 0);

      if (totalCount === 1 && list.length === 1) {
        // 1 solo recordatorio vencido y sin acumulación previa → enviar normal
        const r = list[0];
        await send(userId, `🔔 Recordatorio: ${r.text}`);
        await this.store.markReminderDone(r.id);
        continue;
      }

      // 2+ acumulados → enviar resumen (sin listar uno por uno, evita avalancha)
      for (const r of list) {
        await this.store.markReminderDone(r.id);
      }
      const allIds = [...(accumulated?.reminderIds ?? []), ...list.map((r) => r.id)];
      await this.store.setPendingOverdueSummary(userId, allIds);
      await send(
        userId,
        `🔔 Tienes ${allIds.length} recordatorios pendientes acumulados. ` +
          `¿Quieres verlos ahora? Responde "verlos" o /ver_recordatorios.`,
      );
    }
  }
}
