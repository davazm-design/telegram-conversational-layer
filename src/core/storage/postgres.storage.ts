import { Pool } from 'pg';
import { PendingInput } from '../../router/intent.router';
import { IAdhdCoachStore, ISessionStore, IStorageProvider, ITodoStore, ListSnapshot } from './interfaces';
import { logger } from '../logger';

const COMPONENT = 'PostgresStorage';

class PostgresSessionStore implements ISessionStore {
  constructor(private pool: Pool, private domainId: string) {}

  async getPendingInput(userId: string): Promise<PendingInput | null> {
    // S0.5: TTL de 1h vía updated_at. Una fila vencida se trata como
    // inexistente; se limpia perezosamente abajo para no dejar basura.
    const res = await this.pool.query(
      `SELECT data FROM sessions
       WHERE domain_id = $1 AND user_id = $2 AND type = $3
         AND updated_at > NOW() - INTERVAL '1 hour'`,
      [this.domainId, userId, 'pending_input'],
    );
    if (res.rows.length > 0) return res.rows[0].data as PendingInput;
    // Limpieza perezosa de la fila vencida (si existía).
    await this.pool.query(
      `DELETE FROM sessions
       WHERE domain_id = $1 AND user_id = $2 AND type = $3
         AND updated_at <= NOW() - INTERVAL '1 hour'`,
      [this.domainId, userId, 'pending_input'],
    );
    return null;
  }
  async setPendingInput(userId: string, data: PendingInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (domain_id, user_id, type, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain_id, user_id, type) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [this.domainId, userId, 'pending_input', JSON.stringify(data)]
    );
  }
  async clearPendingInput(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE domain_id = $1 AND user_id = $2 AND type = $3', [this.domainId, userId, 'pending_input']);
  }

  async getPendingAction(userId: string): Promise<string | null> {
    // S0.5: TTL de 5min vía updated_at. Una confirmación destructiva debe
    // ser fresca; si venció, el usuario reconfirma.
    const res = await this.pool.query(
      `SELECT data FROM sessions
       WHERE domain_id = $1 AND user_id = $2 AND type = $3
         AND updated_at > NOW() - INTERVAL '5 minutes'`,
      [this.domainId, userId, 'pending_action'],
    );
    if (res.rows.length > 0) return res.rows[0].data.action as string;
    // Limpieza perezosa de la fila vencida (si existía).
    await this.pool.query(
      `DELETE FROM sessions
       WHERE domain_id = $1 AND user_id = $2 AND type = $3
         AND updated_at <= NOW() - INTERVAL '5 minutes'`,
      [this.domainId, userId, 'pending_action'],
    );
    return null;
  }
  async setPendingAction(userId: string, action: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (domain_id, user_id, type, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain_id, user_id, type) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [this.domainId, userId, 'pending_action', JSON.stringify({ action })]
    );
  }
  async clearPendingAction(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE domain_id = $1 AND user_id = $2 AND type = $3', [this.domainId, userId, 'pending_action']);
  }

  // ── S0.1: snapshot de la última lista mostrada ───────────────────────────
  async setLastList(userId: string, snapshot: ListSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (domain_id, user_id, type, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain_id, user_id, type) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [this.domainId, userId, 'last_list', JSON.stringify(snapshot)]
    );
  }
  async getLastList(userId: string): Promise<ListSnapshot | null> {
    const res = await this.pool.query(
      'SELECT data FROM sessions WHERE domain_id = $1 AND user_id = $2 AND type = $3',
      [this.domainId, userId, 'last_list']
    );
    if (res.rows.length === 0) return null;
    const d = res.rows[0].data;
    if (!d || typeof d.kind !== 'string' || !Array.isArray(d.items)) return null;
    return {
      kind: String(d.kind),
      shownAt: String(d.shownAt ?? ''),
      items: d.items.map((i: { position: number; refId: string; text: string }) => ({
        position: Number(i.position),
        refId: String(i.refId),
        text: String(i.text ?? ''),
      })),
    };
  }
  async clearLastList(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE domain_id = $1 AND user_id = $2 AND type = $3', [this.domainId, userId, 'last_list']);
  }
}

class PostgresTodoStore implements ITodoStore {
  constructor(private pool: Pool, private domainId: string) {}

  async getTasks(userId: string) {
    const res = await this.pool.query('SELECT text, completed FROM todo_items WHERE domain_id = $1 AND user_id = $2 AND type = $3 ORDER BY created_at ASC', [this.domainId, userId, 'task']);
    return res.rows;
  }
  async addTask(userId: string, text: string) {
    await this.pool.query('INSERT INTO todo_items (domain_id, user_id, type, text, completed) VALUES ($1, $2, $3, $4, false)', [this.domainId, userId, 'task', text]);
  }
  async clearTasks(userId: string) {
    await this.pool.query('DELETE FROM todo_items WHERE domain_id = $1 AND user_id = $2 AND type = $3', [this.domainId, userId, 'task']);
  }

  async getReminders(userId: string) {
    const res = await this.pool.query('SELECT text, completed FROM todo_items WHERE domain_id = $1 AND user_id = $2 AND type = $3 ORDER BY created_at ASC', [this.domainId, userId, 'reminder']);
    return res.rows;
  }
  async addReminder(userId: string, text: string) {
    await this.pool.query('INSERT INTO todo_items (domain_id, user_id, type, text, completed) VALUES ($1, $2, $3, $4, false)', [this.domainId, userId, 'reminder', text]);
  }
  async clearReminders(userId: string) {
    await this.pool.query('DELETE FROM todo_items WHERE domain_id = $1 AND user_id = $2 AND type = $3', [this.domainId, userId, 'reminder']);
  }
}

class PostgresAdhdCoachStore implements IAdhdCoachStore {
  constructor(private pool: Pool, private domainId: string) {}

  async getCheckins(userId: string) {
    const res = await this.pool.query('SELECT date, completed FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = $3 ORDER BY created_at ASC', [this.domainId, userId, 'checkin']);
    return res.rows;
  }
  async addCheckin(userId: string, date: string) {
    await this.pool.query('INSERT INTO adhd_items (domain_id, user_id, type, date, completed) VALUES ($1, $2, $3, $4, true)', [this.domainId, userId, 'checkin', date]);
  }

  async getMicroTasks(userId: string) {
    // El campo `date` se recicla para guardar la prioridad Eisenhower
    // ('now'|'plan'|'quick'|'later'|null). Cero schema change.
    // S0.1: `id` es el SERIAL de la fila — ESTABLE, no la posición.
    const res = await this.pool.query('SELECT id, text, completed, date FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = $3 ORDER BY created_at ASC', [this.domainId, userId, 'microtask']);
    return res.rows.map((r) => ({
      id: String(r.id),
      text: r.text,
      completed: r.completed,
      priority: r.date ?? null,
    }));
  }
  async addMicroTask(userId: string, text: string) {
    await this.pool.query('INSERT INTO adhd_items (domain_id, user_id, type, text, completed) VALUES ($1, $2, $3, $4, false)', [this.domainId, userId, 'microtask', text]);
  }
  async completeMicroTask(userId: string, taskId: string) {
    // taskId es el id estable (= SERIAL). Update directo, sin round-trip extra.
    const res = await this.pool.query(
      `UPDATE adhd_items SET completed = true
       WHERE id = $1 AND domain_id = $2 AND user_id = $3 AND type = 'microtask'`,
      [taskId, this.domainId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteMicroTaskById(userId: string, id: string): Promise<string | null> {
    const res = await this.pool.query(
      `DELETE FROM adhd_items
       WHERE id = $1 AND domain_id = $2 AND user_id = $3 AND type = 'microtask'
       RETURNING text`,
      [id, this.domainId, userId],
    );
    return res.rows[0]?.text ?? null;
  }

  async editMicroTaskById(userId: string, id: string, newText: string): Promise<string | null> {
    // SELECT del texto anterior + UPDATE. El handler usa el anterior para el
    // mensaje "Cambiada: viejo → nuevo".
    const prev = await this.pool.query(
      `SELECT text FROM adhd_items
       WHERE id = $1 AND domain_id = $2 AND user_id = $3 AND type = 'microtask'`,
      [id, this.domainId, userId],
    );
    if (prev.rows.length === 0) return null;
    const oldText = prev.rows[0].text as string;
    await this.pool.query(
      `UPDATE adhd_items SET text = $1
       WHERE id = $2 AND domain_id = $3 AND user_id = $4 AND type = 'microtask'`,
      [newText, id, this.domainId, userId],
    );
    return oldText;
  }

  async setMicroTaskPriorityById(userId: string, id: string, priority: string | null): Promise<string | null> {
    const res = await this.pool.query(
      `UPDATE adhd_items SET date = $1
       WHERE id = $2 AND domain_id = $3 AND user_id = $4 AND type = 'microtask'
       RETURNING text`,
      [priority, id, this.domainId, userId],
    );
    return res.rows[0]?.text ?? null;
  }

  async getFocusSessions(userId: string) {
    const res = await this.pool.query('SELECT text as task, completed FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = $3 ORDER BY created_at ASC', [this.domainId, userId, 'focus']);
    return res.rows;
  }
  async addFocusSession(userId: string, task: string) {
    await this.pool.query('INSERT INTO adhd_items (domain_id, user_id, type, text, completed) VALUES ($1, $2, $3, $4, true)', [this.domainId, userId, 'focus', task]);
  }

  async resetDay(userId: string) {
    // Mantiene el comportamiento previo: clear de checkins/microtasks/focus
    // del usuario. NO toca silence_until (ese se borra solo con resetAllUserState).
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type IN ('checkin','microtask','focus')`,
      [this.domainId, userId]
    );
  }

  async getSilenceUntil(userId: string): Promise<string | null> {
    const res = await this.pool.query(
      `SELECT date FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'silence_until' ORDER BY created_at DESC LIMIT 1`,
      [this.domainId, userId]
    );
    return res.rows[0]?.date ?? null;
  }
  async setSilenceUntil(userId: string, isoUntil: string): Promise<void> {
    // Reemplazo idempotente: borra previo + inserta nuevo en una transacción ligera.
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'silence_until'`,
      [this.domainId, userId]
    );
    await this.pool.query(
      `INSERT INTO adhd_items (domain_id, user_id, type, date, completed) VALUES ($1, $2, 'silence_until', $3, true)`,
      [this.domainId, userId, isoUntil]
    );
  }
  async clearSilenceUntil(userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'silence_until'`,
      [this.domainId, userId]
    );
  }

  async resetAllUserState(userId: string): Promise<void> {
    // Borra TODO lo que el dominio guarda para el usuario.
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2`,
      [this.domainId, userId]
    );
  }

  // ── Fase 3: reminders ────────────────────────────────────────────────

  async addReminder(userId: string, text: string, dueAtIso: string): Promise<{ id: string }> {
    const res = await this.pool.query(
      `INSERT INTO adhd_items (domain_id, user_id, type, text, date, completed)
       VALUES ($1, $2, 'reminder', $3, $4, false) RETURNING id`,
      [this.domainId, userId, text, dueAtIso]
    );
    return { id: String(res.rows[0].id) };
  }

  async listReminders(userId: string) {
    const res = await this.pool.query(
      `SELECT id, text, date FROM adhd_items
       WHERE domain_id = $1 AND user_id = $2 AND type = 'reminder' AND completed = false
       ORDER BY date ASC`,
      [this.domainId, userId]
    );
    return res.rows.map((r) => ({ id: String(r.id), text: r.text, dueAt: r.date }));
  }

  async cancelReminderByIndex(userId: string, index1Based: number): Promise<string | null> {
    const pending = await this.listReminders(userId);
    if (index1Based < 1 || index1Based > pending.length) return null;
    return this.cancelReminderById(userId, pending[index1Based - 1].id);
  }

  async cancelReminderById(userId: string, reminderId: string): Promise<string | null> {
    const res = await this.pool.query(
      `UPDATE adhd_items SET completed = true
       WHERE id = $1 AND domain_id = $2 AND user_id = $3
         AND type = 'reminder' AND completed = false
       RETURNING text`,
      [reminderId, this.domainId, userId],
    );
    return res.rows[0]?.text ?? null;
  }

  async getDueRemindersAllUsers(nowIso: string) {
    const res = await this.pool.query(
      `SELECT id, user_id, text, date FROM adhd_items
       WHERE domain_id = $1 AND type = 'reminder' AND completed = false AND date <= $2
       ORDER BY date ASC`,
      [this.domainId, nowIso]
    );
    return res.rows.map((r) => ({
      id: String(r.id), userId: r.user_id, text: r.text, dueAt: r.date,
    }));
  }

  async markReminderDone(reminderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE adhd_items SET completed = true WHERE id = $1 AND domain_id = $2`,
      [reminderId, this.domainId]
    );
  }

  async postponeReminder(reminderId: string, newDueAtIso: string): Promise<void> {
    await this.pool.query(
      `UPDATE adhd_items SET date = $1 WHERE id = $2 AND domain_id = $3`,
      [newDueAtIso, reminderId, this.domainId]
    );
  }

  // Drafts: type='reminder_draft', text=texto, date=dayHint. Único por usuario:
  // borrar-antes-insertar para idempotencia.
  async setPendingReminderDraft(
    userId: string,
    draft: { text: string; dayHint: string },
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'reminder_draft'`,
      [this.domainId, userId]
    );
    await this.pool.query(
      `INSERT INTO adhd_items (domain_id, user_id, type, text, date, completed)
       VALUES ($1, $2, 'reminder_draft', $3, $4, false)`,
      [this.domainId, userId, draft.text, draft.dayHint]
    );
  }
  async getPendingReminderDraft(userId: string) {
    const res = await this.pool.query(
      `SELECT text, date FROM adhd_items
       WHERE domain_id = $1 AND user_id = $2 AND type = 'reminder_draft'
       ORDER BY created_at DESC LIMIT 1`,
      [this.domainId, userId]
    );
    if (res.rows.length === 0) return null;
    return { text: res.rows[0].text, dayHint: String(res.rows[0].date) };
  }
  async clearPendingReminderDraft(userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'reminder_draft'`,
      [this.domainId, userId]
    );
  }

  // Overdue summary: type='reminder_overdue_summary', text=JSON(reminderIds).
  async setPendingOverdueSummary(userId: string, reminderIds: string[]): Promise<void> {
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'reminder_overdue_summary'`,
      [this.domainId, userId]
    );
    await this.pool.query(
      `INSERT INTO adhd_items (domain_id, user_id, type, text, completed)
       VALUES ($1, $2, 'reminder_overdue_summary', $3, false)`,
      [this.domainId, userId, JSON.stringify(reminderIds)]
    );
  }
  async getPendingOverdueSummary(userId: string) {
    const res = await this.pool.query(
      `SELECT text FROM adhd_items
       WHERE domain_id = $1 AND user_id = $2 AND type = 'reminder_overdue_summary'
       ORDER BY created_at DESC LIMIT 1`,
      [this.domainId, userId]
    );
    if (res.rows.length === 0) return null;
    try { return { reminderIds: JSON.parse(res.rows[0].text) as string[] }; }
    catch { return null; }
  }
  async clearPendingOverdueSummary(userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'reminder_overdue_summary'`,
      [this.domainId, userId]
    );
  }

  // ── Selección de agenda pendiente ───────────────────────────────────────
  // type='agenda_selection', text=JSON.stringify(items[]). Único por usuario.
  async setPendingAgendaSelection(
    userId: string,
    items: Array<{ text: string; category: string }>,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'agenda_selection'`,
      [this.domainId, userId]
    );
    await this.pool.query(
      `INSERT INTO adhd_items (domain_id, user_id, type, text, completed)
       VALUES ($1, $2, 'agenda_selection', $3, false)`,
      [this.domainId, userId, JSON.stringify(items)]
    );
  }
  async getPendingAgendaSelection(userId: string) {
    const res = await this.pool.query(
      `SELECT text FROM adhd_items
       WHERE domain_id = $1 AND user_id = $2 AND type = 'agenda_selection'
       ORDER BY created_at DESC LIMIT 1`,
      [this.domainId, userId]
    );
    if (res.rows.length === 0) return null;
    try {
      const parsed = JSON.parse(res.rows[0].text);
      if (!Array.isArray(parsed)) return null;
      return parsed.map((p: { text: string; category: string }) => ({
        text: String(p.text ?? ''),
        category: String(p.category ?? 'otros'),
      }));
    } catch {
      return null;
    }
  }
  async clearPendingAgendaSelection(userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'agenda_selection'`,
      [this.domainId, userId]
    );
  }

  // ── Fase 4: flujos multi-paso (TCC, procrastinación, espiritualidad) ───
  async setPendingFlowDraft(
    userId: string,
    draft: { flow: string; step: number; answers: string[]; metadata?: Record<string, string> },
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'pending_flow_draft'`,
      [this.domainId, userId]
    );
    await this.pool.query(
      `INSERT INTO adhd_items (domain_id, user_id, type, text, completed)
       VALUES ($1, $2, 'pending_flow_draft', $3, false)`,
      [this.domainId, userId, JSON.stringify(draft)]
    );
  }
  async getPendingFlowDraft(userId: string) {
    const res = await this.pool.query(
      `SELECT text FROM adhd_items
       WHERE domain_id = $1 AND user_id = $2 AND type = 'pending_flow_draft'
       ORDER BY created_at DESC LIMIT 1`,
      [this.domainId, userId]
    );
    if (res.rows.length === 0) return null;
    try {
      const parsed = JSON.parse(res.rows[0].text);
      if (!parsed || typeof parsed.flow !== 'string') return null;
      return {
        flow: String(parsed.flow),
        step: Number(parsed.step ?? 1),
        answers: Array.isArray(parsed.answers) ? parsed.answers.map(String) : [],
        metadata: parsed.metadata ?? undefined,
      };
    } catch {
      return null;
    }
  }
  async clearPendingFlowDraft(userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = 'pending_flow_draft'`,
      [this.domainId, userId]
    );
  }

  // ── Fase 4: journal (registros TCC, neuro, procrastinación, espiritual) ──
  async addJournalEntry(userId: string, type: string, summary: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO adhd_items (domain_id, user_id, type, text, completed)
       VALUES ($1, $2, $3, $4, false)`,
      [this.domainId, userId, type, summary]
    );
  }
  async countJournalEntries(userId: string, types: string[]): Promise<number> {
    if (!types || types.length === 0) return 0;
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM adhd_items
       WHERE domain_id = $1 AND user_id = $2 AND type = ANY($3::text[])`,
      [this.domainId, userId, types]
    );
    return Number(res.rows[0]?.n ?? 0);
  }
}

export class PostgresStorageProvider implements IStorageProvider {
  private pool: Pool;
  sessionStore!: ISessionStore;
  todoStore!: ITodoStore;
  adhdCoachStore!: IAdhdCoachStore;

  constructor(connectionString: string) {
    // SSL: en Railway/Render hace falta `rejectUnauthorized: false` (cert
    // self-signed del proveedor). En CI y en local con un Postgres sin SSL,
    // forzarlo rompe la conexión. S0.2: si la URL trae `sslmode=disable` o
    // el env `PG_SSL=false`, no usamos SSL. Resto de casos, comportamiento
    // previo intacto. La debt 🟠 del audit (rejectUnauthorized: false
    // global) sigue pendiente — esto es solo el primer paso.
    const noSsl =
      /[?&]sslmode=disable\b/i.test(connectionString) ||
      process.env.PG_SSL === 'false';
    this.pool = new Pool({
      connectionString,
      ssl: noSsl ? false : { rejectUnauthorized: false },
    });
  }

  async connect(domainId: string): Promise<void> {
    try {
      this.sessionStore = new PostgresSessionStore(this.pool, domainId);
      this.todoStore = new PostgresTodoStore(this.pool, domainId);
      this.adhdCoachStore = new PostgresAdhdCoachStore(this.pool, domainId);

      await this.initSchema();
      logger.info(COMPONENT, `Postgres connected and schema initialized for domain: ${domainId}`);
    } catch (error) {
      logger.error(COMPONENT, 'Failed to connect to Postgres', { error: String(error) });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  private async initSchema() {
    const query = `
      CREATE TABLE IF NOT EXISTS sessions (
        domain_id VARCHAR(50) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (domain_id, user_id, type)
      );

      CREATE TABLE IF NOT EXISTS todo_items (
        id SERIAL PRIMARY KEY,
        domain_id VARCHAR(50) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        text TEXT NOT NULL,
        completed BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS adhd_items (
        id SERIAL PRIMARY KEY,
        domain_id VARCHAR(50) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        text TEXT,
        date TEXT,
        completed BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- S0.4: índices secundarios. Sin esto, cada query es full scan y el
      -- tick proactivo (getDueRemindersAllUsers, cada 60s) degrada conforme
      -- se acumulan items. IF NOT EXISTS → idempotente, seguro re-ejecutar.
      CREATE INDEX IF NOT EXISTS idx_todo_items_lookup
        ON todo_items (domain_id, user_id, type);
      CREATE INDEX IF NOT EXISTS idx_adhd_items_lookup
        ON adhd_items (domain_id, user_id, type);
      -- Índice parcial: exacto para el tick — solo recordatorios pendientes.
      CREATE INDEX IF NOT EXISTS idx_adhd_reminders_due
        ON adhd_items (domain_id, date)
        WHERE type = 'reminder' AND completed = false;
    `;
    await this.pool.query(query);
  }
}
