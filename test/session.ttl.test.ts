/**
 * S0.5 — Tests del TTL de pendings (en MemoryStorage).
 *
 * Los del path Postgres viven en test/postgres.storage.test.ts y solo
 * corren en CI (o cuando hay DATABASE_URL). Aquí cubrimos el contrato
 * en memoria: el comportamiento DEBE ser equivalente.
 */

import { MemoryStorageProvider } from '../src/core/storage/memory.storage';
import { PENDING_INPUT_TTL_MS, PENDING_ACTION_TTL_MS } from '../src/core/storage/ttl';

describe('Session pendings — TTL (S0.5)', () => {
  let provider: MemoryStorageProvider;
  const user = 'u';

  beforeEach(async () => {
    provider = new MemoryStorageProvider();
    await provider.connect('d');
  });

  afterEach(async () => {
    await provider.disconnect();
    jest.useRealTimers();
  });

  test('pending_action recién seteado se devuelve', async () => {
    await provider.sessionStore.setPendingAction(user, 'reset_day');
    expect(await provider.sessionStore.getPendingAction(user)).toBe('reset_day');
  });

  test('pending_action expira tras PENDING_ACTION_TTL_MS', async () => {
    jest.useFakeTimers({ now: new Date('2026-05-13T12:00:00Z') });
    await provider.sessionStore.setPendingAction(user, 'reset_day');
    // Justo antes del TTL: sigue ahí.
    jest.setSystemTime(new Date(Date.now() + PENDING_ACTION_TTL_MS - 1));
    expect(await provider.sessionStore.getPendingAction(user)).toBe('reset_day');
    // Pasado el TTL: null.
    jest.setSystemTime(new Date(Date.now() + 2));
    expect(await provider.sessionStore.getPendingAction(user)).toBeNull();
  });

  test('pending_input expira tras PENDING_INPUT_TTL_MS', async () => {
    jest.useFakeTimers({ now: new Date('2026-05-13T12:00:00Z') });
    const input = { action: 'create_task', paramName: 'text', prompt: '?' };
    await provider.sessionStore.setPendingInput(user, input);
    jest.setSystemTime(new Date(Date.now() + PENDING_INPUT_TTL_MS - 1));
    expect(await provider.sessionStore.getPendingInput(user)).toEqual(input);
    jest.setSystemTime(new Date(Date.now() + 2));
    expect(await provider.sessionStore.getPendingInput(user)).toBeNull();
  });

  test('set sobreescribe expiresAt (nueva ventana completa)', async () => {
    jest.useFakeTimers({ now: new Date('2026-05-13T12:00:00Z') });
    await provider.sessionStore.setPendingAction(user, 'old');
    // Avanzamos casi hasta el final del primer TTL.
    jest.setSystemTime(new Date(Date.now() + PENDING_ACTION_TTL_MS - 1000));
    // Re-set: la ventana se reinicia.
    await provider.sessionStore.setPendingAction(user, 'new');
    // Avanzamos otro casi-TTL: si la ventana se reinició, sigue vivo.
    jest.setSystemTime(new Date(Date.now() + PENDING_ACTION_TTL_MS - 1000));
    expect(await provider.sessionStore.getPendingAction(user)).toBe('new');
  });
});
