/**
 * Policy Engine — risk classification and confirmation enforcement.
 *
 * Evaluates each resolved intent against the capability's risk level
 * and decides whether to execute directly or require confirmation.
 */

import { ResolvedIntent, Capability, RiskLevel, IntentSource } from '../core/types';
import { logger } from '../core/logger';

const COMPONENT = 'PolicyEngine';

export enum PolicyDecision {
  EXECUTE = 'EXECUTE',
  CONFIRM = 'CONFIRM',
  DENY = 'DENY',
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

export class PolicyEngine {
  /**
   * Configuration: should LOW_RISK_WRITE actions require confirmation?
   * Default: false (execute directly). Set to true for stricter environments.
   */
  private confirmLowRisk: boolean;

  constructor(options?: { confirmLowRisk?: boolean }) {
    this.confirmLowRisk = options?.confirmLowRisk ?? false;
  }

  evaluate(intent: ResolvedIntent, capability: Capability | undefined): PolicyResult {
    // System actions (help, start, cancel, confirm) always execute
    if (intent.action.startsWith('system_')) {
      return { decision: PolicyDecision.EXECUTE, reason: 'System action.' };
    }

    // Unknown capability — deny
    if (!capability) {
      return { decision: PolicyDecision.DENY, reason: `Acción "${intent.action}" no reconocida.` };
    }

    // If the capability explicitly requires confirmation, always confirm
    if (capability.requiresConfirmation) {
      logger.info(COMPONENT, 'Confirmation required by capability', { action: intent.action });
      return { decision: PolicyDecision.CONFIRM, reason: `"${capability.description}" requiere confirmación.` };
    }

    // Risk-based policy
    switch (capability.riskLevel) {
      case RiskLevel.READ_ONLY:
        return { decision: PolicyDecision.EXECUTE, reason: 'Read-only action.' };

      case RiskLevel.LOW_RISK_WRITE:
        if (this.confirmLowRisk) {
          return { decision: PolicyDecision.CONFIRM, reason: 'Low-risk write requires confirmation (strict mode).' };
        }
        return { decision: PolicyDecision.EXECUTE, reason: 'Low-risk write, auto-execute.' };

      case RiskLevel.MEDIUM_RISK_WRITE:
        return { decision: PolicyDecision.CONFIRM, reason: `"${capability.description}" modifica datos — confirmación requerida.` };

      case RiskLevel.HIGH_RISK_ACTION:
        return { decision: PolicyDecision.CONFIRM, reason: `⚠️ "${capability.description}" es una acción de alto riesgo — confirmación obligatoria.` };

      default:
        // Safety: unknown risk level → confirm
        return { decision: PolicyDecision.CONFIRM, reason: 'Unknown risk level, requesting confirmation.' };
    }

    // Additional safety: if the intent came from LLM with low confidence, force confirmation
    // (This is a guard against hallucinated intents)
  }

  /** Additional check: LLM-sourced intents with low confidence should be confirmed. */
  shouldConfirmLowConfidence(intent: ResolvedIntent): boolean {
    return intent.source === IntentSource.LLM && intent.confidence < 0.7;
  }
}
