/**
 * Example Domain: ADHD Coach
 *
 * Demonstrates that the conversational layer is domain-agnostic.
 * This domain helps users with ADHD manage focus, micro-tasks, and daily routines.
 *
 * Uses in-memory storage for simplicity.
 */

import {
  IDomainHandler,
  Capability,
  ActionResult,
  RiskLevel,
  RulePattern,
} from '../core/types';

import { IAdhdCoachStore } from '../core/storage/interfaces';

// ─── Domain Handler ─────────────────────────────────────────────────────────

export class AdhdCoachDomainHandler implements IDomainHandler {
  readonly domainName = 'ADHD Coach';

  constructor(private store: IAdhdCoachStore) {}

  getCapabilities(): Capability[] {
    return [
      {
        name: 'daily_checkin',
        description: 'Registra tu check-in diario y recibe motivación',
        parameters: {},
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'list_today_focus',
        description: 'Muestra tus micro-tareas y foco del día',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      {
        name: 'add_micro_task',
        description: 'Agrega una micro-tarea (máximo 15 min)',
        parameters: {
          text: { type: 'string', description: 'Descripción corta de la micro-tarea', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'start_focus_session',
        description: 'Inicia una sesión de foco de 25 minutos (Pomodoro)',
        parameters: {
          task: { type: 'string', description: 'En qué te vas a enfocar' },
          minutes: { type: 'number', description: 'Duración en minutos (default: 25)' },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'complete_micro_task',
        description: 'Marca una micro-tarea como hecha',
        parameters: {
          taskId: { type: 'string', description: 'Número o ID de la micro-tarea', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      {
        name: 'reset_day',
        description: 'Reinicia todas las micro-tareas del día (irreversible)',
        parameters: {},
        riskLevel: RiskLevel.HIGH_RISK_ACTION,
        requiresConfirmation: true,
      },
    ];
  }

  getCommands(): Record<string, string> {
    return {
      '/checkin': 'daily_checkin',
      '/focus': 'list_today_focus',
      '/pomodoro': 'start_focus_session',
    };
  }

  getRules(): RulePattern[] {
    return [
      {
        patterns: [/^(check.?in|buenos dias|buen dia|ya estoy|llegue|presente)$/],
        action: 'daily_checkin',
      },
      {
        patterns: [/^(mi foco|en que me enfoco|que hago|foco del dia|prioridad)$/],
        action: 'list_today_focus',
      },
      {
        patterns: [/^(micro.?tarea|tarea pequena|agregar micro)[:\s]*(.*)$/],
        action: 'add_micro_task',
        extractParams: (match, _normalized, rawText) => {
          const m = rawText.match(/(?:micro.?tarea|tarea pequeña|agregar micro)[:\s]+(.*)$/i);
          return { text: (m?.[1] ?? match[2] ?? '').trim() };
        },
      },
      {
        patterns: [/^(pomodoro|enfocame|enfocar(?:me)?|sesion de foco)[:\s]*(.*)$/],
        action: 'start_focus_session',
        extractParams: (match, _normalized, rawText) => {
          const m = rawText.match(/(?:pomodoro|enfócame|enfocarme|sesión de foco)[:\s]+(.*)$/i);
          return { task: (m?.[1] ?? match[2] ?? '').trim() || 'tarea actual' };
        },
      },
      {
        patterns: [/^(listo|hecho|termine|complete|✅)\s*(\d+)?$/],
        action: 'complete_micro_task',
        extractParams: (match) => {
          return { taskId: match[2] ?? '1' };
        },
      },
    ];
  }

  async execute(action: string, params: Record<string, unknown>, userId: string): Promise<ActionResult> {
    switch (action) {
      case 'daily_checkin':
        return await this.dailyCheckin(userId);
      case 'list_today_focus':
        return await this.listTodayFocus(userId);
      case 'add_micro_task':
        return await this.addMicroTask(userId, params);
      case 'start_focus_session':
        return await this.startFocusSession(userId, params);
      case 'complete_micro_task':
        return await this.completeMicroTask(userId, params);
      case 'reset_day':
        return await this.resetDay(userId);
      default:
        return { success: false, message: `Acción "${action}" no implementada en ADHD Coach.` };
    }
  }

  async getStatusSummary(userId: string): Promise<string> {
    const tasks = await this.store.getMicroTasks(userId);
    const pending = tasks.filter((t) => !t.completed).length;
    const done = tasks.filter((t) => t.completed).length;
    const sessions = await this.store.getFocusSessions(userId);
    const session = sessions.length > 0 ? sessions[sessions.length - 1] : null;
    const focusStatus = session ? `🎯 En foco: "${session.task}"` : '💤 Sin sesión activa';
    return `Micro-tareas: ${pending} pendientes, ${done} completadas. ${focusStatus}`;
  }

  // ─── Action Implementations ─────────────────────────────────────────────

  private async dailyCheckin(userId: string): Promise<ActionResult> {
    const today = new Date().toISOString().split('T')[0];
    const checkins = await this.store.getCheckins(userId);

    if (checkins.some(c => c.date === today)) {
      return { success: true, message: '✅ Ya hiciste tu check-in hoy. ¡Sigue así! 💪' };
    }

    await this.store.addCheckin(userId, today);
    const streak = checkins.length + 1;
    const tasks = (await this.store.getMicroTasks(userId)).filter((t) => !t.completed);

    const motivations = [
      '🌟 ¡Excelente! Cada día que te presentas cuenta.',
      '💪 ¡Bien hecho! El progreso es progreso, sin importar el tamaño.',
      '🧠 Tu cerebro TDAH es un superpoder. Vamos a enfocarlo hoy.',
      '🚀 ¡Check-in registrado! Pequeños pasos, grandes resultados.',
    ];
    const motivation = motivations[streak % motivations.length];

    const lines = [
      `☀️ *Check-in del día* — Racha: ${streak} día(s)`,
      '',
      motivation,
    ];

    if (tasks.length > 0) {
      lines.push('', `📋 Tienes ${tasks.length} micro-tarea(s) pendiente(s). Escribe /focus para verlas.`);
    } else {
      lines.push('', '📝 No tienes micro-tareas. Usa "microtarea: ..." para agregar una pequeña.');
    }

    return { success: true, message: lines.join('\n') };
  }

  private async listTodayFocus(userId: string): Promise<ActionResult> {
    const tasks = await this.store.getMicroTasks(userId);
    const sessions = await this.store.getFocusSessions(userId);
    const session = sessions.length > 0 ? sessions[sessions.length - 1] : null;

    if (tasks.length === 0 && !session) {
      return {
        success: true,
        message: '🧘 No tienes micro-tareas ni sesiones de foco activas.\n\nAgrega una con: "microtarea: revisar correo"',
      };
    }

    const lines = ['🎯 *Tu foco de hoy:*', ''];

    if (session) {
      lines.push(`⏱️ *Sesión activa:* "${session.task}"`, '');
    }

    if (tasks.length > 0) {
      lines.push('*Micro-tareas:*');
      tasks.forEach((t, i) => {
        const check = t.completed ? '✅' : '⬜';
        lines.push(`  ${check} ${i + 1}. ${t.text}`);
      });
      const pending = tasks.filter((t) => !t.completed).length;
      lines.push('', `_${pending} pendiente(s). Escribe "listo 1" para completar._`);
    }

    return { success: true, message: lines.join('\n') };
  }

  private async addMicroTask(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const text = String(params.text ?? '').trim();
    if (!text) {
      return { success: false, message: '⚠️ Necesito el texto de la micro-tarea. Ejemplo: "microtarea: revisar correo"' };
    }

    await this.store.addMicroTask(userId, text);
    return { success: true, message: `✅ Micro-tarea agregada: "${text}"\n\n💡 _Recuerda: máximo 15 minutos por micro-tarea._` };
  }

  private async startFocusSession(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const task = String(params.task ?? 'tarea actual').trim();
    const minutes = Number(params.minutes) || 25;

    await this.store.addFocusSession(userId, task);

    return {
      success: true,
      message: `🍅 *Sesión Pomodoro iniciada*\n\n⏱️ Duración: ${minutes} minutos\n🎯 Foco: "${task}"\n\n_Concéntrate. Silencia notificaciones. Tú puedes._ 💪`,
    };
  }

  private async completeMicroTask(userId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const taskId = String(params.taskId ?? '').trim();
    const tasks = await this.store.getMicroTasks(userId);

    const index = parseInt(taskId, 10) - 1;
    const task = (index >= 0 && index < tasks.length) ? tasks[index] : null;

    if (!task) {
      return { success: false, message: `⚠️ No encontré la micro-tarea #${taskId}. Escribe /focus para ver la lista.` };
    }

    if (task.completed) {
      return { success: true, message: `ℹ️ La micro-tarea "${task.text}" ya estaba completada.` };
    }

    await this.store.completeMicroTask(userId, task.id);
    const remaining = tasks.filter((t) => !t.completed).length - 1;

    if (remaining <= 0) {
      return { success: true, message: `🎉 ¡Completaste "${task.text}"! *¡Todas las micro-tareas están hechas!* 🏆` };
    }

    return { success: true, message: `✅ ¡Completada! "${task.text}"\n\n📋 Quedan ${remaining} micro-tarea(s). ¡Sigue así!` };
  }

  private async resetDay(userId: string): Promise<ActionResult> {
    const tasks = await this.store.getMicroTasks(userId);
    const count = tasks.length;
    await this.store.resetDay(userId);
    return { success: true, message: `🗑️ ${count} micro-tarea(s) eliminada(s). Sesión de foco reiniciada. Día limpio. 🧘` };
  }
}
