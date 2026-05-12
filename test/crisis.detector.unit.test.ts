/**
 * Unit tests del CrisisDetector — transversales, sin dominio.
 *
 * Verifican el contrato puro del detector: dado un texto, ¿es crisis o no?
 * No dependen del Orchestrator, ni de adapters, ni de dominios.
 */

import { CrisisDetector } from '../src/security/crisis.detector';

describe('CrisisDetector — unit (transversal, sin dominio)', () => {
  const detector = new CrisisDetector();

  test('lista de keywords no vacía', () => {
    expect(detector.keywordCount).toBeGreaterThan(20);
  });

  // ── Positivos: deben disparar crisis ──────────────────────────────────────
  test('"no quiero seguir" → crisis', () => {
    expect(detector.isCrisis('no quiero seguir')).toBe(true);
  });

  test('"no veo salida" → crisis', () => {
    expect(detector.isCrisis('no veo salida')).toBe(true);
  });

  test('"no veo salida con este trabajo" → crisis (substring)', () => {
    expect(detector.isCrisis('no veo salida con este trabajo')).toBe(true);
  });

  test('"quiero morir" → crisis', () => {
    expect(detector.isCrisis('quiero morir')).toBe(true);
  });

  test('"me quiero hacer daño" → crisis (con ñ)', () => {
    expect(detector.isCrisis('me quiero hacer daño')).toBe(true);
  });

  test('"Me Quiero Hacer Daño" → crisis (case + accents)', () => {
    expect(detector.isCrisis('Me Quiero Hacer Daño')).toBe(true);
  });

  test('"mejor desaparecer" → crisis', () => {
    expect(detector.isCrisis('mejor desaparecer')).toBe(true);
  });

  test('"no puedo más" → crisis (regla "duda razonable")', () => {
    expect(detector.isCrisis('no puedo más')).toBe(true);
  });

  test('"estoy fuera de mí" → crisis', () => {
    expect(detector.isCrisis('estoy fuera de mí')).toBe(true);
  });

  test('comando /crisis → crisis (acceso directo)', () => {
    expect(detector.isCrisis('/crisis')).toBe(true);
  });

  // ── Negativos: NO deben disparar crisis ───────────────────────────────────
  test('"me rindo con esta tarea" → NO crisis', () => {
    expect(detector.isCrisis('me rindo con esta tarea')).toBe(false);
  });

  test('"lo dejo" → NO crisis', () => {
    expect(detector.isCrisis('lo dejo')).toBe(false);
  });

  test('"buenos días" → NO crisis', () => {
    expect(detector.isCrisis('buenos días')).toBe(false);
  });

  test('"/focus" → NO crisis', () => {
    expect(detector.isCrisis('/focus')).toBe(false);
  });

  test('texto vacío → NO crisis', () => {
    expect(detector.isCrisis('')).toBe(false);
  });

  test('null/undefined-ish → NO crisis', () => {
    // @ts-expect-error — entrada inválida intencional
    expect(detector.isCrisis(null)).toBe(false);
  });

  // ── Inyección de keywords (futuro: i18n / personalización) ────────────────
  test('detector con keywords vacías nunca dispara', () => {
    const empty = new CrisisDetector({ keywords: [] });
    expect(empty.isCrisis('no quiero seguir')).toBe(false);
    expect(empty.isCrisis('quiero morir')).toBe(false);
  });

  test('detector con keywords personalizadas funciona', () => {
    const custom = new CrisisDetector({ keywords: ['palabra clave xyz'] });
    expect(custom.isCrisis('contiene palabra clave xyz por aqui')).toBe(true);
    expect(custom.isCrisis('no quiero seguir')).toBe(false);
  });
});
