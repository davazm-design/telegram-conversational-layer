/**
 * Intent Router — hybrid 4-level routing strategy.
 *
 * Level 0: Pending input (conversational state — e.g. awaiting task text)
 * Level 1: Explicit commands (/start, /help, etc.)
 * Level 2: Algorithmic rules (regex patterns for common phrases)
 * Level 3: (Reserved for local classifier)
 * Level 4: LLM fallback (only when enabled and needed)
 *
 * The router always tries the cheapest option first.
 *
 * EXTENSIBILITY: Domain-specific commands and rules can be injected
 * via addCommands() and addRules() without modifying this file.
 *
 * TEXT NORMALIZATION: All user input is normalized before rule matching:
 * - lowercase, trim, punctuation removal, accent stripping, space collapsing
 */

import { GenericMessage, ResolvedIntent, IntentSource, Capability, RulePattern } from '../core/types';
import { LLMFallback } from '../llm/llm.fallback';
import { logger } from '../core/logger';
import { normalizeForMatching, stripAccents } from './text.normalizer';

const COMPONENT = 'IntentRouter';

// Re-export RulePattern for convenience
export type { RulePattern } from '../core/types';

/**
 * Pending input descriptor.
 * When a domain needs follow-up input (e.g. "agregar tarea" without text),
 * the orchestrator sets this on the session. The router checks it at Level 0.
 */
export interface PendingInput {
  /** The action to execute once input is provided. */
  action: string;
  /** The parameter name to fill with the user's next message. */
  paramName: string;
  /** Human-readable prompt shown to the user. */
  prompt: string;
}

// ─── System Commands (always available) ─────────────────────────────────────

const SYSTEM_COMMANDS: Record<string, string> = {
  '/start':    'system_start',
  '/help':     'system_help',
  '/status':   'system_status',
  '/settings': 'system_settings',
  '/cancel':   'system_cancel',
  '/confirm':  'system_confirm',
};

// ─── System Rules (always available) ────────────────────────────────────────
// NOTE: These patterns match against NORMALIZED text (no accents, lowercase, no trailing punctuation)

const SYSTEM_RULES: RulePattern[] = [
  {
    patterns: [
      /^(estado|como voy|resumen)$/,
    ],
    action: 'system_status',
  },
  {
    patterns: [
      /^(si|confirmar|confirmo|ok|dale|va|adelante)$/,
    ],
    action: 'system_confirm',
  },
  {
    patterns: [
      /^(no|cancelar|cancela|olvidalo|dejalo)$/,
    ],
    action: 'system_cancel',
  },
  {
    patterns: [
      /^(ayuda|help|opciones|que puedo hacer|comandos)$/,
    ],
    action: 'system_help',
  },
];

// ─── Router Class ────────────────────────────────────────────────────────────

export class IntentRouter {
  private commands: Record<string, string>;
  private rules: RulePattern[];

  constructor(
    private llmFallback: LLMFallback | null,
    private availableCapabilities: () => Capability[],
  ) {
    // Start with system-only commands and rules
    this.commands = { ...SYSTEM_COMMANDS };
    this.rules = [...SYSTEM_RULES];
  }

  /**
   * Register additional slash commands from a domain.
   * Example: addCommands({ '/today': 'list_today', '/tasks': 'list_tasks' })
   */
  addCommands(commands: Record<string, string>): void {
    Object.assign(this.commands, commands);
    logger.debug(COMPONENT, `Added ${Object.keys(commands).length} domain commands.`);
  }

  /**
   * Register additional rule patterns from a domain.
   * These are checked after system rules, in order of registration.
   */
  addRules(rules: RulePattern[]): void {
    this.rules.push(...rules);
    logger.debug(COMPONENT, `Added ${rules.length} domain rules.`);
  }

  async resolve(message: GenericMessage): Promise<ResolvedIntent> {
    const rawText = message.text.trim();

    // Level 1: Explicit commands (use raw text — commands are case-insensitive by design)
    const commandAction = this.resolveCommand(rawText);
    if (commandAction) {
      logger.debug(COMPONENT, `L1 Command: ${commandAction}`, { text: rawText });
      return { action: commandAction, params: {}, source: IntentSource.COMMAND, confidence: 1.0 };
    }

    // Normalize text for rule matching (lowercase, no accents, no trailing punctuation)
    const normalized = normalizeForMatching(rawText);

    // Level 2: Algorithmic rules (against normalized text)
    const ruleResult = this.resolveRule(normalized, rawText);
    if (ruleResult) {
      logger.debug(COMPONENT, `L2 Rule: ${ruleResult.action}`, { text: rawText, normalized });
      return ruleResult;
    }

    // Level 3: Local classifier (reserved for future implementation)

    // Level 4: LLM fallback
    if (this.llmFallback?.isEnabled()) {
      logger.info(COMPONENT, 'L4 LLM Fallback triggered', { text: rawText.substring(0, 80) });
      try {
        const llmResult = await this.llmFallback.classifyIntent(rawText, this.availableCapabilities());
        if (llmResult) {
          return {
            action: llmResult.action,
            params: llmResult.params,
            source: IntentSource.LLM,
            confidence: llmResult.confidence,
          };
        }
      } catch (err) {
        logger.error(COMPONENT, 'LLM fallback failed, falling through to unknown', { error: String(err) });
      }
    }

    // Nothing matched
    logger.debug(COMPONENT, 'No intent matched', { text: rawText, normalized });
    return { action: 'unknown', params: {}, source: IntentSource.UNKNOWN, confidence: 0 };
  }

  private resolveCommand(text: string): string | null {
    const raw = text.split(' ')[0].toLowerCase();
    // Match exact primero. Si falla, intenta sin acentos para tolerar
    // autocorrectores que insertan tildes (ej: "/oración" → "/oracion",
    // "/procrastinación" → "/procrastinacion", "/revisión" → "/revision").
    return this.commands[raw] ?? this.commands[stripAccents(raw)] ?? null;
  }

  private resolveRule(normalizedText: string, rawText: string): ResolvedIntent | null {
    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        const match = normalizedText.match(pattern);
        if (match) {
          const params = rule.extractParams ? rule.extractParams(match, normalizedText, rawText) : {};
          return {
            action: rule.action,
            params,
            source: IntentSource.RULE,
            confidence: 0.9,
          };
        }
      }
    }
    return null;
  }
}
