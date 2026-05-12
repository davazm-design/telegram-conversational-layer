/**
 * Crisis Detector — pre-filtro de seguridad transversal.
 *
 * Detecta señales de ideación suicida, autolesión, daño a otros, disociación
 * y crisis emocional grave. Pensado para activarse ANTES que pending_input,
 * pending_action, router, policy engine y domain handlers.
 *
 * Modelo de seguridad: si hay duda razonable de riesgo, gana el filtro.
 *
 * No diagnostica, no medica, no sustituye terapia. Solo deriva a recursos
 * humanos / profesionales con un mensaje fijo.
 *
 * Es transversal: aplica a TODOS los dominios. No depende de ninguno en
 * particular ni importa nada de `src/examples/`. Cualquier dominio nuevo
 * lo hereda automáticamente al pasar por el Orchestrator.
 */

import { normalizeForMatching } from '../router/text.normalizer';

/**
 * Mensaje fijo de derivación. Tres frases, sin diagnóstico, sin promesas.
 */
export const CRISIS_FIXED_MESSAGE =
  'Lo que me cuentas es importante y quiero que estés a salvo. ' +
  'Contacta ahora con emergencias o una línea de crisis local. ' +
  '¿Quieres que te muestre recursos de tu país o que preparemos un mensaje para tu contacto de respaldo?';

/**
 * Lista de palabras clave en español, ya normalizadas:
 *   - lowercase
 *   - sin acentos en aeiouü (á→a, etc.)
 *   - ñ se preserva (la normalización del router preserva ñ)
 *   - trim + collapse spaces
 *
 * Esta lista DEBE revisarse con un profesional de salud mental antes de
 * exponer el bot a usuarios reales en cualquier dominio.
 *
 * Diseño de precisión:
 *   - Frases incluidas: las que la persona típicamente usa al expresar
 *     ideación, plan o autolesión. Pueden generar falsos positivos
 *     (ej. "no veo salida con este trabajo") — aceptable por la regla
 *     "si hay duda razonable, gana el filtro de crisis".
 *   - Frases NO incluidas: "me rindo", "lo dejo", "ya no quiero" sueltas,
 *     porque son evitación/abandono cotidiano. Si se concatenan con
 *     "seguir/vivir" (ej. "ya no quiero seguir"), el substring
 *     "no quiero seguir" sí dispara crisis.
 */
const DEFAULT_KEYWORDS: ReadonlyArray<string> = [
  // Ideación suicida directa
  'no quiero seguir',
  'no quiero vivir',
  'no quiero estar',
  'no quiero existir',
  'para que seguir',
  'no veo salida',
  'no tengo salida',
  'no hay salida',
  'mejor desaparecer',
  'mejor no estar',
  'mejor estar muerto',
  'quiero desaparecer',
  'quiero morir',
  'quiero morirme',
  'me quiero morir',
  'ojala no despertar',
  'acabar con todo',
  'acabar con mi vida',
  'quitarme la vida',
  'suicidarme',
  'suicidio',
  'matarme',
  'me quiero matar',
  'me voy a matar',
  // Desborde grave (regla "si hay duda, gana A5")
  'no puedo mas',
  // Autolesión
  'me quiero hacer daño',
  'quiero hacerme daño',
  'hacerme daño',
  'me hice daño',
  'me he hecho daño',
  'me corte',
  'me he cortado',
  'cortarme',
  'lastimarme',
  'quemarme',
  // Daño a otros
  'quiero hacer daño a alguien',
  'quiero hacerle daño',
  'voy a hacer daño',
  'matarlo',
  'matarla',
  'matarlos',
  // Trauma activo / disociación
  'estoy fuera de mi',
  'no siento mi cuerpo',
  'no me siento real',
  'esto no es real',
  'flashback',
  // Abuso activo
  'me esta pegando',
  'abusando de mi',
  'abuso sexual',
  // Consumo en crisis
  'sobredosis',
  'tome de mas',
  // Comando directo (cualquier dominio puede recibirlo)
  '/crisis',
];

export interface CrisisDetectorOptions {
  /** Sobrescribe la lista de keywords (solo para tests). */
  keywords?: ReadonlyArray<string>;
}

export class CrisisDetector {
  private readonly keywords: ReadonlyArray<string>;

  constructor(options: CrisisDetectorOptions = {}) {
    const list = options.keywords ?? DEFAULT_KEYWORDS;
    // Pre-normalizamos por defensa, aunque ya estén en el formato esperado.
    this.keywords = list.map((kw) => normalizeForMatching(kw));
  }

  /**
   * Devuelve true si el texto contiene cualquiera de las palabras clave
   * después de normalizar (lowercase + sin acentos + trim).
   */
  isCrisis(text: string): boolean {
    if (!text || typeof text !== 'string') return false;
    const norm = normalizeForMatching(text);
    if (!norm) return false;
    return this.keywords.some((kw) => kw.length > 0 && norm.includes(kw));
  }

  /** Para tests: devuelve la cantidad de keywords activas. */
  get keywordCount(): number {
    return this.keywords.length;
  }
}
