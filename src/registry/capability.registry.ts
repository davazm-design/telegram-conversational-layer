/**
 * Capability Registry — central registry of domain capabilities.
 *
 * Each domain handler registers its capabilities here.
 * The router and LLM use this registry to understand what actions are available.
 */

import { Capability, IDomainHandler, ActionResult } from '../core/types';
import { logger } from '../core/logger';

const COMPONENT = 'CapabilityRegistry';

export class CapabilityRegistry {
  private capabilities = new Map<string, Capability>();
  private handlers = new Map<string, IDomainHandler>();

  /** Register a domain handler and all its capabilities. */
  registerDomain(handler: IDomainHandler): void {
    const caps = handler.getCapabilities();
    for (const cap of caps) {
      if (this.capabilities.has(cap.name)) {
        logger.warn(COMPONENT, `Capability "${cap.name}" is being overwritten by domain "${handler.domainName}".`);
      }
      this.capabilities.set(cap.name, cap);
      this.handlers.set(cap.name, handler);
    }
    logger.info(COMPONENT, `Domain "${handler.domainName}" registered with ${caps.length} capabilities.`);
  }

  /** Get a capability by name. */
  getCapability(name: string): Capability | undefined {
    return this.capabilities.get(name);
  }

  /** Get all registered capabilities. */
  getAllCapabilities(): Capability[] {
    return Array.from(this.capabilities.values());
  }

  /** Get the handler responsible for a capability. */
  getHandler(capabilityName: string): IDomainHandler | undefined {
    return this.handlers.get(capabilityName);
  }

  /** Execute an action through the appropriate domain handler. */
  async executeAction(action: string, params: Record<string, unknown>, userId: string): Promise<ActionResult> {
    const handler = this.handlers.get(action);
    if (!handler) {
      return { success: false, message: `No hay un handler registrado para la acción "${action}".` };
    }

    try {
      return await handler.execute(action, params, userId);
    } catch (err) {
      logger.error(COMPONENT, 'Action execution failed', { action, error: String(err) });
      return { success: false, message: 'Ocurrió un error al ejecutar la acción. Inténtalo de nuevo.' };
    }
  }

  /** Get a brief description of all capabilities for LLM context or /help. */
  getCapabilitySummary(): string {
    const caps = this.getAllCapabilities();
    if (caps.length === 0) return 'No hay acciones disponibles.';
    return caps.map(c => `• ${c.name}: ${c.description}`).join('\n');
  }
}
