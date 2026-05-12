/**
 * Example Domain: Todo / Agenda
 *
 * Demonstrates how to implement IDomainHandler.
 * Uses in-memory storage for simplicity.
 *
 * This file serves as a template for creating new domain handlers.
 *
 * RULES NOTE: All patterns match against NORMALIZED text from the router
 * (lowercase, no accents, no trailing punctuation, collapsed spaces).
 * Therefore, rules do NOT need the /i flag or accent variants.
 */

import {
  IDomainHandler,
  Capability,
  ActionResult,
  RiskLevel,
  RulePattern,
} from '../core/types';

// ─── In-Memory Storage ──────────────────────────────────────────────────────

import { ITodoStore } from '../core/storage/interfaces';

// ─── Domain Handler ─────────────────────────────────────────────────────────

export class TodoDomainHandler implements IDomainHandler {
  readonly domainName = 'Todo / Agenda';

  constructor(private store: ITodoStore) {}

  getCapabilities(): Capability[] {
    return [
      {
        name: 'list_today',
        description: 'Muestra la agenda y tareas de hoy',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'list_tasks',
        description: 'Lista todas las tareas pendientes',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'create_task',
        description: 'Crea una nueva tarea',
        parameters: {
          text: { type: 'string', description: 'Descripción de la tarea', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'complete_task',
        description: 'Marca una tarea como completada',
        parameters: {
          taskId: { type: 'string', description: 'ID de la tarea', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'create_reminder',
        description: 'Crea un recordatorio',
        parameters: {
          text: { type: 'string', description: 'Texto del recordatorio', required: true },
          datetime: { type: 'string', description: 'Fecha y hora (opcional)' },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'delete_all_tasks',
        description: 'Elimina TODAS las tareas (irreversible)',
        parameters: {},
        riskLevel: RiskLevel.HIGH_RISK_ACTION,
        requiresConfirmation: true,
      },
    ];
  }

  getCommands(): Record<string, string> {
    return {
      '/today': 'list_today',
      '/agenda': 'list_today',
      '/tasks': 'list_tasks',
    };
  }

  getRules(): RulePattern[] {
    return [
      // ─── list_today: "qué tengo hoy", "mi agenda de hoy", etc. ──────────
      {
        patterns: [
          /^que tengo hoy$/,
          /^que hay para hoy$/,
          /^que hay hoy$/,
          /^mi agenda de hoy$/,
          /^mi agenda$/,
          /^agenda de hoy$/,
          /^hoy$/,
          /^mi dia$/,
          /^como va mi dia$/,
          /^que tengo pendiente$/,
          /^pendientes de hoy$/,
        ],
        action: 'list_today',
      },

      // ─── list_tasks: "tareas", "mis tareas", "ver tareas", etc. ─────────
      {
        patterns: [
          /^tareas$/,
          /^mis tareas$/,
          /^lista de tareas$/,
          /^listar tareas$/,
          /^ver tareas$/,
          /^mostrar tareas$/,
          /^todas las tareas$/,
          /^ver mis tareas$/,
        ],
        action: 'list_tasks',
      },

      // ─── create_task: with or without inline text ───────────────────────
      // Matches: "agregar tarea comprar café", "nueva tarea X", "crear tarea X"
      // Also matches WITHOUT text: "agregar tarea", "nueva tarea" → params.text = ''
      // The orchestrator will check for empty text and trigger pending_input.
      {
        patterns: [
          /^(?:agregar|agrega|nueva|crear|añadir|anade|añade) (?:una )?tarea[:\s]*(.*)$/,
        ],
        action: 'create_task',
        extractParams: (match, _normalized, rawText) => {
          const m = rawText.match(/(?:tarea)[:\s]+(.*)$/i);
          return { text: (m?.[1] ?? match[1] ?? '').trim() };
        },
      },

      // ─── create_reminder: with or without inline text ───────────────────
      {
        patterns: [
          /^(?:recuerdame|recordatorio|crear recordatorio)[:\s]*(.*)$/,
        ],
        action: 'create_reminder',
        extractParams: (match, _normalized, rawText) => {
          const m = rawText.match(/(?:recuérdame|recuerdame|recordatorio|crear recordatorio)[:\s]+(.*)$/i);
          return { text: (m?.[1] ?? match[1] ?? '').trim() };
        },
      },

      // ─── delete_all_tasks: destructive action ──────────────────────────
      {
        patterns: [
          /^(?:borra|borrar|elimina|eliminar|limpia|limpiar|quita|quitar) todas las tareas$/,
          /^(?:borra|borrar|elimina|eliminar|limpia|limpiar) todo$/,
          /^eliminar todas las tareas$/,
          /^borrar todas las tareas$/,
        ],
        action: 'delete_all_tasks',
      },
    ];
  }

  async execute(action: string, params: Record<string, unknown>, userId: string): Promise<ActionResult> {
    switch (action) {
      case 'list_today':
        return await this.listToday(userId);
      case 'list_tasks':
        return await this.listTasks(userId);
      case 'create_task':
        return await this.createTask(userId, params);
      case 'complete_task':
        return await this.completeTask(userId, params);
      case 'create_reminder':
        return await this.createReminder(userId, params);
      case 'delete_all_tasks':
        return await this.deleteAllTasks(userId);
      default:
        return { success: false, message: `Acción "${action}" no implementada en este dominio.` };
    }
  }

  async getStatusSummary(userId: string): Promise<string> {
    const tasks = await this.store.getTasks(userId);
    const pending = tasks.filter((t) => !t.completed).length;
    const done = tasks.filter((t) => t.completed).length;
    const reminders = await this.store.getReminders(userId);
    return `Tareas: ${pending} pendientes, ${done} completadas. Recordatorios: ${reminders.length}.`;
  }

  // ─── Action Implementations ─────────────────────────────────────────────

  private async listToday(userId: string): Promise<ActionResult> {
    const tasks = (await this.store.getTasks(userId)).filter((t) => !t.completed);
    const reminders = await this.store.getReminders(userId);

    if (tasks.length === 0 && reminders.length === 0) {
      return { success: true, message: '📭 No tienes tareas ni recordatorios para hoy. ¡Día libre!' };
    }

    const lines: string[] = ['📅 *Tu día de hoy:*', ''];
    if (tasks.length > 0) {
      lines.push('*Tareas pendientes:*');
      tasks.forEach((t, i) => lines.push(`  ${i + 1}. ${t.text}`));
      lines.push('');
    }
    if (reminders.length > 0) {
      lines.push('*Recordatorios:*');
      reminders.forEach((r, i) => lines.push(`  🔔 ${r.text}`));
    }

    return { success: true, message: lines.join('\n') };
  }

  private async listTasks(userId: string): Promise<ActionResult> {
    const tasks = await this.store.getTasks(userId);
    if (tasks.length === 0) {
      return { success: true, message: '📭 No tienes tareas. Usa "agregar tarea: ..." para crear una.' };
    }

    const lines = ['📋 *Tus tareas:*', ''];
    tasks.forEach((t, i) => {
      const check = t.completed ? '✅' : '⬜';
      lines.push(`  ${check} ${i + 1}. ${t.text}`);
    });

    const pending = tasks.filter((t) => !t.completed).length;
    lines.push('', `_${pending} pendiente(s)._`);
    return { success: true, message: lines.join('\n') };
  }

  private async createTask(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const text = String(params.text ?? '').trim();
    if (!text) {
      return { success: false, message: '⚠️ Necesito el texto de la tarea. Ejemplo: "agregar tarea: comprar café"' };
    }

    await this.store.addTask(userId, text);
    return { success: true, message: `✅ Tarea creada: "${text}"` };
  }

  private async completeTask(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    // Currently, IStorageProvider ITodoStore doesn't have a completeTask. It has updateTask? No, it doesn't. We only have clearTasks and getTasks right now in memory, wait, in memory.storage.ts I didn't add completeTask.
    return { success: false, message: '⚠️ Marcar tarea como completada no está soportado en la versión cloud yet.' };
  }

  private async createReminder(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const text = String(params.text ?? '').trim();
    if (!text) {
      return { success: false, message: '⚠️ Necesito el texto del recordatorio.' };
    }

    await this.store.addReminder(userId, text);
    return { success: true, message: `🔔 Recordatorio creado: "${text}"` };
  }

  private async deleteAllTasks(userId: string): Promise<ActionResult> {
    const tasks = await this.store.getTasks(userId);
    const count = tasks.length;
    await this.store.clearTasks(userId);
    return { success: true, message: `🗑️ ${count} tarea(s) eliminada(s).` };
  }
}
