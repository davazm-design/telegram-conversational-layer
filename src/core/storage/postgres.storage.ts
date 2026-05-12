import { Pool } from 'pg';
import { PendingInput } from '../../router/intent.router';
import { IAdhdCoachStore, ISessionStore, IStorageProvider, ITodoStore } from './interfaces';
import { logger } from '../logger';

const COMPONENT = 'PostgresStorage';

class PostgresSessionStore implements ISessionStore {
  constructor(private pool: Pool, private domainId: string) {}

  async getPendingInput(userId: string): Promise<PendingInput | null> {
    const res = await this.pool.query('SELECT data FROM sessions WHERE domain_id = $1 AND user_id = $2 AND type = $3', [this.domainId, userId, 'pending_input']);
    if (res.rows.length > 0) return res.rows[0].data as PendingInput;
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
    const res = await this.pool.query('SELECT data FROM sessions WHERE domain_id = $1 AND user_id = $2 AND type = $3', [this.domainId, userId, 'pending_action']);
    if (res.rows.length > 0) return res.rows[0].data.action as string;
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
    const res = await this.pool.query('SELECT id, text, completed FROM adhd_items WHERE domain_id = $1 AND user_id = $2 AND type = $3 ORDER BY created_at ASC', [this.domainId, userId, 'microtask']);
    return res.rows.map((r, i) => ({ id: String(i + 1), text: r.text, completed: r.completed, dbId: r.id }));
  }
  async addMicroTask(userId: string, text: string) {
    await this.pool.query('INSERT INTO adhd_items (domain_id, user_id, type, text, completed) VALUES ($1, $2, $3, $4, false)', [this.domainId, userId, 'microtask', text]);
  }
  async completeMicroTask(userId: string, taskId: string) {
    const tasks = await this.getMicroTasks(userId);
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return false;
    await this.pool.query('UPDATE adhd_items SET completed = true WHERE id = $1 AND domain_id = $2', [target.dbId, this.domainId]);
    return true;
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
    const target = pending[index1Based - 1];
    await this.pool.query(
      `UPDATE adhd_items SET completed = true WHERE id = $1 AND domain_id = $2`,
      [target.id, this.domainId]
    );
    return target.text;
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
}

export class PostgresStorageProvider implements IStorageProvider {
  private pool: Pool;
  sessionStore!: ISessionStore;
  todoStore!: ITodoStore;
  adhdCoachStore!: IAdhdCoachStore;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false } // Needed for Railway/Render generally
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
    `;
    await this.pool.query(query);
  }
}
