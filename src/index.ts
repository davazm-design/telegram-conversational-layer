/**
 * Main Orchestrator — wires all components together and processes messages.
 *
 * This is the central pipeline:
 * Message → Session → [PendingInput check] → [Confirmation check] → Intent Router → Policy Engine → Execute → Respond
 *
 * The Orchestrator is domain-agnostic: it receives an IDomainHandler via constructor injection.
 *
 * PENDING INPUT: When an action requires follow-up text (e.g. "agregar tarea" without task text),
 * the orchestrator stores a pending_input in the session. The next message from the user
 * is treated as the missing parameter, and the action is executed automatically.
 */

import {
  IMessageAdapter,
  GenericMessage,
  GenericResponse,
  IDomainHandler,
  IntentSource,
} from './core/types';
import { AppConfig, loadConfig } from './core/config';
import { SessionManager } from './core/session.manager';
import { CapabilityRegistry } from './registry/capability.registry';
import { IntentRouter, PendingInput } from './router/intent.router';
import { PolicyEngine, PolicyDecision } from './security/policy.engine';
import { LLMFallback } from './llm/llm.fallback';
import { OpenAIProvider } from './llm/openai.provider';
import { ResponseFormatter } from './core/response.formatter';
import { TelegramAdapter } from './adapter/telegram.adapter';
import { logger, setLogLevel } from './core/logger';
import { CrisisDetector, CRISIS_FIXED_MESSAGE } from './security/crisis.detector';

const COMPONENT = 'Orchestrator';



export class Orchestrator {
  private adapter: IMessageAdapter;
  private sessions: SessionManager;
  private registry: CapabilityRegistry;
  private router: IntentRouter;
  private policy: PolicyEngine;
  private formatter: ResponseFormatter;
  private crisisDetector: CrisisDetector;
  private domainName: string = 'Asistente';
  // Referencia al dominio para acceder a getHelpText/getFallbackMessage
  // opcionales. El registry guarda handlers por capability; aquí queremos el
  // handler del dominio principal para textos curados (help + fallback).
  private domainHandler: IDomainHandler;

  constructor(
    adapter: IMessageAdapter,
    domainHandler: IDomainHandler,
    config: AppConfig,
    sessionStore: ISessionStore,
    // Pre-filtro transversal de seguridad. Por defecto se construye uno
    // genérico (CrisisDetector con keywords ES). Pasar una instancia propia
    // permite localización / desactivación futura sin tocar core.
    crisisDetector: CrisisDetector = new CrisisDetector(),
  ) {
    this.adapter = adapter;
    this.sessions = new SessionManager(sessionStore);
    this.registry = new CapabilityRegistry();
    this.policy = new PolicyEngine();
    this.formatter = new ResponseFormatter();
    this.crisisDetector = crisisDetector;
    this.domainName = domainHandler.domainName;
    this.domainHandler = domainHandler;

    // Register domain capabilities
    this.registry.registerDomain(domainHandler);

    // Build LLM fallback (optional)
    let llmFallback: LLMFallback | null = null;
    if (config.llm.enabled) {
      try {
        const provider = new OpenAIProvider(config.llm.openaiApiKey);
        llmFallback = new LLMFallback(config.llm, provider);
      } catch (err) {
        logger.warn(COMPONENT, 'Failed to initialize LLM provider, continuing without it.', { error: String(err) });
        llmFallback = new LLMFallback({ ...config.llm, enabled: false });
      }
    } else {
      llmFallback = new LLMFallback(config.llm);
    }

    // Build router
    this.router = new IntentRouter(
      llmFallback,
      () => this.registry.getAllCapabilities(),
    );

    // Register domain-specific commands and rules (if provided)
    if (domainHandler.getCommands) {
      this.router.addCommands(domainHandler.getCommands());
    }
    if (domainHandler.getRules) {
      this.router.addRules(domainHandler.getRules());
    }
  }

  async start(): Promise<void> {
    await this.adapter.start(this.handleMessage.bind(this));
    logger.info(COMPONENT, 'Orchestrator started.');
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
    logger.info(COMPONENT, 'Orchestrator stopped.');
  }

  /**
   * Envía un mensaje proactivo (sin pasar por el pipeline de entrada).
   * Usado por el tick del dominio para recordatorios programados.
   */
  async sendProactive(userId: string, text: string): Promise<void> {
    // Convención actual: chatId === userId para Telegram personal.
    // Si en el futuro divergen, el dominio debería persistir su propio mapping.
    await this.adapter.sendResponse({ chatId: userId, text, parseMode: 'Markdown' });
  }

  private async handleMessage(msg: GenericMessage): Promise<void> {
    try {
      // ── Step -1: A5 Crisis pre-filter (system-wide, all domains) ────────
      // Se ejecuta ANTES de cualquier otro paso. Si dispara:
      //   - limpia pending_input y pending_action
      //   - emite el mensaje fijo de derivación
      //   - NO pasa por router, policy, domain handler ni LLM
      //   - NO se registra el contenido del mensaje (solo userId + flag)
      if (this.crisisDetector.isCrisis(msg.text)) {
        await this.sessions.clearContext(msg.userId, 'pending_input');
        await this.sessions.clearPendingAction(msg.userId);
        logger.warn(COMPONENT, 'Crisis pre-filter triggered; routing skipped', {
          userId: msg.userId,
        });
        return this.respond(msg.chatId, CRISIS_FIXED_MESSAGE);
      }

      // ── Step 0: Check for pending input ──────────────────────────────────
      // If the user has a pending_input, the NEXT message is treated as the missing parameter.
      // Exceptions (escape hatches): /cancel, "cancelar", o CUALQUIER slash command.
      //
      // Rationale: si el usuario escribe /algo, claramente quiere ejecutar un
      // comando, no entregar texto al flujo pendiente. Sin esta excepción, un
      // pending_input persistido (p.ej. en Postgres, sobreviviente a reinicios)
      // se tragaba slash commands posteriores y dejaba al bot mudo.
      const pendingInput = await this.sessions.getContext(msg.userId, 'pending_input') as PendingInput | undefined;
      if (pendingInput) {
        const rawText = msg.text.trim();
        const lower = rawText.toLowerCase();
        const isSlashCommand = rawText.startsWith('/');

        // Allow /cancel and "cancelar" to break out of pending input
        if (lower === '/cancel' || lower === 'cancelar') {
          await this.sessions.clearContext(msg.userId, 'pending_input');
          return this.respond(msg.chatId, '✅ Acción cancelada.');
        }

        // Any slash command escapes pending_input: clear it and fall through
        // to normal routing so the command runs as usual.
        if (isSlashCommand) {
          await this.sessions.clearContext(msg.userId, 'pending_input');
          logger.info(COMPONENT, 'pending_input cleared by slash command escape', {
            userId: msg.userId, command: rawText.split(' ')[0],
          });
          // Fall through — no return — para que la pipeline procese el comando.
        } else {
          // Use raw text as the parameter value (preserve original casing/accents for task text)
          const params: Record<string, unknown> = { [pendingInput.paramName]: rawText };

          // Clear pending input BEFORE executing (to prevent loops)
          await this.sessions.clearContext(msg.userId, 'pending_input');

          // Execute the action
          const result = await this.registry.executeAction(pendingInput.action, params, msg.userId);
          return this.respond(msg.chatId, this.formatter.formatResult(result));
        }
      }

      // ── Step 1: Resolve intent ─────────────────────────────────────────
      const intent = await this.router.resolve(msg);

      // ── Step 2: Handle system actions ──────────────────────────────────
      if (intent.action === 'system_start') {
        return this.respond(msg.chatId, this.formatter.formatWelcome(this.domainName));
      }

      if (intent.action === 'system_help') {
        // Si el dominio expone getHelpText (texto curado para usuario final)
        // lo usamos. Si no, caemos al listado autogenerado de capabilities.
        if (this.domainHandler.getHelpText) {
          return this.respond(msg.chatId, this.domainHandler.getHelpText());
        }
        return this.respond(msg.chatId, this.formatter.formatHelp(
          this.registry.getAllCapabilities(),
          this.domainName,
        ));
      }

      if (intent.action === 'system_cancel') {
        const hadPending = await this.sessions.clearPendingAction(msg.userId);
        return this.respond(msg.chatId, this.formatter.formatCancelled(hadPending));
      }

      if (intent.action === 'system_status') {
        const handler = this.registry.getHandler(
          this.registry.getAllCapabilities()[0]?.name ?? '',
        );
        if (handler?.getStatusSummary) {
          const summary = await handler.getStatusSummary(msg.userId);
          return this.respond(msg.chatId, `📊 *Estado:* ${summary}`);
        }
        return this.respond(msg.chatId, 'ℹ️ No hay información de estado disponible.');
      }

      // ── Step 3: Handle confirmation flow ───────────────────────────────
      if (intent.action === 'system_confirm') {
        const pendingAction = await this.sessions.consumePendingAction(msg.userId);
        if (!pendingAction) {
          return this.respond(msg.chatId, 'ℹ️ No hay ninguna acción pendiente para confirmar.');
        }
        const result = await this.registry.executeAction(
          pendingAction,
          {},
          msg.userId,
        );
        return this.respond(msg.chatId, this.formatter.formatResult(result));
      }

      // ── Step 4: Handle unknown intent ──────────────────────────────────
      if (intent.action === 'unknown') {
        // Si el dominio expone getFallbackMessage (texto que orienta al
        // usuario hacia lo que sí entiende), lo usamos en vez del genérico.
        const fallback = this.domainHandler.getFallbackMessage
          ? this.domainHandler.getFallbackMessage()
          : this.formatter.formatUnknown();
        return this.respond(msg.chatId, fallback);
      }

      // ── Step 4.5: Check for incomplete input (pending_input) ───────────
      // If the action requires a string parameter and it's empty,
      // store pending_input and ask the user for the missing text.
      const capability = this.registry.getCapability(intent.action);
      if (capability) {
        const missingParam = Object.entries(capability.parameters).find(
          ([key, schema]) => schema.required && schema.type === 'string' && !String(intent.params[key] ?? '').trim()
        );

        if (missingParam) {
          const [paramName, schema] = missingParam;
          const prompt = `📝 Claro. ¿Cuál es el ${schema.description?.toLowerCase() ?? paramName}?`;
          
          const pendingInputData: PendingInput = {
            action: intent.action,
            paramName,
            prompt,
          };
          await this.sessions.setContext(msg.userId, 'pending_input', pendingInputData);
          logger.info(COMPONENT, 'Pending input set', { userId: msg.userId, action: intent.action });
          return this.respond(msg.chatId, prompt);
        }
      }

      // ── Step 5: Policy evaluation ──────────────────────────────────────
      const policyResult = this.policy.evaluate(intent, capability);
      const forceLowConfidence = this.policy.shouldConfirmLowConfidence(intent);

      if (policyResult.decision === PolicyDecision.DENY) {
        return this.respond(msg.chatId, `🚫 ${policyResult.reason}`);
      }

      if (policyResult.decision === PolicyDecision.CONFIRM || forceLowConfidence) {
        const description = capability
          ? `*${capability.description}*\n${this.formatParams(intent.params)}`
          : intent.action;
        await this.sessions.setPendingAction(msg.userId, intent, description);
        return this.respond(msg.chatId, this.formatter.formatConfirmation(description));
      }

      // ── Step 6: Execute ────────────────────────────────────────────────
      const result = await this.registry.executeAction(intent.action, intent.params, msg.userId);
      return this.respond(msg.chatId, this.formatter.formatResult(result));

    } catch (err) {
      logger.error(COMPONENT, 'Unhandled error in message pipeline', { error: String(err) });
      return this.respond(msg.chatId, '⚠️ Ocurrió un error inesperado. Inténtalo de nuevo.');
    }
  }

  private async respond(chatId: string, text: string): Promise<void> {
    await this.adapter.sendResponse({ chatId, text, parseMode: 'Markdown' });
  }

  private formatParams(params: Record<string, unknown>): string {
    const entries = Object.entries(params).filter(([_, v]) => v !== undefined && v !== '');
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `  • ${k}: ${v}`).join('\n');
  }
}

import { IStorageProvider, ISessionStore } from './core/storage/interfaces';
import { MemoryStorageProvider } from './core/storage/memory.storage';
import { PostgresStorageProvider } from './core/storage/postgres.storage';

// ─── Domain Registry (for CLI selection) ─────────────────────────────────────

/** Map of available domains for the main() entry point and simulator. */
export function getDomainRegistry(storage: IStorageProvider): Record<string, () => IDomainHandler> {
  // Lazy imports to avoid coupling at module level
  return {
    'todo': () => {
      const { TodoDomainHandler } = require('./examples/todo.domain');
      return new TodoDomainHandler(storage.todoStore);
    },
    'adhd-coach': () => {
      const { AdhdCoachDomainHandler } = require('./examples/adhd-coach.domain');
      return new AdhdCoachDomainHandler(storage.adhdCoachStore);
    },
  };
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // Last-resort guards: NO debemos morir por una rejection huérfana o un
  // throw asíncrono en un callback. Si algo así pasa, lo logueamos y
  // seguimos. Crashes de verdad (memoria, etc.) los maneja el runtime.
  process.on('unhandledRejection', (reason) => {
    logger.error(COMPONENT, 'Unhandled promise rejection (container kept alive)', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error(COMPONENT, 'Uncaught exception (container kept alive)', { error: String(err), stack: (err as Error)?.stack });
  });

  logger.info(COMPONENT, 'Starting Universal Telegram Conversational Layer...');

  if (!config.telegram.botToken) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and configure it.');
    process.exit(1);
  }

  // Initialize storage
  let storage: IStorageProvider;
  if (config.storage.provider === 'postgres') {
    logger.info(COMPONENT, 'Initializing PostgreSQL Storage Provider');
    storage = new PostgresStorageProvider(config.storage.databaseUrl);
  } else {
    logger.info(COMPONENT, 'Initializing Memory Storage Provider');
    storage = new MemoryStorageProvider();
  }
  // Domain selection via DOMAIN env var (default: todo)
  const domainKey = (process.env.DOMAIN ?? 'todo').toLowerCase();

  await storage.connect(domainKey);

  const registry = getDomainRegistry(storage);
  const domainFactory = registry[domainKey];

  if (!domainFactory) {
    console.error(`ERROR: Unknown domain "${domainKey}". Available: ${Object.keys(registry).join(', ')}`);
    process.exit(1);
  }

  const domain = domainFactory();
  logger.info(COMPONENT, `Domain: ${domain.domainName}`);

  const adapter = new TelegramAdapter(config);
  const orchestrator = new Orchestrator(adapter, domain, config, storage.sessionStore);

  // ── Proactive tick driver (recordatorios, nudges) ────────────────────────
  // El dominio expone tick(send) opcional. Lo llamamos cada 60s.
  // Si el dominio no implementa tick, se omite.
  let tickTimer: NodeJS.Timeout | null = null;
  if (typeof domain.tick === 'function') {
    const TICK_MS = 60_000;
    const runTick = async () => {
      try {
        await domain.tick!((uid, text) => orchestrator.sendProactive(uid, text));
      } catch (err) {
        logger.error(COMPONENT, 'Tick failed', { error: String(err) });
      }
    };
    tickTimer = setInterval(runTick, TICK_MS);
    logger.info(COMPONENT, `Proactive tick enabled (${TICK_MS} ms).`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info(COMPONENT, 'Shutting down...');
    if (tickTimer) clearInterval(tickTimer);
    await orchestrator.stop();
    await storage.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await orchestrator.start();
}

// Only run main() if this file is executed directly (not imported)
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
