/**
 * Console Simulator — test the full pipeline without Telegram.
 *
 * Usage:
 *   npm run simulate                    # default: todo domain
 *   DOMAIN=todo npm run simulate        # explicit: todo domain
 *   DOMAIN=adhd-coach npm run simulate  # adhd-coach domain
 *
 * This uses the ConsoleAdapter instead of TelegramAdapter,
 * routing all messages through the exact same pipeline.
 */

import { loadConfig } from './core/config';
import { setLogLevel } from './core/logger';
import { ConsoleAdapter } from './adapter/console.adapter';
import { Orchestrator, getDomainRegistry } from './index';
import { MemoryStorageProvider } from './core/storage/memory.storage';

async function main(): Promise<void> {
  const config = loadConfig();
  // Override: use console, disable Telegram requirement
  config.telegram.botToken = 'SIMULATOR_MODE';
  setLogLevel(config.logLevel);

  const storage = new MemoryStorageProvider();

  // Domain selection
  const domainKey = (process.env.DOMAIN ?? 'todo').toLowerCase();
  
  await storage.connect(domainKey);

  const registry = getDomainRegistry(storage);
  const domainFactory = registry[domainKey];

  if (!domainFactory) {
    console.error(`ERROR: Unknown domain "${domainKey}". Available: ${Object.keys(registry).join(', ')}`);
    process.exit(1);
  }

  const domain = domainFactory();

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║    🧪 Telegram Conversational Layer — Simulator     ║');
  console.log('║                                                      ║');
  console.log('║  Type messages as if you were chatting on Telegram.  ║');
  console.log('║  Commands: /start /help /status /cancel              ║');
  console.log('║  Type "exit" to quit.                                ║');
  console.log('║                                                      ║');
  console.log(`║  Domain:       ${domain.domainName.padEnd(36)}  ║`);
  console.log(`║  LLM Fallback: ${config.llm.enabled ? '✅ ENABLED' : '❌ DISABLED'}                          ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  const adapter = new ConsoleAdapter('sim-user');
  const orchestrator = new Orchestrator(adapter, domain, config, storage.sessionStore);

  await orchestrator.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
