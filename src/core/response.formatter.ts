/**
 * Response Formatter — creates user-friendly responses.
 *
 * Keeps responses brief, actionable, and free of technical details.
 */

import { ActionResult, Capability } from './types';

export class ResponseFormatter {
  /** Format a successful action result. */
  formatResult(result: ActionResult): string {
    if (result.success) {
      return result.message;
    }
    return `❌ ${result.message}`;
  }

  /** Format a confirmation request. */
  formatConfirmation(description: string): string {
    return [
      `🔔 *Confirmación requerida*`,
      '',
      description,
      '',
      `Responde *sí* para confirmar o *cancelar* para descartar.`,
    ].join('\n');
  }

  /** Format the /help response from capabilities. */
  formatHelp(capabilities: Capability[], domainName: string): string {
    const lines = [
      `📋 *Ayuda — ${domainName}*`,
      '',
      '*Comandos:*',
      '  /start — Iniciar',
      '  /help — Esta ayuda',
      '  /status — Estado actual',
      '  /today — Agenda de hoy',
      '  /cancel — Cancelar acción pendiente',
      '',
      '*Acciones disponibles:*',
    ];

    for (const cap of capabilities) {
      if (cap.name.startsWith('system_')) continue;
      const risk = cap.requiresConfirmation ? ' ⚠️' : '';
      lines.push(`  • *${cap.name}*: ${cap.description}${risk}`);
    }

    lines.push('', '_También puedes escribir en lenguaje natural._');
    return lines.join('\n');
  }

  /** Format the welcome message. */
  formatWelcome(domainName: string): string {
    return [
      `👋 ¡Hola! Soy tu asistente de *${domainName}*.`,
      '',
      'Puedo ayudarte con varias tareas. Escribe /help para ver qué puedo hacer.',
      'También puedes escribirme en lenguaje natural.',
    ].join('\n');
  }

  /** Format a "didn't understand" message. */
  formatUnknown(): string {
    return '🤔 No entendí tu mensaje. ¿Podrías reformularlo o usar /help para ver opciones?';
  }

  /** Format cancellation acknowledgment. */
  formatCancelled(hadPending: boolean): string {
    if (hadPending) {
      return '✅ Acción cancelada.';
    }
    return 'ℹ️ No hay ninguna acción pendiente para cancelar.';
  }
}
