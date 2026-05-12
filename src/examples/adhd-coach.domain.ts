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
  | { ok: false; reason: 'date_needs_hour'; text: string; dayHint: string }
  | { ok: false; reason: 'missing_text' }
  | { ok: false; reason: 'missing_time' };

// ── Diccionarios ES para fechas naturales ───────────────────────────────────
const DOW_NAMES: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3,
  jueves: 4, viernes: 5, sabado: 6,
};
const MONTH_NAMES: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, sept: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

function dowFromName(name: string): number | null {
  if (!name) return null;
  return DOW_NAMES[name.toLowerCase()] ?? null;
}
function monthFromName(name: string): number | null {
  if (!name) return null;
  return MONTH_NAMES[name.toLowerCase()] ?? null;
}
function dowFromWallDate(year: number, month0: number, day: number): number {
  // getUTCDay sobre una Date UTC siempre devuelve el dow correcto para esa
  // fecha calendárica, independiente de TZ.
  return new Date(Date.UTC(year, month0, day)).getUTCDay();
}
function isValidWallDate(year: number, month0: number, day: number): boolean {
  if (year < 1970 || year > 3000) return false;
  if (month0 < 0 || month0 > 11) return false;
  if (day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month0, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month0 && d.getUTCDate() === day;
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** Codifica una fecha calendárica como dayHint serializable. */
function encodeDateHint(year: number, month0: number, day: number): string {
  return `date:${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}
/** Codifica un día de la semana como dayHint serializable. */
function encodeDowHint(dow: number): string {
  return `dow:${dow}`;
}

type DecodedHint =
  | { kind: 'today' | 'tomorrow' | 'unspecified' }
  | { kind: 'date'; year: number; month0: number; day: number }
  | { kind: 'dow'; dow: number };

/** Decodifica el string almacenado como draft.dayHint. null si no parsea. */
function decodeDayHint(hint: string): DecodedHint | null {
  if (!hint) return null;
  if (hint === 'today' || hint === 'tomorrow' || hint === 'unspecified') {
    return { kind: hint };
  }
  let m = hint.match(/^date:(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    if (!isValidWallDate(y, mo, d)) return null;
    return { kind: 'date', year: y, month0: mo, day: d };
  }
  m = hint.match(/^dow:(\d)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n < 0 || n > 6) return null;
    return { kind: 'dow', dow: n };
  }
  return null;
}

/** Pickea año (actual o siguiente) para que (month0, day) sea futuro respecto a `today`. */
function pickFutureYear(today: WallCalendar, month0: number, day: number): number {
  const todayMs = Date.UTC(today.year, today.month0, today.day);
  const candMs = Date.UTC(today.year, month0, day);
  return candMs >= todayMs ? today.year : today.year + 1;
}

/** Próxima fecha calendárica con ese dow desde `today` (today si dow es hoy). */
function nextDowFromToday(today: WallCalendar, targetDow: number, strictlyAfter: boolean): WallCalendar {
  const todayDow = dowFromWallDate(today.year, today.month0, today.day);
  let delta = (targetDow - todayDow + 7) % 7;
  if (strictlyAfter && delta === 0) delta = 7;
  return addDays(today, delta);
}

/** Suma N días (puede ser 0..366) a una fecha calendárica con wrap correcto. */
function addDays(d: WallCalendar, n: number): WallCalendar {
  const t = new Date(Date.UTC(d.year, d.month0, d.day));
  t.setUTCDate(t.getUTCDate() + n);
  return { year: t.getUTCFullYear(), month0: t.getUTCMonth(), day: t.getUTCDate(), hour: 0, minute: 0 };
}

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

// ── Date prefix parser ──────────────────────────────────────────────────────
// Detecta el "prefijo de fecha" del spec y devuelve la fecha (o dow) + lo que
// queda del string ("rest") para parsear como tiempo + texto.

type DatePrefix =
  | { kind: 'rel'; dayOffset: number }            // hoy=0, mañana=1, pasado mañana=2
  | { kind: 'date'; year: number; month0: number; day: number }
  | { kind: 'dow'; dow: number };

interface DatePrefixMatch { prefix: DatePrefix; rest: string }

function parseDatePrefix(norm: string, today: WallCalendar): DatePrefixMatch | null {
  // Orden: más específico primero.

  // "pasado manana"
  let m = norm.match(/^pasado\s+manana(?:\s+(.*))?$/);
  if (m) return { prefix: { kind: 'rel', dayOffset: 2 }, rest: (m[1] ?? '').trim() };

  // "hoy" (consumido aqui solo si va seguido de tiempo o vacio, no como sustantivo)
  m = norm.match(/^hoy(?:\s+(.*))?$/);
  if (m) return { prefix: { kind: 'rel', dayOffset: 0 }, rest: (m[1] ?? '').trim() };

  // "manana" → +1d. (debe ir despues de "pasado manana".)
  m = norm.match(/^manana(?:\s+(.*))?$/);
  if (m) return { prefix: { kind: 'rel', dayOffset: 1 }, rest: (m[1] ?? '').trim() };

  // ISO "yyyy-mm-dd"
  m = norm.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(.*))?$/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    if (!isValidWallDate(y, mo, d)) return null;
    return { prefix: { kind: 'date', year: y, month0: mo, day: d }, rest: (m[4] ?? '').trim() };
  }

  // "[el] <dow> <dd> de <mes>"  → fecha explícita; ignora dow si discrepa.
  m = norm.match(/^(?:el\s+)?([a-z]+)\s+(\d{1,2})\s+de\s+([a-z]+)(?:\s+(.*))?$/);
  if (m) {
    const dow = dowFromName(m[1]);
    const day = parseInt(m[2], 10);
    const month0 = monthFromName(m[3]);
    if (dow !== null && month0 !== null) {
      const year = pickFutureYear(today, month0, day);
      if (!isValidWallDate(year, month0, day)) return null;
      return { prefix: { kind: 'date', year, month0, day }, rest: (m[4] ?? '').trim() };
    }
  }

  // "[el] <dd> de <mes>"  (sin dow)
  m = norm.match(/^(?:el\s+)?(\d{1,2})\s+de\s+([a-z]+)(?:\s+(.*))?$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month0 = monthFromName(m[2]);
    if (month0 !== null) {
      const year = pickFutureYear(today, month0, day);
      if (!isValidWallDate(year, month0, day)) return null;
      return { prefix: { kind: 'date', year, month0, day }, rest: (m[3] ?? '').trim() };
    }
  }

  // "dd/mm" o "dd-mm" (sin año, current o next).
  m = norm.match(/^(\d{1,2})[\/\-](\d{1,2})(?:\s+(.*))?$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month0 = parseInt(m[2], 10) - 1;
    if (month0 < 0 || month0 > 11) return null;
    const year = pickFutureYear(today, month0, day);
    if (!isValidWallDate(year, month0, day)) return null;
    return { prefix: { kind: 'date', year, month0, day }, rest: (m[3] ?? '').trim() };
  }

  // "[el] <dow>"  (palabra única que sea día de la semana válido)
  m = norm.match(/^(?:el\s+)?([a-z]+)(?:\s+(.*))?$/);
  if (m) {
    const dow = dowFromName(m[1]);
    if (dow !== null) {
      return { prefix: { kind: 'dow', dow }, rest: (m[2] ?? '').trim() };
    }
  }

  return null;
}

// ── Time-from-start parser ──────────────────────────────────────────────────
// Lee el inicio de `rest` y devuelve {hour, minute, restAfterTime} o null.

function parseTimeFromStart(rest: string): { hour: number; minute: number; restAfter: string } | null {
  if (!rest) return null;
  // "[a las] HH:MM[am|pm] <text>"
  let m = rest.match(/^(?:a\s+las\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\s+(.*)$/i);
  if (m) {
    const h = hourTo24(parseInt(m[1], 10), m[3]);
    if (h === null) return null;
    const mins = parseInt(m[2], 10);
    if (mins < 0 || mins > 59) return null;
    return { hour: h, minute: mins, restAfter: m[4].trim() };
  }
  // "[a las] HHam|pm <text>"  (sin minutos, requiere am/pm)
  m = rest.match(/^(?:a\s+las\s+)?(\d{1,2})\s*(am|pm)\s+(.*)$/i);
  if (m) {
    const h = hourTo24(parseInt(m[1], 10), m[2]);
    if (h === null) return null;
    return { hour: h, minute: 0, restAfter: m[3].trim() };
  }
  // "a las HH <text>"  (requiere prefijo "a las" para desambiguar)
  m = rest.match(/^a\s+las\s+(\d{1,2})\s+(.*)$/i);
  if (m) {
    const h = hourTo24(parseInt(m[1], 10), undefined);
    if (h === null) return null;
    return { hour: h, minute: 0, restAfter: m[2].trim() };
  }
  return null;
}

// ── Resolución de fecha + hora → Date UTC ───────────────────────────────────

function resolveDueFromPrefix(
  prefix: DatePrefix,
  hour: number,
  minute: number,
  now: Date,
  today: WallCalendar,
  tz: string,
): Date {
  if (prefix.kind === 'rel') {
    const target = addDays(today, prefix.dayOffset);
    let due = makeDateInTz(target.year, target.month0, target.day, hour, minute, tz);
    // Para dayOffset 0 (hoy): si ya pasó, NO flip automático — el usuario
    // dijo explicitamente "hoy". Aceptamos que pueda ser un instante en el
    // pasado y dejamos que el dispatcher lo trate como vencido. (En la
    // práctica el patrón "HH:MM solo" cubre el caso "si pasó, mañana".)
    return due;
  }
  if (prefix.kind === 'date') {
    return makeDateInTz(prefix.year, prefix.month0, prefix.day, hour, minute, tz);
  }
  // dow: la primera ocurrencia (today inclusive) cuyo (date + hour) sea futuro.
  let cand = nextDowFromToday(today, prefix.dow, false);
  let due = makeDateInTz(cand.year, cand.month0, cand.day, hour, minute, tz);
  if (due.getTime() <= now.getTime()) {
    cand = addDays(cand, 7);
    due = makeDateInTz(cand.year, cand.month0, cand.day, hour, minute, tz);
  }
  return due;
}

/** Codifica un DatePrefix sin hora como dayHint para el draft. */
function encodePrefixAsHint(prefix: DatePrefix, today: WallCalendar): string {
  if (prefix.kind === 'rel') {
    if (prefix.dayOffset === 0) return 'today';
    if (prefix.dayOffset === 1) return 'tomorrow';
    // pasado mañana o más: codificar como fecha concreta
    const t = addDays(today, prefix.dayOffset);
    return encodeDateHint(t.year, t.month0, t.day);
  }
  if (prefix.kind === 'date') {
    return encodeDateHint(prefix.year, prefix.month0, prefix.day);
  }
  return encodeDowHint(prefix.dow);
}

export function parseReminderSpec(spec: string, now: Date = new Date()): ParseResult {
  const norm = normalizeForParse(spec);
  if (!norm) return { ok: false, reason: 'missing_time' };
  const tz = reminderTz();
  const today = getCalendarPartsInTz(now, tz);

  // (0) Relativo "en X (min|h|d) <texto>" — TZ-independent, no requiere
  //     prefijo de fecha. Mantener primero porque "en 2h tomar agua" no
  //     debe matchear nada de la cascada de fechas.
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

  // (1) Intentar prefijo de fecha (hoy / manana / pasado manana / dow /
  //     dow+dd+mes / dd de mes / dd/mm / yyyy-mm-dd).
  const datePrefix = parseDatePrefix(norm, today);
  if (datePrefix) {
    const timePart = parseTimeFromStart(datePrefix.rest);
    if (timePart) {
      const text = timePart.restAfter.trim();
      if (!text) return { ok: false, reason: 'missing_text' };
      const due = resolveDueFromPrefix(datePrefix.prefix, timePart.hour, timePart.minute, now, today, tz);
      return { ok: true, dueAt: due, text: capFirst(text) };
    }
    // Hay fecha pero NO hora → guardar draft y pedir hora.
    const text = datePrefix.rest.trim();
    if (!text) return { ok: false, reason: 'missing_text' };
    if (datePrefix.prefix.kind === 'rel' && datePrefix.prefix.dayOffset === 1) {
      // "manana <texto>" mantiene el reason histórico para preservar el
      // mensaje conocido y los tests existentes.
      return { ok: false, reason: 'tomorrow_needs_hour', text: capFirst(text) };
    }
    return {
      ok: false,
      reason: 'date_needs_hour',
      text: capFirst(text),
      dayHint: encodePrefixAsHint(datePrefix.prefix, today),
    };
  }

  // (2) Solo hora: "[a las] HH:MM <texto>" / "HHam/pm <texto>"
  //     → hoy si futuro (en TZ del usuario), mañana si ya pasó.
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
      const tomorrow = addDays(today, 1);
      due = makeDateInTz(tomorrow.year, tomorrow.month0, tomorrow.day, h, mins, tz);
    }
    return { ok: true, dueAt: due, text: capFirst(text) };
  }

  return { ok: false, reason: 'missing_time' };
}

/**
 * Parsea SOLO una hora (sin texto) y produce un Date según el hint del draft.
 * Mantiene la firma vieja (today|tomorrow) para compat con tests anteriores.
 *
 * Para drafts con dayHint serializado (date:YYYY-MM-DD / dow:N), usar
 * `parseTimeForHint` que sí entiende todos los casos.
 */
export function parseTimeOnly(input: string, dayHint: 'today' | 'tomorrow', now: Date = new Date()): Date | null {
  return parseTimeForHint(input, dayHint, now);
}

/**
 * Parsea hora suelta + cualquier dayHint (string-codificado del draft) y
 * devuelve la Date UTC final, o null si la hora no parsea.
 */
export function parseTimeForHint(input: string, hint: string, now: Date = new Date()): Date | null {
  const norm = normalizeForParse(input);
  const tm = norm.match(/^(?:manana\s+)?(?:a\s+las\s+)?(\d{1,2})(?::(\d{2})|\s*(am|pm))?$/);
  if (!tm) return null;
  const h = hourTo24(parseInt(tm[1], 10), tm[3]);
  if (h === null) return null;
  const mins = tm[2] ? parseInt(tm[2], 10) : 0;
  if (mins < 0 || mins > 59) return null;
  const tz = reminderTz();
  const today = getCalendarPartsInTz(now, tz);
  const decoded = decodeDayHint(hint) ?? { kind: 'tomorrow' as const };

  if (decoded.kind === 'today') {
    let due = makeDateInTz(today.year, today.month0, today.day, h, mins, tz);
    if (due.getTime() <= now.getTime()) {
      const tmw = addDays(today, 1);
      due = makeDateInTz(tmw.year, tmw.month0, tmw.day, h, mins, tz);
    }
    return due;
  }
  if (decoded.kind === 'tomorrow' || decoded.kind === 'unspecified') {
    const tmw = addDays(today, 1);
    return makeDateInTz(tmw.year, tmw.month0, tmw.day, h, mins, tz);
  }
  if (decoded.kind === 'date') {
    return makeDateInTz(decoded.year, decoded.month0, decoded.day, h, mins, tz);
  }
  if (decoded.kind === 'dow') {
    let cand = nextDowFromToday(today, decoded.dow, false);
    let due = makeDateInTz(cand.year, cand.month0, cand.day, h, mins, tz);
    if (due.getTime() <= now.getTime()) {
      cand = addDays(cand, 7);
      due = makeDateInTz(cand.year, cand.month0, cand.day, h, mins, tz);
    }
    return due;
  }
  return null;
}

function splitTaskDump(text: string): string[] {
  return text
    .split(/,|\s+y\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// ─── Parser de SELECCIÓN de agenda (paso 3 del flujo /agenda) ───────────────
// Acepta: índices "1,3,5" / "1 y 3"; "todos|todo|todas"; "ninguno|ninguna|nada";
// texto libre por substring (sin acentos); prefijo afirmativo "sí," / "ok,".
// Ver docs/agenda-contract.md.

export type AgendaSelectionParseResult =
  | { kind: 'indices'; indices: number[] }
  | { kind: 'cancel' }
  | { kind: 'unparsed' };

const AFFIRMATIVE_PREFIX = /^(si|sí|ok|dale|claro|listo|perfecto)\s*[,:]\s*/i;

export function parseAgendaSelection(
  input: string,
  candidates: Array<{ text: string }>,
): AgendaSelectionParseResult {
  if (!input || !candidates || candidates.length === 0) return { kind: 'unparsed' };

  // 1) Strip afirmativo: "Sí, X y Z" → "X y Z".
  let raw = input.trim();
  const m = raw.match(AFFIRMATIVE_PREFIX);
  if (m) raw = raw.slice(m[0].length).trim();
  if (!raw) {
    // Solo dijo "sí" sin elegir nada explícito. Tratar como ambiguo.
    return { kind: 'unparsed' };
  }

  const norm = stripAccentsLower(raw);

  // 2) Cancel ("ninguno", "nada"). Permite frases más largas.
  if (/^(ninguno|ninguna|ningunos|ningunas|nada|cancelar|cancela)\b/.test(norm)) {
    return { kind: 'cancel' };
  }

  // 3) "Todos" / "todo" / "todas".
  if (/^(todos|todo|todas|todas las anteriores|todos los anteriores)\b/.test(norm)) {
    return { kind: 'indices', indices: candidates.map((_, i) => i) };
  }

  // 4) Índices numéricos. Split por ",", " y ", o espacios.
  const numCandidates = norm
    .split(/,|\s+y\s+|\s+/)
    .map((p) => p.trim())
    .filter((p) => /^\d{1,3}$/.test(p));
  const validIdx = numCandidates
    .map((p) => parseInt(p, 10))
    .filter((n) => n >= 1 && n <= candidates.length);
  // Si TODOS los tokens del input parecen números (no hubo palabras), tratar
  // como selección de índices. Esto evita confundir "comer pan, ir 1" con
  // selección numérica.
  if (validIdx.length > 0 && validIdx.length === numCandidates.length) {
    const unique = Array.from(new Set(validIdx));
    return { kind: 'indices', indices: unique.map((n) => n - 1) };
  }

  // 5) Texto libre. Split por "," o " y ", trim, descartar prefijos de
  // categoría ("mantenimiento: limpiar jardín" → "limpiar jardín"). Match
  // por overlap de palabras significativas (>= 3 chars) — más robusto que
  // substring puro: "hacer devocional" matchea "hacer mi devocional", y
  // "terminar LABDEN" matchea "terminar proyecto LABDEN".
  const parts = raw
    .split(/,|\s+y\s+/i)
    .map((p) => p.replace(/^\s*(laboral|personal|mantenimiento|espiritual|otros)\s*:\s*/i, '').trim())
    .filter((p) => p.length >= 3);

  const indices: number[] = [];
  for (const part of parts) {
    const matchIdx = candidates.findIndex((c, idx) => {
      if (indices.includes(idx)) return false;
      return softTextMatch(part, c.text);
    });
    if (matchIdx >= 0) indices.push(matchIdx);
  }

  if (indices.length === 0) return { kind: 'unparsed' };
  return { kind: 'indices', indices };
}

/** Tokeniza para match: lowercase + sin acentos + palabras >= 3 chars. */
function tokenizeForMatch(s: string): string[] {
  return stripAccentsLower(s)
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Match suave entre dos cadenas. Verdadero si:
 *  - comparten >= 2 palabras significativas (>= 3 chars), o
 *  - comparten >= 1 palabra significativa de longitud >= 5 (distintiva).
 * Esto permite que el usuario teclee solo lo distintivo ("LABDEN",
 * "devocional") y aún así matchee el candidato completo.
 */
function softTextMatch(a: string, b: string): boolean {
  const ta = new Set(tokenizeForMatch(a));
  const tb = new Set(tokenizeForMatch(b));
  if (ta.size === 0 || tb.size === 0) return false;
  let overlap = 0;
  let hasDistinctive = false;
  for (const t of ta) {
    if (tb.has(t)) {
      overlap++;
      if (t.length >= 5) hasDistinctive = true;
    }
  }
  return overlap >= 2 || (overlap >= 1 && hasDistinctive);
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
        // Refactor Fase 3: paso 3 del flujo /agenda. El usuario responde con
        // su selección (números, "todos", textos) y guardamos los elegidos
        // como microtasks. Ver docs/agenda-contract.md.
        name: 'agenda_confirm_selection',
        description: 'Confirma cuáles tareas del volcado se guardan en la agenda',
        parameters: {
          selection: { type: 'string', description: 'Selección', required: true },
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
      // ── Fase 4 (inicio): capa NL conversacional ligera (sin LLM) ─────────
      {
        name: 'explain_commands',
        description: 'Explica para qué sirve cada comando del bot',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'explain_natural_language',
        description: 'Explica cómo escribirle al bot en lenguaje natural',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'what_can_you_do',
        description: 'Resumen humano de lo que el bot puede hacer',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      // ── Fase 4B: neuro-reset y procrastinación ───────────────────────────
      {
        name: 'neuro_reset',
        description: 'Regulación breve cuando estás saturado o bloqueado',
        parameters: {},
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'procrastination_decode',
        description: 'Inicia decodificación de procrastinación / evitación',
        parameters: {},
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'micro_action_from_avoidance',
        description: 'Convierte tarea evitada en una acción mínima',
        parameters: {
          task: { type: 'string', description: 'La tarea que estás evitando', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      // ── Fase 4C: TCC ─────────────────────────────────────────────────────
      {
        name: 'rpec',
        description: 'Inicia un Registro Pensamiento-Emoción-Conducta breve',
        parameters: {},
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'reencuadre',
        description: 'Inicia un reencuadre de pensamiento como hipótesis',
        parameters: {},
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'dopar',
        description: 'Inicia DOPAR: definir, opciones, plan, acción, revisión',
        parameters: {},
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'revision_tcc',
        description: 'Revisión breve de patrones (no análisis profundo)',
        parameters: {},
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        // Capability genérica que avanza cualquier flujo multi-paso de Fase 4
        // (RPEC, reencuadre, DOPAR, revisión, procrastinación, espiritual).
        // Lee el flow desde pending_flow_draft.
        name: 'flow_step',
        description: 'Avanza un flujo conversacional con la respuesta del usuario',
        parameters: {
          answer: { type: 'string', description: 'Respuesta a la pregunta anterior', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      // ── Fase 4D: espiritualidad cristiana ────────────────────────────────
      {
        name: 'christian_prayer',
        description: 'Oración breve guiada cristiana',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'christian_devotional',
        description: 'Devocional breve: verdad, pregunta, acción, oración',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'spiritual_mode',
        description: 'Elige una práctica espiritual breve',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'neuro_or_faith_offer',
        description: 'Ofrece abordar bloqueo desde neurociencia, fe o ambos',
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
      // /agenda se maneja via reglas (admite args opcionales: /agenda <volcado>).
      // Recursos de crisis (READ_ONLY, derivación)
      '/recursos': 'show_crisis_resources',
      '/crisis_recursos': 'show_crisis_resources',
      // Fase 3 (sin args): comandos directos
      '/recordatorios': 'list_reminders',
      '/ver_recordatorios': 'show_overdue_reminders',
      // Fase 4B
      '/reset90': 'neuro_reset',
      '/soma': 'neuro_reset',
      '/procrastinacion': 'procrastination_decode',
      // Fase 4C
      '/rpec': 'rpec',
      '/reencuadre': 'reencuadre',
      '/dopar': 'dopar',
      '/revision': 'revision_tcc',
      // Fase 4D
      '/oracion': 'christian_prayer',
      '/devocional': 'christian_devotional',
      '/espiritual': 'spiritual_mode',
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
          /^(que sabes de mi|que guardas(?:\s+de\s+mi)?|ver mis datos|que datos tienes|que datos guardas)$/,
        ],
        action: 'show_privacy',
      },

      // ── Fase 2 — Borrado ─────────────────────────────────────────────────
      {
        patterns: [
          /^(borrar todo|borralo todo|borra mis datos|elimina mis datos|borra lo que sabes(?: de mi)?|elimina todo lo que tienes)$/,
        ],
        action: 'delete_all_state',
      },

      // ── Fase 2 — Anti-abandono ───────────────────────────────────────────
      // Reglas específicas; no incluyen frases ambiguas que el pre-filter
      // global de crisis ya intercepta ("no quiero seguir", "ya no quiero", etc.)
      {
        // "ya falle" salió de aquí: en Fase 4 va a reencuadre (pensamiento
        // automático, no abandono del hábito).
        patterns: [
          /^(lo dejo|me rindo|me harte|esto no sirve|manana mejor)$/,
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

      // ── Fase 2 — Agenda (refactor Fase 3): flujo conversacional ─────────
      // /agenda solo → invitar a volcar
      {
        patterns: [/^\/agenda$/i],
        action: 'agenda_start',
      },
      // /agenda <texto> → clasificar directo (atajo)
      {
        patterns: [/^\/agenda\s+(.+)$/i],
        action: 'agenda_classify',
        extractParams: (_match, _normalized, rawText) => {
          const m = rawText.match(/^\/agenda\s+(.+)$/i);
          return { dump: (m?.[1] ?? '').trim() };
        },
      },
      // NL para iniciar el flujo de agenda
      {
        patterns: [
          /^(organiza mi dia|ordena mi dia|ayudame con el dia)$/,
          /^(quiero ordenar mi dia|ayudame a ordenar mi dia|quiero organizar mi dia)$/,
          /^(no se que hacer)$/,
        ],
        action: 'agenda_start',
      },
      // 3+ items separados por comas o " y " → clasificar directo
      // (atajo sin /agenda; entra al mismo flujo)
      {
        patterns: [
          /^[^,]+,\s*[^,]+,[^,]+/,
        ],
        action: 'agenda_classify',
        extractParams: (_match, _normalized, rawText) => ({ dump: rawText }),
      },
      // Consulta: "qué tengo hoy", "mi agenda", "ya los cargaste"
      {
        patterns: [
          /^(que tengo hoy|mi agenda|ya los cargaste(?:\s+a mi agenda)?|como va mi dia)\??$/,
        ],
        action: 'list_today_focus',
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
      // NL: "recuérdame X" / "recuerdame X" → add_reminder con spec=X
      // (el /help promete esta frase: "recuérdame mañana a las 9 llamar al doctor")
      {
        patterns: [/^recuerdame\s+(.+)$/i],
        action: 'add_reminder',
        extractParams: (_match, _normalized, rawText) => {
          const m = rawText.match(/^recu[eé]rdame\s+(.+)$/i);
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

      // ── Fase 4 — NL para acciones existentes ─────────────────────────────
      {
        patterns: [
          /^(quiero ver mis recordatorios|muestrame mis recordatorios|ver mis recordatorios|cuales son mis recordatorios)$/,
        ],
        action: 'list_reminders',
      },
      {
        // NL silencio con duración: "necesito silencio por 2 horas"
        patterns: [
          /^(?:necesito|quiero)\s+silencio\s+por\s+(\d+)\s*h(?:oras?)?$/,
          /^(?:pausa|pausalos|pausa los)\s+mensajes\s+por\s+(\d+)\s*h(?:oras?)?$/,
        ],
        action: 'set_silence',
        extractParams: (match) => ({ duration: `${match[1]}h` }),
      },
      {
        // NL silencio sin duración explícita
        patterns: [
          /^(necesito silencio|pausa mensajes|pausa los mensajes|silencio por favor)$/,
        ],
        action: 'set_silence',
        extractParams: () => ({ duration: '' }),
      },

      // ── Fase 4 — NL conversacional: explicaciones y orientación ──────────
      // Activadores deliberadamente concretos para evitar falsos positivos.
      {
        patterns: [
          /^(?:para que (?:me )?(?:sirve|sirven) (?:cada )?comando(?:s)?|que hace cada comando|explicame los comandos|como funcionan los comandos)$/,
          /^(?:que (?:significa|hace)) (\/[a-z_]+)$/,
          /^para que sirve (\/[a-z_]+)$/,
        ],
        action: 'explain_commands',
      },
      {
        patterns: [
          /^no dices que (?:tambien )?puedo escribir en lenguaje natural\??$/,
          /^(?:como|de que forma) escribo en lenguaje natural\??$/,
          /^(?:que puedo escribir sin comandos|no entiendo como hablarte|como te hablo)\??$/,
        ],
        action: 'explain_natural_language',
      },
      {
        patterns: [
          /^(?:que puedes hacer|como me ayudas|para que sirves|que haces|como te uso)\??$/,
        ],
        action: 'what_can_you_do',
      },

      // ── Fase 4B — Neuro-reset y procrastinación ──────────────────────────
      // ORDEN: neuro_or_faith_offer ANTES de neuro_reset y procrastination,
      // para que si el usuario menciona fe+bloqueo gane la oferta combinada.
      {
        // Fe + bloqueo/procrastinación → preguntar enfoque.
        // Usa \w* en los sufijos para capturar "procrastinacion",
        // "procrastinando", "evitando", "evito", "postergando", etc.
        patterns: [
          /(?=.*\b(dios|fe|pecado|oracion|obediencia|llamado|proposito|culpa(?: espiritual| religiosa)?)\b)(?=.*\b(procrastin\w*|bloqueado|saturado|evit\w*|postergand\w*|no puedo empezar|no me da la vida|colapsad\w*|cabeza llena|tarea evitada)\b)/,
        ],
        action: 'neuro_or_faith_offer',
      },
      // Neuro-reset NL
      {
        patterns: [
          /^(estoy saturado|estoy bloqueado|no puedo empezar|tengo la cabeza llena|no me da la vida|estoy colapsado|no se por donde empezar)$/,
        ],
        action: 'neuro_reset',
      },
      // Procrastinación NL
      {
        patterns: [
          /^(estoy procrastinando|no puedo dejar el celular|estoy evitando una tarea|se que hacer pero no empiezo|quiero hacerlo pero no arranco|estoy postergando|estoy evadiendo)$/,
        ],
        action: 'procrastination_decode',
      },

      // ── Fase 4C — Reencuadre NL (frases automáticas comunes) ─────────────
      // NOTA: estos triggers son específicos para pensamientos rumiantes que
      // NO son crisis (crisis pre-filter ya intercepta antes).
      {
        patterns: [
          /^(no sirvo para esto|siempre arruino todo|ya fall[eé]|si no lo hago perfecto no cuenta)$/,
          /^estoy pensando que .+$/,
          /^siento que soy .+$/,
          /^seguro va a salir mal$/,
        ],
        action: 'reencuadre',
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
      case 'agenda_confirm_selection':
        return await this.agendaConfirmSelection(userId, params);
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
      // ── Fase 4 NL ──
      case 'explain_commands':
        return this.explainCommands();
      case 'explain_natural_language':
        return this.explainNaturalLanguage();
      case 'what_can_you_do':
        return this.whatCanYouDo();
      // ── Fase 4B ──
      case 'neuro_reset':
        return await this.neuroReset(userId);
      case 'procrastination_decode':
        return this.procrastinationDecode(userId);
      case 'micro_action_from_avoidance':
        return await this.microActionFromAvoidance(userId, params);
      // ── Fase 4C ──
      case 'rpec':
        return await this.startTccFlow(userId, 'rpec');
      case 'reencuadre':
        return await this.startTccFlow(userId, 'reencuadre');
      case 'dopar':
        return await this.startTccFlow(userId, 'dopar');
      case 'revision_tcc':
        return await this.startTccFlow(userId, 'revision_tcc');
      case 'flow_step':
        return await this.flowStep(userId, params);
      // ── Fase 4D ──
      case 'christian_prayer':
        return this.christianPrayer();
      case 'christian_devotional':
        return this.christianDevotional();
      case 'spiritual_mode':
        return await this.spiritualMode(userId);
      case 'neuro_or_faith_offer':
        return await this.neuroOrFaithOffer(userId);
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
    // Cosmovisión declarada (Fase 4D).
    lines.push('- Cosmovisión declarada por ti: cristiana.');
    // Conteos de Fase 4 (TCC, neuro/procrastinación, espiritual).
    const tccCount = await this.store.countJournalEntries(userId, [
      'tcc_rpec', 'tcc_reframe', 'tcc_dopar', 'tcc_review',
    ]);
    const neuroCount = await this.store.countJournalEntries(userId, [
      'neuro_reset', 'procrastination_note',
    ]);
    const spiritualCount = await this.store.countJournalEntries(userId, ['spiritual_practice']);
    lines.push(`- Registros TCC guardados: ${tccCount}.`);
    lines.push(`- Registros de procrastinación/neuro-reset: ${neuroCount}.`);
    lines.push(`- Prácticas espirituales guardadas: ${spiritualCount}.`);
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

  // ─── /agenda (refactor Fase 3): flujo conversacional 4 pasos ────────────
  // Ver docs/agenda-contract.md para el diseño completo.

  private agendaStart(): ActionResult {
    return {
      success: true,
      message:
        'Vamos a ordenar el día. Vuélcame lo que tienes en bruto; yo lo separo ' +
        'en laboral, personal, mantenimiento, espiritual y otros.',
      // Paso 1 → 2: el SIGUIENTE mensaje del usuario se trata como volcado.
      pendingInput: {
        action: 'agenda_classify',
        paramName: 'dump',
        prompt: 'Vuélcame tu lista en bruto.',
      },
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

    // Clasifica y arma lista numerada plana para la selección posterior.
    const classified: Array<{ text: string; category: Category }> = items.map((it) => ({
      text: it,
      category: classifyItem(it),
    }));

    // Persiste candidatos para el paso 3 (selección).
    await this.store.setPendingAgendaSelection(
      userId,
      classified.map((c) => ({ text: c.text, category: c.category })),
    );

    // Render: lista numerada con su categoría. Markdown-safe (texto del usuario
    // escapado para que un "_" no rompa el render de Telegram).
    const lines: string[] = ['Lo separé así:'];
    classified.forEach((c, i) => {
      const safe = escapeMdV1(c.text);
      lines.push(`${i + 1}. ${safe} — ${c.category}`);
    });
    lines.push('');
    lines.push(
      '¿Cuáles eliges para hoy? Responde con números (ej: 1, 3, 5), con "todos", ' +
      'o repitiendo los textos. Si nada de esto, escribe "ninguno".',
    );

    return {
      success: true,
      message: lines.join('\n'),
      // Paso 2 → 3: el SIGUIENTE mensaje del usuario es la selección.
      pendingInput: {
        action: 'agenda_confirm_selection',
        paramName: 'selection',
        prompt: '¿Cuáles eliges?',
      },
    };
  }

  private async agendaConfirmSelection(
    userId: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    const selection = String(params.selection ?? '').trim();
    const candidates = await this.store.getPendingAgendaSelection(userId);
    if (!candidates || candidates.length === 0) {
      // No hay selección pendiente (ej: el usuario abandonó el flujo y vuelve
      // a teclear algo que cayó aquí). Mensaje claro, no fallback.
      return {
        success: false,
        message:
          'ℹ️ No tengo una selección de agenda pendiente. Empieza con /agenda ' +
          'para volcar tu día.',
      };
    }

    const parsed = parseAgendaSelection(selection, candidates);

    if (parsed.kind === 'cancel') {
      await this.store.clearPendingAgendaSelection(userId);
      return {
        success: true,
        message:
          'Listo, no guardé nada. Cuando quieras retomar, vuelve con /agenda.',
      };
    }

    if (parsed.kind === 'unparsed') {
      // Preserva el pending_input para que el usuario reintente.
      return {
        success: false,
        message:
          '⚠️ No entendí tu selección. Responde con números (ej: 1, 3, 5), con ' +
          '"todos", o repitiendo los textos.',
        pendingInput: {
          action: 'agenda_confirm_selection',
          paramName: 'selection',
          prompt: '¿Cuáles eliges?',
        },
      };
    }

    // parsed.kind === 'indices'
    const indices = parsed.indices;
    if (indices.length === 0) {
      // Edge case: parseó pero ningún match. Re-prompt.
      return {
        success: false,
        message:
          '⚠️ No encontré ninguna tarea que coincida con eso. Prueba con números ' +
          '(ej: 1, 3) o repite los textos exactamente.',
        pendingInput: {
          action: 'agenda_confirm_selection',
          paramName: 'selection',
          prompt: '¿Cuáles eliges?',
        },
      };
    }

    // Guardar como microtasks. Mismo modelo existente; sin schema change.
    const chosen = indices.map((i) => candidates[i].text);
    for (const text of chosen) {
      await this.store.addMicroTask(userId, text);
    }
    await this.store.clearPendingAgendaSelection(userId);

    const safeList = chosen.map(escapeMdV1).join(', ');
    return {
      success: true,
      message:
        `✅ Cargué a tu día: ${safeList}. ` +
        'Ver con /focus o pregunta "qué tengo hoy".',
    };
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
        // Guardar el draft y pedir hora explícita (mensaje histórico).
        await this.store.setPendingReminderDraft(userId, {
          text: parsed.text,
          dayHint: 'tomorrow',
        });
        return {
          success: true,
          message: `🕒 ¿A qué hora mañana quieres que te recuerde "${escapeMdV1(parsed.text)}"? (Ej: 9am, 15:00)`,
        };
      }
      if (parsed.reason === 'date_needs_hour') {
        // Fecha (pasado mañana / día semana / dd/mm / yyyy-mm-dd) sin hora.
        // Guardar draft con dayHint serializado para que parseTimeForHint
        // pueda completarlo cuando llegue la hora.
        await this.store.setPendingReminderDraft(userId, {
          text: parsed.text,
          dayHint: parsed.dayHint,
        });
        return {
          success: true,
          message: '🕒 ¿A qué hora quieres que te lo recuerde ese día? (Ej: 9am, 15:00)',
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
          '⚠️ No entendí el tiempo. Usa: "en 2h <texto>", "mañana 9am <texto>", ' +
          '"pasado mañana 10:30am <texto>", "jueves 10:30 <texto>" ' +
          'o "14/05 10:30 <texto>".',
      };
    }
    const { id } = await this.store.addReminder(userId, parsed.text, parsed.dueAt.toISOString());
    // Mensaje deliberadamente sin "_", "*", "`", "[" — el Markdown v1 legacy
    // de Telegram NO procesa "\_" como literal, así que la única forma segura
    // es no incluir esos caracteres. Slash command omitido por contener "_".
    return {
      success: true,
      message:
        `✅ Listo, recordatorio guardado: "${escapeMdV1(parsed.text)}" para ${formatLocalDateTime(parsed.dueAt.toISOString())}. ` +
        `(id ${id})`,
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
    return { success: true, message: `🗑️ Cancelado: "${escapeMdV1(cancelledText)}".` };
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
    // parseTimeForHint maneja todos los formatos de dayHint (literales +
    // 'date:YYYY-MM-DD' + 'dow:N'). El draft de "manana" sigue funcionando
    // porque hint='tomorrow' es uno de los casos soportados.
    const due = parseTimeForHint(timeSpec, draft.dayHint);
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
        `✅ Listo, te recuerdo "${escapeMdV1(draft.text)}" el ${formatLocalDateTime(due.toISOString())}. (id ${id})`,
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
    // Markdown-safe: sin asteriscos en el header, fechas en local, texto del
    // usuario escapado (un "_" en un nombre rompía el render entero antes).
    const lines: string[] = ['Recordatorios acumulados durante silencio:', ''];
    const idsSet = new Set(summary.reminderIds);
    lines.push(`Tuviste ${summary.reminderIds.length} recordatorio(s) durante silencio. Ya fueron registrados como entregados.`);
    if (allPending.length > 0) {
      lines.push('', 'Pendientes a futuro:');
      allPending.forEach((r, i) => {
        if (!idsSet.has(r.id)) {
          const text = (r?.text && String(r.text).trim()) ? escapeMdV1(String(r.text).trim()) : '(sin texto)';
          lines.push(`${i + 1}. ${text} — ${formatLocalDateTime(r?.dueAt)}`);
        }
      });
    }
    await this.store.clearPendingOverdueSummary(userId);
    return { success: true, message: lines.join('\n') };
  }

  // ─── Fase 4: NL conversacional ligera ──────────────────────────────────

  private explainCommands(): ActionResult {
    // Sin "_" ni "*" para sobrevivir Markdown v1 legacy de Telegram.
    const message = [
      'Claro. Te explico los principales:',
      '',
      '- /agenda: me vuelcas lo que tienes en la cabeza y lo ordeno.',
      '- /recordar: programo un recordatorio con fecha y hora.',
      '- /recordatorios: te muestro lo pendiente.',
      '- /silencio: pauso mensajes proactivos.',
      '- /abandonar: hacemos una pausa antes de rendirte.',
      '- /reinicio: volvemos al mínimo sin culpa.',
      '- /reset90: bajamos saturación antes de pensar.',
      '- /procrastinacion: entendemos la evitación y la convertimos en acción mínima.',
      '- /privacidad: ves qué guardo y puedes borrar datos.',
      '- /recursos: muestra líneas de apoyo.',
    ].join('\n');
    return { success: true, message };
  }

  private explainNaturalLanguage(): ActionResult {
    const message = [
      'Sí puedes escribirme natural, pero todavía entiendo mejor frases concretas. Ejemplos:',
      '',
      '- "recuérdame mañana a las 9 llamar al doctor"',
      '- "quiero ordenar mi día"',
      '- "me rindo"',
      '- "estoy bloqueado"',
      '- "no sé por dónde empezar"',
      '- "quiero ver mis recordatorios"',
      '- "necesito silencio por 2 horas"',
      '',
      'Si algo no lo entiendo, puedes usar /help.',
    ].join('\n');
    return { success: true, message };
  }

  private whatCanYouDo(): ActionResult {
    const message =
      'Puedo ayudarte a ordenar tu día, crear recordatorios, partir tareas grandes, ' +
      'pausar antes de abandonar, reiniciar sin culpa, regularte cuando estás saturado, ' +
      'revisar pensamientos con herramientas simples y acompañarte con oración o ' +
      'reflexión cristiana si lo quieres.';
    return { success: true, message };
  }

  /** Texto curado de /help (sin nombres internos de capabilities). */
  getHelpText(): string {
    return [
      'Ayuda — ADHD Coach',
      '',
      'Comandos principales:',
      '/agenda — ordenar tu día.',
      '/recordar — crear recordatorios.',
      '/recordatorios — ver pendientes.',
      '/silencio — pausar mensajes proactivos.',
      '/privacidad — ver qué guardo.',
      '/abandonar — pausa antes de rendirte.',
      '/reinicio — volver sin culpa.',
      '/recursos — líneas de apoyo.',
      '/checkin — registrar cómo vas.',
      '/focus — ver foco y microtareas.',
      '',
      'Regulación y procrastinación:',
      '/reset90 — regularte cuando estás saturado.',
      '/procrastinacion — entender y destrabar evitación.',
      '',
      'Herramientas TCC:',
      '/rpec — ordenar pensamiento, emoción y conducta.',
      '/reencuadre — revisar un pensamiento automático.',
      '/dopar — resolver un problema paso a paso.',
      '/revision — revisar patrones.',
      '',
      'Espiritualidad cristiana:',
      '/oracion — oración breve guiada.',
      '/devocional — pausa espiritual breve.',
      '/espiritual — elegir oración, gratitud, examen o intención del día.',
      '',
      'También puedes escribir frases como:',
      '- "recuérdame mañana a las 9 llamar al doctor"',
      '- "quiero ordenar mi día"',
      '- "me rindo"',
      '- "estoy bloqueado"',
      '- "estoy procrastinando"',
      '- "qué puedes hacer"',
      '- "para qué sirve /agenda"',
    ].join('\n');
  }

  /** Mensaje cuando el router no resuelve la intención. */
  getFallbackMessage(): string {
    return (
      'No lo entendí del todo. Puedo ayudarte con agenda, recordatorios, bloqueo, ' +
      'reinicio, silencio, privacidad, procrastinación o TCC breve. ' +
      'Prueba: "qué puedes hacer", "quiero ordenar mi día", "estoy bloqueado" o /help.'
    );
  }

  // ─── Fase 4B: neuro-reset y procrastinación ─────────────────────────────

  private async neuroReset(userId: string): Promise<ActionResult> {
    await this.store.addJournalEntry(userId, 'neuro_reset', new Date().toISOString());
    const message = [
      'Pausa. No vamos a resolver todo ahora.',
      'Puede que tu sistema esté en modo alerta, no en modo flojera.',
      '',
      'Haz esto:',
      '1. Suelta mandíbula y hombros.',
      '2. Exhala lento una vez.',
      '3. Mira un punto fijo durante 10 segundos.',
      '',
      'Ahora dime solo una cosa: ¿qué tarea estás evitando?',
    ].join('\n');
    return {
      success: true,
      message,
      pendingInput: {
        action: 'micro_action_from_avoidance',
        paramName: 'task',
        prompt: '¿Qué tarea estás evitando?',
      },
    };
  }

  private procrastinationDecode(_userId: string): ActionResult {
    const message = [
      'Puede que tu cerebro no esté buscando flojera, sino alivio rápido.',
      'Cuando una tarea se siente grande, ambigua o amenazante, es normal ' +
        'buscar escape inmediato. No vamos a pelear con eso; vamos a reducir ' +
        'la amenaza.',
      '',
      '¿Qué tarea estás evitando? Escríbela en una frase.',
    ].join('\n');
    return {
      success: true,
      message,
      pendingInput: {
        action: 'micro_action_from_avoidance',
        paramName: 'task',
        prompt: '¿Qué tarea estás evitando?',
      },
    };
  }

  private async microActionFromAvoidance(
    userId: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    const task = String(params.task ?? '').trim();
    if (!task) {
      return {
        success: false,
        message: '⚠️ Necesito la tarea que estás evitando, en una frase.',
        pendingInput: {
          action: 'micro_action_from_avoidance',
          paramName: 'task',
          prompt: '¿Qué tarea estás evitando?',
        },
      };
    }
    // Persistir tarea evitada (sin elección todavía).
    await this.store.addJournalEntry(
      userId,
      'procrastination_note',
      JSON.stringify({ task, at: new Date().toISOString() }),
    );
    const message = [
      'Vamos a bajarla de amenaza a movimiento. La primera acción no es ' +
        'terminarla. Es solo abrir la puerta.',
      '',
      'Elige una:',
      'A) abrir el archivo',
      'B) escribir una línea imperfecta',
      'C) poner temporizador de 2 minutos',
      'D) pedir ayuda o aclarar el siguiente paso',
    ].join('\n');
    return { success: true, message };
  }

  // ─── Fase 4C: TCC — flujo multi-paso genérico ───────────────────────────

  // Cada flujo declara sus preguntas. El handler `flow_step` avanza el draft.
  private static readonly TCC_FLOWS: Record<string, {
    intro: string;
    questions: string[];
    journalType: string;
    summaryLabels: string[];
  }> = {
    rpec: {
      intro:
        'Vamos con un RPEC breve. No es terapia; es una herramienta de ' +
        'organización mental. Primero: ¿qué pasó?',
      questions: [
        '¿Qué pensamiento apareció?',
        '¿Qué emoción sentiste y con qué intensidad 1-10?',
        '¿Qué hiciste o qué impulso apareció?',
        '¿Cuál sería una acción pequeña útil ahora?',
      ],
      journalType: 'tcc_rpec',
      summaryLabels: ['Situación', 'Pensamiento', 'Emoción', 'Conducta/impulso', 'Acción pequeña'],
    },
    reencuadre: {
      intro:
        'Tomemos ese pensamiento como hipótesis, no como sentencia. ' +
        '¿Cuál es la frase exacta que te está pegando?',
      questions: [
        '¿Qué evidencia lo apoya?',
        '¿Qué evidencia lo matiza?',
        '¿Cuál sería una versión más útil y realista?',
        '¿Qué acción pequeña haría esa versión?',
      ],
      journalType: 'tcc_reframe',
      summaryLabels: ['Pensamiento', 'Evidencia a favor', 'Evidencia que matiza', 'Versión útil', 'Acción pequeña'],
    },
    dopar: {
      intro: 'Vamos con DOPAR. Primero, define el problema en una frase sencilla.',
      questions: [
        'Dame 2 o 3 opciones posibles, aunque sean imperfectas.',
        'Elige un plan mínimo.',
        '¿Cuál es la acción de 2 minutos?',
        '¿Cuándo revisamos?',
      ],
      journalType: 'tcc_dopar',
      summaryLabels: ['Problema', 'Opciones', 'Plan', 'Acción 2 min', 'Revisión'],
    },
    revision_tcc: {
      intro: '¿Qué se repitió esta semana?',
      questions: [
        '¿Qué te ayudó aunque fuera poco?',
        '¿Qué obstáculo apareció?',
        '¿Qué ajuste pequeño hacemos?',
        '¿Quieres programar un recordatorio? (sí/no)',
      ],
      journalType: 'tcc_review',
      summaryLabels: ['Repetido', 'Ayudó', 'Obstáculo', 'Ajuste', 'Recordatorio'],
    },
  };

  private async startTccFlow(userId: string, flow: keyof typeof AdhdCoachDomainHandler.TCC_FLOWS): Promise<ActionResult> {
    const def = AdhdCoachDomainHandler.TCC_FLOWS[flow];
    // Sobrescribe cualquier draft previo (incluido un flow distinto).
    await this.store.setPendingFlowDraft(userId, { flow, step: 1, answers: [] });
    return {
      success: true,
      message: def.intro,
      pendingInput: {
        action: 'flow_step',
        paramName: 'answer',
        prompt: def.intro,
      },
    };
  }

  private async flowStep(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const answer = String(params.answer ?? '').trim();
    const draft = await this.store.getPendingFlowDraft(userId);
    if (!draft) {
      return {
        success: false,
        message:
          'ℹ️ No hay un flujo activo. Inicia con /rpec, /reencuadre, /dopar, /revision o /espiritual.',
      };
    }
    if (!answer) {
      return {
        success: false,
        message: '⚠️ Necesito que escribas una respuesta.',
        pendingInput: { action: 'flow_step', paramName: 'answer', prompt: '¿Y...?' },
      };
    }

    // Flujos de elección rápida (single-step).
    if (draft.flow === 'spiritual_choice') {
      await this.store.clearPendingFlowDraft(userId);
      return this.resolveSpiritualChoice(userId, answer);
    }
    if (draft.flow === 'neuro_or_faith') {
      await this.store.clearPendingFlowDraft(userId);
      return this.resolveNeuroOrFaith(answer);
    }

    // Flujos TCC multi-paso.
    const def = AdhdCoachDomainHandler.TCC_FLOWS[draft.flow];
    if (!def) {
      await this.store.clearPendingFlowDraft(userId);
      return {
        success: false,
        message: 'ℹ️ Flujo desconocido. Empieza de nuevo con /rpec, /reencuadre, /dopar o /revision.',
      };
    }
    const answers = [...draft.answers, answer];
    const totalSteps = def.questions.length + 1; // 1 intro + N follow-ups
    if (answers.length < totalSteps) {
      const nextQuestion = def.questions[answers.length - 1];
      await this.store.setPendingFlowDraft(userId, { flow: draft.flow, step: draft.step + 1, answers });
      return {
        success: true,
        message: nextQuestion,
        pendingInput: { action: 'flow_step', paramName: 'answer', prompt: nextQuestion },
      };
    }
    // Finalización: persistir + resumen.
    const summary = answers.map((a, i) => `- ${def.summaryLabels[i]}: ${escapeMdV1(a)}`).join('\n');
    await this.store.addJournalEntry(userId, def.journalType, JSON.stringify(answers));
    await this.store.clearPendingFlowDraft(userId);
    return {
      success: true,
      message: [
        'Gracias. Lo dejo resumido así:',
        summary,
        '',
        'No buscamos perfección. Solo un siguiente paso.',
      ].join('\n'),
    };
  }

  private async resolveSpiritualChoice(userId: string, answer: string): Promise<ActionResult> {
    const a = stripAccentsLower(answer).trim();
    const letter = (a.match(/^([a-e])\b/)?.[1] ??
      (/\boracion\b/.test(a) ? 'a' :
       /\bgratitud\b/.test(a) ? 'b' :
       /\bexamen\b/.test(a) ? 'c' :
       /\bintencion\b/.test(a) ? 'd' :
       /\bintegrar|tarea\b/.test(a) ? 'e' : '')) as 'a'|'b'|'c'|'d'|'e'|'';
    let kind = '';
    let body = '';
    switch (letter) {
      case 'a':
        kind = 'prayer';
        body =
          'Oración breve: Señor, dame claridad y paz. Ayúdame a moverme desde ' +
          'gracia, no desde culpa. Amén.';
        break;
      case 'b':
        kind = 'gratitude';
        body = 'Gratitud: nombra 3 cosas pequeñas por las que puedes dar gracias ahora.';
        break;
      case 'c':
        kind = 'examen';
        body =
          'Examen del día: ¿dónde sentiste paz hoy? ¿dónde sentiste resistencia? ' +
          '¿qué quieres entregar?';
        break;
      case 'd':
        kind = 'intencion';
        body =
          'Intención del día: nómbrala en una frase. Hoy quiero responder con ' +
          '____ ante ____.';
        break;
      case 'e':
        kind = 'integrar';
        body =
          'Integración: dime la tarea concreta y la unimos a una oración o ' +
          'intención sencilla.';
        break;
      default:
        return {
          success: false,
          message: '⚠️ No entendí. Responde con A, B, C, D o E.',
          pendingInput: {
            action: 'flow_step',
            paramName: 'answer',
            prompt: '¿A, B, C, D o E?',
          },
        };
    }
    await this.store.addJournalEntry(
      userId,
      'spiritual_practice',
      JSON.stringify({ kind, at: new Date().toISOString() }),
    );
    return { success: true, message: body };
  }

  private resolveNeuroOrFaith(answer: string): ActionResult {
    const a = stripAccentsLower(answer).trim();
    const isAmbos = /\bambos\b|\b(neuro.*fe|fe.*neuro|c)\b/.test(a) && !/^a\b/.test(a) && !/^b\b/.test(a);
    const isNeuro = /^a\b|\bneuro|neurociencia/.test(a) && !isAmbos;
    const isFe = /^b\b|\bfe\b|espiritual/.test(a) && !isAmbos;

    if (isAmbos || /^c\b/.test(a)) {
      return {
        success: true,
        message: [
          'Neuro: puede que tu sistema esté buscando alivio rápido porque la ' +
            'tarea se siente grande o amenazante.',
          'Fe: no necesitas obedecer desde culpa; puedes responder desde gracia ' +
            'con un paso pequeño y fiel.',
          'Acción: abre la puerta con 2 minutos. ¿Cuál es la tarea?',
        ].join('\n'),
      };
    }
    if (isNeuro) {
      return {
        success: true,
        message: [
          'Pausa. Suelta mandíbula y hombros. Exhala lento.',
          'Tu sistema puede estar en modo alerta, no en flojera.',
          '',
          '¿Cuál es la tarea? La bajamos de amenaza a un primer paso pequeño.',
        ].join('\n'),
      };
    }
    if (isFe) {
      return {
        success: true,
        message: [
          'Desde gracia, no desde culpa: no necesitas resolver toda tu vida ' +
            'para obedecer en el siguiente paso.',
          'Acción: 2 minutos de fidelidad pequeña. ¿Cuál es la tarea?',
        ].join('\n'),
      };
    }
    return {
      success: false,
      message: '⚠️ No entendí. Responde A (neurociencia), B (fe) o C (ambos).',
      pendingInput: {
        action: 'flow_step',
        paramName: 'answer',
        prompt: 'A) neurociencia, B) fe, C) ambos',
      },
    };
  }

  // ─── Fase 4D: espiritualidad cristiana ──────────────────────────────────

  private christianPrayer(): ActionResult {
    const message = [
      'Claro. Oramos breve:',
      '',
      'Señor, dame claridad para hacer lo siguiente con humildad y paciencia. ' +
        'Ayúdame a no moverme desde la culpa, sino desde la obediencia sencilla. ' +
        'Amén.',
      '',
      'Ahora dime: ¿cuál es la siguiente acción pequeña?',
    ].join('\n');
    return { success: true, message };
  }

  private christianDevotional(): ActionResult {
    const message = [
      'Verdad: no necesitas resolver toda tu vida para obedecer en el siguiente paso.',
      '',
      'Pregunta: ¿qué pequeño acto de fidelidad está delante de ti ahora?',
      '',
      'Acción: haz 2 minutos de la tarea que estás evitando.',
      '',
      'Oración: Señor, ayúdame a ser fiel en lo pequeño. Amén.',
    ].join('\n');
    return { success: true, message };
  }

  private async spiritualMode(userId: string): Promise<ActionResult> {
    const message = [
      '¿Quieres una práctica espiritual breve ahora?',
      '',
      'A) oración',
      'B) gratitud',
      'C) examen del día',
      'D) intención del día',
      'E) integrar esto con una tarea concreta',
    ].join('\n');
    await this.store.setPendingFlowDraft(userId, {
      flow: 'spiritual_choice',
      step: 1,
      answers: [],
    });
    return {
      success: true,
      message,
      pendingInput: {
        action: 'flow_step',
        paramName: 'answer',
        prompt: '¿A, B, C, D o E?',
      },
    };
  }

  private async neuroOrFaithOffer(userId: string): Promise<ActionResult> {
    const message = '¿Quieres que lo abordemos desde neurociencia, espiritualidad cristiana o ambos?';
    await this.store.setPendingFlowDraft(userId, {
      flow: 'neuro_or_faith',
      step: 1,
      answers: [],
    });
    return {
      success: true,
      message,
      pendingInput: {
        action: 'flow_step',
        paramName: 'answer',
        prompt: 'A) neurociencia, B) fe, C) ambos',
      },
    };
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
        // 1 solo recordatorio vencido y sin acumulación previa → enviar normal.
        // Escape Markdown del texto del usuario para no romper el render.
        const r = list[0];
        const safeText = (r?.text && String(r.text).trim()) ? escapeMdV1(String(r.text).trim()) : '(sin texto)';
        await send(userId, `🔔 Recordatorio: ${safeText}`);
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
