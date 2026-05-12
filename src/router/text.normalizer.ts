/**
 * Text Normalizer — prepares raw user input for rule matching.
 *
 * Applied BEFORE regex rules to ensure natural Spanish input matches reliably.
 * This avoids LLM calls for simple variations like accents, punctuation, and case.
 */

/**
 * Accent map for common Spanish characters.
 * Only strips accents that are safe for rule matching —
 * we keep ñ since it's a distinct letter in Spanish.
 */
const ACCENT_MAP: Record<string, string> = {
  'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u',
  'ü': 'u',
  'Á': 'A', 'É': 'E', 'Í': 'I', 'Ó': 'O', 'Ú': 'U',
  'Ü': 'U',
};

/**
 * Normalize text for rule matching:
 * 1. trim whitespace
 * 2. lowercase
 * 3. remove trailing punctuation (? ! . , ; :)
 * 4. collapse multiple spaces
 * 5. strip common accents (á→a, é→e, etc.)
 */
export function normalizeText(raw: string): string {
  let text = raw.trim().toLowerCase();

  // Remove trailing punctuation marks
  text = text.replace(/[?!.,;:¿¡]+$/g, '');

  // Remove leading inverted punctuation (¿ ¡)
  text = text.replace(/^[¿¡]+/g, '');

  // Collapse multiple spaces into one
  text = text.replace(/\s+/g, ' ');

  // Trim again after punctuation removal
  text = text.trim();

  return text;
}

/**
 * Strip accents from text for fuzzy matching.
 * Preserves ñ/Ñ since it's a distinct letter.
 */
export function stripAccents(text: string): string {
  return text.replace(/[áéíóúüÁÉÍÓÚÜ]/g, (char) => ACCENT_MAP[char] ?? char);
}

/**
 * Full normalization pipeline: normalize + strip accents.
 * Used when rules need maximum tolerance for user input variations.
 */
export function normalizeForMatching(raw: string): string {
  return stripAccents(normalizeText(raw));
}
