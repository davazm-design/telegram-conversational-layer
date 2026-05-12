/**
 * Core type definitions for the Universal Telegram Conversational Layer.
 *
 * These interfaces define the contracts between all modules.
 * No module should depend on Telegram-specific types directly — only on these.
 */

// ─── Messages ────────────────────────────────────────────────────────────────

/** A normalized, adapter-agnostic message. */
export interface GenericMessage {
  /** Unique message ID from the source platform. */
  id: string;
  /** User/chat identifier. */
  userId: string;
  /** Chat identifier (may differ from userId in groups). */
  chatId: string;
  /** Raw text content of the message. */
  text: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Optional metadata from the adapter (e.g. reply info, media). */
  metadata?: Record<string, unknown>;
}

/** The response to send back through the adapter. */
export interface GenericResponse {
  /** The chat to respond to. */
  chatId: string;
  /** The text body of the response. */
  text: string;
  /** Optional parse mode (Markdown, HTML). */
  parseMode?: 'Markdown' | 'HTML';
}

// ─── Intents ─────────────────────────────────────────────────────────────────

/** How the intent was resolved. */
export enum IntentSource {
  COMMAND = 'command',
  RULE = 'rule',
  CLASSIFIER = 'classifier',
  LLM = 'llm',
  CONFIRMATION = 'confirmation',
  UNKNOWN = 'unknown',
}

/** A resolved intent from the router. */
export interface ResolvedIntent {
  /** The capability name to invoke (e.g. "list_today", "create_task"). */
  action: string;
  /** Extracted parameters for the action. */
  params: Record<string, unknown>;
  /** How the intent was resolved. */
  source: IntentSource;
  /** Confidence score (0-1). Only meaningful for classifier/LLM sources. */
  confidence: number;
}

// ─── Capabilities ────────────────────────────────────────────────────────────

/** Risk classification for policy enforcement. */
export enum RiskLevel {
  READ_ONLY = 'READ_ONLY',
  LOW_RISK_WRITE = 'LOW_RISK_WRITE',
  MEDIUM_RISK_WRITE = 'MEDIUM_RISK_WRITE',
  HIGH_RISK_ACTION = 'HIGH_RISK_ACTION',
}

/** Schema for a single parameter of a capability. */
export interface ParameterSchema {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  required?: boolean;
  enum?: string[];
}

/** A single capability offered by a domain. */
export interface Capability {
  /** Unique action name. Must be snake_case. */
  name: string;
  /** Human-readable description (used in LLM prompts and /help). */
  description: string;
  /** Parameters the action accepts. */
  parameters: Record<string, ParameterSchema>;
  /** Risk classification for policy decisions. */
  riskLevel: RiskLevel;
  /** Whether the action always requires explicit user confirmation. */
  requiresConfirmation: boolean;
}

// ─── Rule Pattern ────────────────────────────────────────────────────────────

/** A regex-based rule for Level 2 intent routing. */
export interface RulePattern {
  /** One or more regex patterns to match. */
  patterns: RegExp[];
  /** The action name to map to if a pattern matches. */
  action: string;
  /** Optional: extract parameters from the matched text. */
  extractParams?: (match: RegExpMatchArray, normalizedText: string, rawText: string) => Record<string, unknown>;
}

// ─── Domain Handler ──────────────────────────────────────────────────────────

/** Result of executing a domain action. */
export interface ActionResult {
  success: boolean;
  message: string;
  data?: unknown;
  /**
   * Opcional: tras enviar `message` al usuario, el orquestador setea este
   * `pending_input` para que el SIGUIENTE mensaje del usuario sea tratado
   * como valor del parámetro indicado. Útil para flujos conversacionales
   * multi-paso (ej: /agenda → dump → selection).
   *
   * Slash commands escapan pending_input (fix global existente), así que el
   * usuario puede salirse del flujo en cualquier momento.
   */
  pendingInput?: { action: string; paramName: string; prompt: string };
}

/**
 * Contract that every domain must implement.
 * This is the single integration point between the core layer and your project.
 */
export interface IDomainHandler {
  /** Human-readable domain name (e.g. "Todo", "Trading"). */
  readonly domainName: string;

  /** Returns the full list of capabilities this domain supports. */
  getCapabilities(): Capability[];

  /**
   * Executes an action within the domain.
   * @param action - The capability name.
   * @param params - Resolved parameters.
   * @param userId - The user requesting the action.
   */
  execute(action: string, params: Record<string, unknown>, userId: string): Promise<ActionResult>;

  /**
   * Optional: Returns a brief status summary for the user.
   * Used by /status and as LLM context.
   */
  getStatusSummary?(userId: string): Promise<string>;

  /**
   * Optional: Returns slash commands specific to this domain.
   * Example: { '/today': 'list_today', '/tasks': 'list_tasks' }
   */
  getCommands?(): Record<string, string>;

  /**
   * Optional: Returns regex-based rules specific to this domain.
   * These are checked at Level 2 of the intent router.
   */
  getRules?(): RulePattern[];

  /**
   * Optional: Proactive tick driver. The orchestrator host calls this on a
   * fixed interval (e.g. 60s) so the domain can dispatch scheduled events
   * (reminders, nudges, etc.) without coupling to the adapter.
   *
   * IMPORTANT: proactive messages bypass the crisis pre-filter on purpose
   * (the pre-filter exists to intercept user inputs, not outbound nudges).
   */
  tick?(send: (userId: string, text: string) => Promise<void>): Promise<void>;

  /**
   * Optional: Texto de /help curado por el dominio. Si está presente, el
   * orquestador lo usa en lugar del listado autogenerado de capabilities
   * (que mostraría nombres internos como "add_reminder").
   */
  getHelpText?(): string;

  /**
   * Optional: Mensaje del dominio cuando el router no resuelve la intención.
   * Reemplaza al genérico "No entendí tu mensaje..." con uno que guíe al
   * usuario hacia lo que sí entiende.
   */
  getFallbackMessage?(): string;
}

// ─── LLM Provider ────────────────────────────────────────────────────────────

/** Structured output expected from the LLM fallback. */
export interface LLMIntentResult {
  action: string;
  params: Record<string, unknown>;
  confidence: number;
  reasoning?: string;
}

/** Abstract LLM provider interface. */
export interface ILLMProvider {
  readonly providerName: string;

  /**
   * Classifies user intent given a message and available capabilities.
   * Must return structured JSON, not free text.
   */
  classifyIntent(
    message: string,
    capabilities: Capability[],
    context?: string
  ): Promise<LLMIntentResult>;
}

// ─── Session ─────────────────────────────────────────────────────────────────

/** A pending action awaiting user confirmation. */
export interface PendingAction {
  intent: ResolvedIntent;
  /** Human-readable description of what will happen. */
  description: string;
  /** When this pending action was created (ISO-8601). */
  createdAt: string;
}

/** Session state for a single user. */
export interface UserSession {
  userId: string;
  /** Currently pending action awaiting confirmation. */
  pendingAction?: PendingAction;
  /** Arbitrary domain-specific context. */
  context: Record<string, unknown>;
  /** Last activity timestamp. */
  lastActivity: string;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/** The messaging adapter interface. Telegram is one implementation. */
export interface IMessageAdapter {
  /** Start listening for messages. */
  start(handler: (msg: GenericMessage) => Promise<void>): Promise<void>;
  /** Send a response. */
  sendResponse(response: GenericResponse): Promise<void>;
  /** Graceful shutdown. */
  stop(): Promise<void>;
}
