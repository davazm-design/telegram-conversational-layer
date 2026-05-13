import { PendingInput } from '../../router/intent.router';
import { IAdhdCoachStore, ISessionStore, IStorageProvider, ITodoStore } from './interfaces';

class MemorySessionStore implements ISessionStore {
  constructor(private domainId: string) {}
  private pendingInputs = new Map<string, PendingInput>();
  private pendingActions = new Map<string, string>();
  private key(userId: string) { return `${this.domainId}:${userId}`; }

  async getPendingInput(userId: string): Promise<PendingInput | null> {
    return this.pendingInputs.get(this.key(userId)) ?? null;
  }
  async setPendingInput(userId: string, data: PendingInput): Promise<void> {
    this.pendingInputs.set(this.key(userId), data);
  }
  async clearPendingInput(userId: string): Promise<void> {
    this.pendingInputs.delete(this.key(userId));
  }

  async getPendingAction(userId: string): Promise<string | null> {
    return this.pendingActions.get(this.key(userId)) ?? null;
  }
  async setPendingAction(userId: string, action: string): Promise<void> {
    this.pendingActions.set(this.key(userId), action);
  }
  async clearPendingAction(userId: string): Promise<void> {
    this.pendingActions.delete(this.key(userId));
  }
}

class MemoryTodoStore implements ITodoStore {
  constructor(private domainId: string) {}
  private tasks = new Map<string, { text: string; completed: boolean }[]>();
  private reminders = new Map<string, { text: string; completed: boolean }[]>();
  private key(userId: string) { return `${this.domainId}:${userId}`; }

  async getTasks(userId: string) { return this.tasks.get(this.key(userId)) ?? []; }
  async addTask(userId: string, text: string) {
    const list = await this.getTasks(userId);
    list.push({ text, completed: false });
    this.tasks.set(this.key(userId), list);
  }
  async clearTasks(userId: string) { this.tasks.delete(this.key(userId)); }

  async getReminders(userId: string) { return this.reminders.get(this.key(userId)) ?? []; }
  async addReminder(userId: string, text: string) {
    const list = await this.getReminders(userId);
    list.push({ text, completed: false });
    this.reminders.set(this.key(userId), list);
  }
  async clearReminders(userId: string) { this.reminders.delete(this.key(userId)); }
}

interface MemoryReminder {
  id: string;
  userId: string;
  text: string;
  dueAt: string;
  completed: boolean;
}

class MemoryAdhdCoachStore implements IAdhdCoachStore {
  constructor(private domainId: string) {}
  private checkins = new Map<string, { date: string; completed: boolean }[]>();
  private microTasks = new Map<string, { id: string; text: string; completed: boolean; priority?: string | null }[]>();
  private focusSessions = new Map<string, { task: string; completed: boolean }[]>();
  private silenceUntil = new Map<string, string>();
  // Fase 3: reminders
  private reminders = new Map<string, MemoryReminder[]>();
  private reminderDraft = new Map<string, { text: string; dayHint: string }>();
  private overdueSummary = new Map<string, { reminderIds: string[] }>();
  // Refactor /agenda: candidatos clasificados pendientes de selección.
  private agendaSelection = new Map<string, Array<{ text: string; category: string }>>();
  // Fase 4: flujos multi-paso (TCC, procrastinación, espiritual).
  private flowDraft = new Map<string, { flow: string; step: number; answers: string[]; metadata?: Record<string, string> }>();
  // Fase 4: registros de "journal" agrupados por tipo.
  private journal = new Map<string, Array<{ type: string; summary: string }>>();
  private reminderSeq = 0;
  private key(userId: string) { return `${this.domainId}:${userId}`; }

  async getCheckins(userId: string) { return this.checkins.get(this.key(userId)) ?? []; }
  async addCheckin(userId: string, date: string) {
    const list = await this.getCheckins(userId);
    list.push({ date, completed: true });
    this.checkins.set(this.key(userId), list);
  }

  async getMicroTasks(userId: string) { return this.microTasks.get(this.key(userId)) ?? []; }
  async addMicroTask(userId: string, text: string) {
    const list = await this.getMicroTasks(userId);
    list.push({ id: String(list.length + 1), text, completed: false });
    this.microTasks.set(this.key(userId), list);
  }
  async completeMicroTask(userId: string, taskId: string) {
    const list = await this.getMicroTasks(userId);
    const task = list.find((t) => t.id === taskId);
    if (task) {
      task.completed = true;
      return true;
    }
    return false;
  }

  async deleteMicroTaskByIndex(userId: string, index1Based: number): Promise<string | null> {
    const k = this.key(userId);
    const list = this.microTasks.get(k) ?? [];
    if (index1Based < 1 || index1Based > list.length) return null;
    const removed = list.splice(index1Based - 1, 1)[0];
    this.microTasks.set(k, list);
    return removed?.text ?? null;
  }

  async editMicroTaskByIndex(userId: string, index1Based: number, newText: string): Promise<string | null> {
    const k = this.key(userId);
    const list = this.microTasks.get(k) ?? [];
    if (index1Based < 1 || index1Based > list.length) return null;
    const oldText = list[index1Based - 1].text;
    list[index1Based - 1].text = newText;
    this.microTasks.set(k, list);
    return oldText;
  }

  async setMicroTaskPriority(userId: string, index1Based: number, priority: string | null): Promise<string | null> {
    const k = this.key(userId);
    const list = this.microTasks.get(k) ?? [];
    if (index1Based < 1 || index1Based > list.length) return null;
    list[index1Based - 1].priority = priority;
    this.microTasks.set(k, list);
    return list[index1Based - 1].text;
  }

  async getFocusSessions(userId: string) { return this.focusSessions.get(this.key(userId)) ?? []; }
  async addFocusSession(userId: string, task: string) {
    const list = await this.getFocusSessions(userId);
    list.push({ task, completed: true });
    this.focusSessions.set(this.key(userId), list);
  }

  async resetDay(userId: string) {
    this.checkins.delete(this.key(userId));
    this.microTasks.delete(this.key(userId));
    this.focusSessions.delete(this.key(userId));
  }

  async getSilenceUntil(userId: string) {
    return this.silenceUntil.get(this.key(userId)) ?? null;
  }
  async setSilenceUntil(userId: string, isoUntil: string) {
    this.silenceUntil.set(this.key(userId), isoUntil);
  }
  async clearSilenceUntil(userId: string) {
    this.silenceUntil.delete(this.key(userId));
  }

  async resetAllUserState(userId: string) {
    const k = this.key(userId);
    this.checkins.delete(k);
    this.microTasks.delete(k);
    this.focusSessions.delete(k);
    this.silenceUntil.delete(k);
    this.reminders.delete(k);
    this.reminderDraft.delete(k);
    this.overdueSummary.delete(k);
    this.agendaSelection.delete(k);
    this.flowDraft.delete(k);
    this.journal.delete(k);
  }

  // ── Fase 3: reminders ──────────────────────────────────────────────────

  async addReminder(userId: string, text: string, dueAtIso: string) {
    const id = String(++this.reminderSeq) + '-' + Math.random().toString(36).slice(2, 6);
    const list = this.reminders.get(this.key(userId)) ?? [];
    list.push({ id, userId, text, dueAt: dueAtIso, completed: false });
    this.reminders.set(this.key(userId), list);
    return { id };
  }

  async listReminders(userId: string) {
    const list = this.reminders.get(this.key(userId)) ?? [];
    return list
      .filter((r) => !r.completed)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .map(({ id, text, dueAt }) => ({ id, text, dueAt }));
  }

  async cancelReminderByIndex(userId: string, index1Based: number) {
    const pending = await this.listReminders(userId);
    if (index1Based < 1 || index1Based > pending.length) return null;
    const target = pending[index1Based - 1];
    const list = this.reminders.get(this.key(userId)) ?? [];
    const r = list.find((x) => x.id === target.id);
    if (!r) return null;
    r.completed = true;
    return r.text;
  }

  async getDueRemindersAllUsers(nowIso: string) {
    const out: Array<{ id: string; userId: string; text: string; dueAt: string }> = [];
    for (const list of this.reminders.values()) {
      for (const r of list) {
        if (!r.completed && r.dueAt <= nowIso) {
          out.push({ id: r.id, userId: r.userId, text: r.text, dueAt: r.dueAt });
        }
      }
    }
    return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  async markReminderDone(reminderId: string) {
    for (const list of this.reminders.values()) {
      const r = list.find((x) => x.id === reminderId);
      if (r) { r.completed = true; return; }
    }
  }

  async postponeReminder(reminderId: string, newDueAtIso: string) {
    for (const list of this.reminders.values()) {
      const r = list.find((x) => x.id === reminderId);
      if (r) { r.dueAt = newDueAtIso; return; }
    }
  }

  async setPendingReminderDraft(userId: string, draft: { text: string; dayHint: string }) {
    this.reminderDraft.set(this.key(userId), { ...draft });
  }
  async getPendingReminderDraft(userId: string) {
    return this.reminderDraft.get(this.key(userId)) ?? null;
  }
  async clearPendingReminderDraft(userId: string) {
    this.reminderDraft.delete(this.key(userId));
  }

  async setPendingOverdueSummary(userId: string, reminderIds: string[]) {
    this.overdueSummary.set(this.key(userId), { reminderIds: [...reminderIds] });
  }
  async getPendingOverdueSummary(userId: string) {
    return this.overdueSummary.get(this.key(userId)) ?? null;
  }
  async clearPendingOverdueSummary(userId: string) {
    this.overdueSummary.delete(this.key(userId));
  }

  async setPendingAgendaSelection(userId: string, items: Array<{ text: string; category: string }>) {
    this.agendaSelection.set(this.key(userId), items.map((i) => ({ ...i })));
  }
  async getPendingAgendaSelection(userId: string) {
    const list = this.agendaSelection.get(this.key(userId));
    return list ? list.map((i) => ({ ...i })) : null;
  }
  async clearPendingAgendaSelection(userId: string) {
    this.agendaSelection.delete(this.key(userId));
  }

  // ── Fase 4 ──
  async setPendingFlowDraft(
    userId: string,
    draft: { flow: string; step: number; answers: string[]; metadata?: Record<string, string> },
  ) {
    this.flowDraft.set(this.key(userId), {
      flow: draft.flow,
      step: draft.step,
      answers: [...draft.answers],
      metadata: draft.metadata ? { ...draft.metadata } : undefined,
    });
  }
  async getPendingFlowDraft(userId: string) {
    const d = this.flowDraft.get(this.key(userId));
    if (!d) return null;
    return {
      flow: d.flow,
      step: d.step,
      answers: [...d.answers],
      metadata: d.metadata ? { ...d.metadata } : undefined,
    };
  }
  async clearPendingFlowDraft(userId: string) {
    this.flowDraft.delete(this.key(userId));
  }

  async addJournalEntry(userId: string, type: string, summary: string) {
    const k = this.key(userId);
    const list = this.journal.get(k) ?? [];
    list.push({ type, summary });
    this.journal.set(k, list);
  }
  async countJournalEntries(userId: string, types: string[]) {
    const list = this.journal.get(this.key(userId)) ?? [];
    if (!types || types.length === 0) return list.length;
    const set = new Set(types);
    return list.filter((e) => set.has(e.type)).length;
  }
}

export class MemoryStorageProvider implements IStorageProvider {
  sessionStore: ISessionStore;
  todoStore: ITodoStore;
  adhdCoachStore: IAdhdCoachStore;

  constructor() {
    this.sessionStore = new MemorySessionStore('default');
    this.todoStore = new MemoryTodoStore('default');
    this.adhdCoachStore = new MemoryAdhdCoachStore('default');
  }

  async connect(domainId: string): Promise<void> {
    this.sessionStore = new MemorySessionStore(domainId);
    this.todoStore = new MemoryTodoStore(domainId);
    this.adhdCoachStore = new MemoryAdhdCoachStore(domainId);
  }
  async disconnect(): Promise<void> {}
}
