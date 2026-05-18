import { PendingInput } from '../../router/intent.router';

/**
 * Snapshot de la última lista numerada mostrada al usuario. Permite resolver
 * "borra 1" / "cancela 2" contra lo que el usuario REALMENTE vio, no contra la
 * lista actual (que pudo cambiar) ni contra el tipo equivocado. Ver
 * docs/contracts/s0.1-list-snapshot.md.
 *
 * Es genérico/agnóstico de dominio: `kind` es un string libre.
 */
export interface ListSnapshot {
  kind: string; // 'reminders' | 'microtasks' | ... (dominio define el vocabulario)
  shownAt: string; // ISO 8601
  items: Array<{ position: number; refId: string; text: string }>;
}

export interface ISessionStore {
  getPendingInput(userId: string): Promise<PendingInput | null>;
  setPendingInput(userId: string, data: PendingInput): Promise<void>;
  clearPendingInput(userId: string): Promise<void>;

  getPendingAction(userId: string): Promise<string | null>;
  setPendingAction(userId: string, action: string): Promise<void>;
  clearPendingAction(userId: string): Promise<void>;

  // ── S0.1: snapshot de la última lista numerada mostrada ──────────────────
  setLastList(userId: string, snapshot: ListSnapshot): Promise<void>;
  getLastList(userId: string): Promise<ListSnapshot | null>;
  clearLastList(userId: string): Promise<void>;
}

export interface ITodoStore {
  getTasks(userId: string): Promise<{ text: string; completed: boolean }[]>;
  addTask(userId: string, text: string): Promise<void>;
  clearTasks(userId: string): Promise<void>;
  
  getReminders(userId: string): Promise<{ text: string; completed: boolean }[]>;
  addReminder(userId: string, text: string): Promise<void>;
  clearReminders(userId: string): Promise<void>;
}

export interface IAdhdCoachStore {
  getCheckins(userId: string): Promise<{ date: string; completed: boolean }[]>;
  addCheckin(userId: string, date: string): Promise<void>;

  /**
   * Micro-tareas del usuario. El campo `id` es ESTABLE (no es la posición):
   * sobrevive a borrados intermedios. Usado por el snapshot de S0.1.
   */
  getMicroTasks(userId: string): Promise<{ id: string; text: string; completed: boolean; priority?: string | null }[]>;
  addMicroTask(userId: string, text: string): Promise<void>;
  /** Marca una micro-task como hecha por id estable. */
  completeMicroTask(userId: string, taskId: string): Promise<boolean>;
  /**
   * Setea la prioridad Eisenhower de una micro-task por id estable.
   * Valores válidos: 'now' | 'plan' | 'quick' | 'later' | null (limpia).
   * Devuelve el texto de la tarea o null si el id no existe.
   */
  setMicroTaskPriorityById(userId: string, id: string, priority: string | null): Promise<string | null>;
  /** Borra una micro-task por id estable. Devuelve el texto borrado o null. */
  deleteMicroTaskById(userId: string, id: string): Promise<string | null>;
  /** Edita el texto de una micro-task por id estable. Devuelve el texto anterior. */
  editMicroTaskById(userId: string, id: string, newText: string): Promise<string | null>;

  getFocusSessions(userId: string): Promise<{ task: string; completed: boolean }[]>;
  addFocusSession(userId: string, task: string): Promise<void>;

  resetDay(userId: string): Promise<void>;

  // ── Fase 2 (modo silencio + borrado total del estado del dominio) ────────
  /** ISO 8601 hasta cuándo el usuario solicitó modo silencio. `null` si no aplica. */
  getSilenceUntil(userId: string): Promise<string | null>;
  /** Establece silence_until (sobrescribe cualquier valor previo). */
  setSilenceUntil(userId: string, isoUntil: string): Promise<void>;
  /** Quita modo silencio. Idempotente. */
  clearSilenceUntil(userId: string): Promise<void>;

  /**
   * Borra todo el estado del dominio para el usuario: checkins, microtasks,
   * focus sessions, silence_until, recordatorios, drafts. Usado por
   * la acción "borrar todo".
   */
  resetAllUserState(userId: string): Promise<void>;

  // ── Fase 3: recordatorios programados ──────────────────────────────────
  /**
   * Crea un recordatorio pendiente. Devuelve el id interno (estable por
   * usuario, sirve para postpone/markDone).
   */
  addReminder(userId: string, text: string, dueAtIso: string): Promise<{ id: string }>;
  /** Recordatorios PENDIENTES del usuario, ordenados por due_at ascendente. */
  listReminders(userId: string): Promise<Array<{ id: string; text: string; dueAt: string }>>;
  /** Cancela por índice (1-based, sobre listReminders). Devuelve el texto cancelado o null. */
  cancelReminderByIndex(userId: string, index1Based: number): Promise<string | null>;
  /** Cancela por id estable. Devuelve el texto cancelado o null si no existe / ya cancelado. */
  cancelReminderById(userId: string, reminderId: string): Promise<string | null>;
  /** Todos los recordatorios PENDIENTES con dueAt <= nowIso, a través de todos los usuarios del dominio. */
  getDueRemindersAllUsers(nowIso: string): Promise<Array<{ id: string; userId: string; text: string; dueAt: string }>>;
  /** Marca un recordatorio como enviado/completado. */
  markReminderDone(reminderId: string): Promise<void>;
  /** Reprograma un recordatorio existente a un nuevo due_at. */
  postponeReminder(reminderId: string, newDueAtIso: string): Promise<void>;

  // ── Drafts (recordatorio esperando que el usuario indique hora) ────────
  // dayHint es `string` para soportar:
  //   - literales: 'tomorrow' | 'today' | 'unspecified' (compat existente)
  //   - fecha especifica: 'date:YYYY-MM-DD'
  //   - dia de la semana: 'dow:N' (0=Dom .. 6=Sab)
  // La capa de storage NO interpreta el string; solo lo pasa por la columna
  // TEXT existente. No requiere migraciones.
  setPendingReminderDraft(
    userId: string,
    draft: { text: string; dayHint: string },
  ): Promise<void>;
  getPendingReminderDraft(userId: string): Promise<{ text: string; dayHint: string } | null>;
  clearPendingReminderDraft(userId: string): Promise<void>;

  // ── Resumen de recordatorios acumulados durante silencio ───────────────
  setPendingOverdueSummary(userId: string, reminderIds: string[]): Promise<void>;
  getPendingOverdueSummary(userId: string): Promise<{ reminderIds: string[] } | null>;
  clearPendingOverdueSummary(userId: string): Promise<void>;

  // ── Selección de agenda pendiente (refactor /agenda) ───────────────────
  /**
   * Guarda la lista de candidatos clasificados que el usuario seleccionará
   * en el siguiente turno. Persiste en `adhd_items` con
   * `type='agenda_selection'` y JSON serializado en `text` — sin migración.
   */
  setPendingAgendaSelection(
    userId: string,
    items: Array<{ text: string; category: string }>,
  ): Promise<void>;
  getPendingAgendaSelection(
    userId: string,
  ): Promise<Array<{ text: string; category: string }> | null>;
  clearPendingAgendaSelection(userId: string): Promise<void>;

  // ── Fase 4: flujos multi-paso (TCC, procrastinación, espiritualidad) ───
  /**
   * Draft genérico para flujos conversacionales multi-paso. Solo uno
   * activo por usuario; setearlo sobrescribe el anterior. Persiste en
   * `adhd_items` con `type='pending_flow_draft'` y JSON en `text`.
   */
  setPendingFlowDraft(
    userId: string,
    draft: { flow: string; step: number; answers: string[]; metadata?: Record<string, string> },
  ): Promise<void>;
  getPendingFlowDraft(
    userId: string,
  ): Promise<{ flow: string; step: number; answers: string[]; metadata?: Record<string, string> } | null>;
  clearPendingFlowDraft(userId: string): Promise<void>;

  // ── Fase 4: journal genérico (registros TCC, procrastinación, espiritual) ──
  /**
   * Persiste un registro de tipo arbitrario con resumen JSON o texto.
   * Mismo mecanismo: nuevo `type` en `adhd_items`, `text=summary`.
   * No usa el campo `date` (no son temporales por usuario).
   */
  addJournalEntry(userId: string, type: string, summary: string): Promise<void>;
  /** Cuenta registros del usuario en los tipos dados. Usado por /privacidad. */
  countJournalEntries(userId: string, types: string[]): Promise<number>;
}

export interface IStorageProvider {
  sessionStore: ISessionStore;
  todoStore: ITodoStore;
  adhdCoachStore: IAdhdCoachStore;
  connect(domainId: string): Promise<void>;
  disconnect(): Promise<void>;
}
