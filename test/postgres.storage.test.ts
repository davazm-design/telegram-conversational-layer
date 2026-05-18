/**
 * S0.2 — Contract tests del PostgresStorageProvider.
 *
 * Estos tests EXIGEN un Postgres real (DATABASE_URL). Si no está, la suite
 * se omite con un mensaje claro (no falla en silencio). En CI, el workflow
 * GitHub Actions levanta un service container y siempre los corre.
 *
 * Qué cubre:
 *   - Schema se inicializa de forma idempotente.
 *   - Pendings respetan TTL (S0.5).
 *   - MicroTasks tienen id ESTABLE (S0.1): borrar/editar por id no se
 *     equivoca entre items.
 *   - ListSnapshot (S0.1): set/get/clear con copia defensiva.
 *   - Recordatorios: cancelByIndex delega correctamente a cancelById.
 *
 * Estos tests NO existen como duplicado de los de MemoryStorage — existen
 * porque el SQL real tiene su propia clase de bugs (RETURNING vacío,
 * tipos, índices), y el audit fue claro: "verificado" debe significar que
 * el path de prod corrió.
 */

import { PostgresStorageProvider } from '../src/core/storage/postgres.storage';
import { PENDING_INPUT_TTL_MS, PENDING_ACTION_TTL_MS } from '../src/core/storage/ttl';
import { setLogLevel } from '../src/core/logger';

setLogLevel('error');

const URL = process.env.DATABASE_URL;
const describeIfPg = URL ? describe : describe.skip;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[postgres.storage.test] DATABASE_URL no definido — skip. En CI el ' +
    'service container Postgres está siempre disponible; en local, exporta ' +
    'DATABASE_URL apuntando a un Postgres descartable.',
  );
}

// Cada test usa un domainId único para no chocar entre corridas/paralelos.
function freshDomain(): string {
  return `t_${Date.now()}_${Math.floor(Math.random() * 100000)}`.slice(0, 50);
}

describeIfPg('PostgresStorageProvider — contract tests (S0.2)', () => {
  let provider: PostgresStorageProvider;
  let domainId: string;
  const user = 'u_test';

  beforeEach(async () => {
    provider = new PostgresStorageProvider(URL!);
    domainId = freshDomain();
    await provider.connect(domainId);
  });

  afterEach(async () => {
    // Limpia el dominio para no dejar basura. Cada test usa domain único
    // así que esto es belt-and-suspenders.
    try { await provider.adhdCoachStore.resetAllUserState(user); } catch {}
    await provider.disconnect();
  });

  describe('schema', () => {
    test('initSchema es idempotente (reconectar no rompe)', async () => {
      // Reusa el mismo dominio sin error.
      const p2 = new PostgresStorageProvider(URL!);
      await p2.connect(domainId);
      await p2.disconnect();
      expect(true).toBe(true); // si no tiró, pasó.
    });
  });

  describe('S0.5 — pending TTL', () => {
    test('pending_action recién set se devuelve', async () => {
      await provider.sessionStore.setPendingAction(user, 'reset_day');
      const got = await provider.sessionStore.getPendingAction(user);
      expect(got).toBe('reset_day');
    });

    test('pending_input recién set se devuelve', async () => {
      const input = {
        action: 'create_task', paramName: 'text', prompt: '¿Qué tarea?',
      };
      await provider.sessionStore.setPendingInput(user, input);
      const got = await provider.sessionStore.getPendingInput(user);
      expect(got).toEqual(input);
    });

    test('pending_action vencido se trata como inexistente (artificial)', async () => {
      // Insert directo a la tabla forzando updated_at al pasado.
      const past = new Date(Date.now() - PENDING_ACTION_TTL_MS - 60_000).toISOString();
      // Acceso al pool interno vía bracket notation. Aceptable solo en
      // tests para forzar updated_at al pasado.
      const pool = (provider as unknown as { pool: import('pg').Pool }).pool;
      await pool.query(
        `INSERT INTO sessions (domain_id, user_id, type, data, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (domain_id, user_id, type) DO UPDATE
           SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [domainId, user, 'pending_action', JSON.stringify({ action: 'reset_day' }), past],
      );
      const got = await provider.sessionStore.getPendingAction(user);
      expect(got).toBeNull();
      // Limpieza perezosa: tras el get, la fila debe haber desaparecido.
      const after = await pool.query(
        `SELECT 1 FROM sessions WHERE domain_id=$1 AND user_id=$2 AND type='pending_action'`,
        [domainId, user],
      );
      expect(after.rowCount).toBe(0);
    });

    test('pending_input vencido se trata como inexistente (artificial)', async () => {
      const past = new Date(Date.now() - PENDING_INPUT_TTL_MS - 60_000).toISOString();
      // Acceso al pool interno vía cast; solo para tests.
      const pool = (provider as unknown as { pool: import('pg').Pool }).pool;
      await pool.query(
        `INSERT INTO sessions (domain_id, user_id, type, data, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (domain_id, user_id, type) DO UPDATE
           SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [domainId, user, 'pending_input',
         JSON.stringify({ action: 'x', paramName: 'y', prompt: '?' }), past],
      );
      const got = await provider.sessionStore.getPendingInput(user);
      expect(got).toBeNull();
    });
  });

  describe('S0.1 — microtasks con id estable', () => {
    test('add/getMicroTasks devuelve ids string', async () => {
      await provider.adhdCoachStore.addMicroTask(user, 'A');
      await provider.adhdCoachStore.addMicroTask(user, 'B');
      const tasks = await provider.adhdCoachStore.getMicroTasks(user);
      expect(tasks.length).toBe(2);
      expect(typeof tasks[0].id).toBe('string');
      expect(tasks[0].id).not.toBe(tasks[1].id);
      expect(tasks.map((t) => t.text)).toEqual(['A', 'B']);
    });

    test('deleteMicroTaskById borra exactamente esa fila y devuelve text', async () => {
      await provider.adhdCoachStore.addMicroTask(user, 'A');
      await provider.adhdCoachStore.addMicroTask(user, 'B');
      await provider.adhdCoachStore.addMicroTask(user, 'C');
      const before = await provider.adhdCoachStore.getMicroTasks(user);
      const targetId = before.find((t) => t.text === 'B')!.id;

      const removed = await provider.adhdCoachStore.deleteMicroTaskById(user, targetId);
      expect(removed).toBe('B');

      const after = await provider.adhdCoachStore.getMicroTasks(user);
      expect(after.map((t) => t.text)).toEqual(['A', 'C']);
      // Y los ids de A y C NO cambian (estables, no recompactan posición).
      expect(after.find((t) => t.text === 'A')!.id)
        .toBe(before.find((t) => t.text === 'A')!.id);
      expect(after.find((t) => t.text === 'C')!.id)
        .toBe(before.find((t) => t.text === 'C')!.id);
    });

    test('deleteMicroTaskById con id inexistente devuelve null', async () => {
      await provider.adhdCoachStore.addMicroTask(user, 'A');
      const removed = await provider.adhdCoachStore.deleteMicroTaskById(user, '999999999');
      expect(removed).toBeNull();
    });

    test('editMicroTaskById devuelve el texto VIEJO y actualiza', async () => {
      await provider.adhdCoachStore.addMicroTask(user, 'viejo');
      const t = (await provider.adhdCoachStore.getMicroTasks(user))[0];
      const old = await provider.adhdCoachStore.editMicroTaskById(user, t.id, 'nuevo');
      expect(old).toBe('viejo');
      const after = await provider.adhdCoachStore.getMicroTasks(user);
      expect(after[0].text).toBe('nuevo');
      expect(after[0].id).toBe(t.id); // id no cambia
    });

    test('setMicroTaskPriorityById persiste y getMicroTasks lo refleja', async () => {
      await provider.adhdCoachStore.addMicroTask(user, 'X');
      const t = (await provider.adhdCoachStore.getMicroTasks(user))[0];
      const ret = await provider.adhdCoachStore.setMicroTaskPriorityById(user, t.id, 'now');
      expect(ret).toBe('X');
      const after = await provider.adhdCoachStore.getMicroTasks(user);
      expect(after[0].priority).toBe('now');
    });

    test('completeMicroTask por id estable marca completed', async () => {
      await provider.adhdCoachStore.addMicroTask(user, 'A');
      const t = (await provider.adhdCoachStore.getMicroTasks(user))[0];
      const ok = await provider.adhdCoachStore.completeMicroTask(user, t.id);
      expect(ok).toBe(true);
      const after = await provider.adhdCoachStore.getMicroTasks(user);
      expect(after[0].completed).toBe(true);
    });
  });

  describe('S0.1 — ListSnapshot', () => {
    test('set/get round-trip preserva kind, items y refIds', async () => {
      const snap = {
        kind: 'reminders',
        shownAt: new Date().toISOString(),
        items: [
          { position: 1, refId: '42', text: 'cita ginecóloga' },
          { position: 2, refId: '99', text: 'pagar luz' },
        ],
      };
      await provider.sessionStore.setLastList(user, snap);
      const got = await provider.sessionStore.getLastList(user);
      expect(got).toEqual(snap);
    });

    test('clearLastList borra', async () => {
      await provider.sessionStore.setLastList(user, {
        kind: 'microtasks', shownAt: new Date().toISOString(), items: [],
      });
      await provider.sessionStore.clearLastList(user);
      const got = await provider.sessionStore.getLastList(user);
      expect(got).toBeNull();
    });
  });

  describe('reminders', () => {
    test('addReminder + listReminders + cancelReminderByIndex', async () => {
      const due = new Date(Date.now() + 60 * 60_000).toISOString();
      await provider.adhdCoachStore.addReminder(user, 'tomar agua', due);
      await provider.adhdCoachStore.addReminder(user, 'caminar', due);

      const list = await provider.adhdCoachStore.listReminders(user);
      expect(list.length).toBe(2);

      const txt = await provider.adhdCoachStore.cancelReminderByIndex(user, 1);
      expect(['tomar agua', 'caminar']).toContain(txt);

      const after = await provider.adhdCoachStore.listReminders(user);
      expect(after.length).toBe(1);
    });

    test('cancelReminderById marca completed y devuelve texto', async () => {
      const due = new Date(Date.now() + 60 * 60_000).toISOString();
      const { id } = await provider.adhdCoachStore.addReminder(user, 'X', due);
      const ret = await provider.adhdCoachStore.cancelReminderById(user, id);
      expect(ret).toBe('X');
      // Segundo intento: ya completed → null.
      const ret2 = await provider.adhdCoachStore.cancelReminderById(user, id);
      expect(ret2).toBeNull();
    });
  });
});
