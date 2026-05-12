/**
 * LLM Provider Interface and Fallback Orchestrator.
 *
 * The fallback is optional, configurable, and degrades gracefully:
 * - If LLM_ENABLED=false → never called.
 * - If no API key → disabled automatically.
 * - If LLM call fails → returns null (system asks user for clarification).
 */

import { ILLMProvider, LLMIntentResult, Capability } from '../core/types';
import { AppConfig } from '../core/config';
import { logger } from '../core/logger';

const COMPONENT = 'LLMFallback';

export class LLMFallback {
  private provider: ILLMProvider | null = null;
  private enabled: boolean;

  constructor(config: AppConfig['llm'], provider?: ILLMProvider) {
    this.enabled = config.enabled;
    if (provider) {
      this.provider = provider;
    }

    if (!this.enabled) {
      logger.info(COMPONENT, 'LLM fallback is DISABLED (LLM_ENABLED=false).');
    } else if (!this.provider) {
      logger.warn(COMPONENT, 'LLM fallback is ENABLED but no provider was supplied. It will be inactive.');
      this.enabled = false;
    } else {
      logger.info(COMPONENT, `LLM fallback is ENABLED with provider: ${this.provider.providerName}`);
    }
  }

  isEnabled(): boolean {
    return this.enabled && this.provider !== null;
  }

  /**
   * Classify user intent via the LLM provider.
   * Returns null if disabled, unavailable, or if the LLM fails.
   */
  async classifyIntent(
    message: string,
    capabilities: Capability[],
    context?: string,
  ): Promise<LLMIntentResult | null> {
    if (!this.isEnabled() || !this.provider) {
      return null;
    }

    try {
      const result = await this.provider.classifyIntent(message, capabilities, context);
      logger.info(COMPONENT, 'LLM classification result', {
        action: result.action,
        confidence: result.confidence,
      });
      return result;
    } catch (err) {
      logger.error(COMPONENT, 'LLM classification failed', { error: String(err) });
      return null;
    }
  }
}
