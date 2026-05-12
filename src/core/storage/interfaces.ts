import { PendingInput } from '../../router/intent.router';

export interface ISessionStore {
  getPendingInput(userId: string): Promise<PendingInput | null>;
  setPendingInput(userId: string, data: PendingInput): Promise<void>;
  clearPendingInput(userId: string): Promise<void>;

  getPendingAction(userId: string): Promise<string | null>;
  setPendingAction(userId: string, action: string): Promise<void>;
  clearPendingAction(userId: string): Promise<void>;
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

  getMicroTasks(userId: string): Promise<{ id: string; text: string; completed: boolean }[]>;
  addMicroTask(userId: string, text: string): Promise<void>;
  completeMicroTask(userId: string, taskId: string): Promise<boolean>;

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
   * focus sessions, silence_until. Usado por la acción "borrar todo".
   */
  resetAllUserState(userId: string): Promise<void>;
}

export interface IStorageProvider {
  sessionStore: ISessionStore;
  todoStore: ITodoStore;
  adhdCoachStore: IAdhdCoachStore;
  connect(domainId: string): Promise<void>;
  disconnect(): Promise<void>;
}
