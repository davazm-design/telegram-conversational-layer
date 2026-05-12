/**
 * Configuration loader.
 * Reads from environment variables with safe defaults.
 */

import * as dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  telegram: {
    botToken: string;
    mode: 'polling' | 'webhook';
    webhookSecret: string;
    publicWebhookUrl: string;
    port: number;
  };
  llm: {
    enabled: boolean;
    provider: string;
    openaiApiKey: string;
  };
  storage: {
    provider: 'memory' | 'postgres';
    databaseUrl: string;
  };
  logLevel: string;
}

function env(key: string, fallback: string = ''): string {
  return process.env[key]?.trim() ?? fallback;
}

function envBool(key: string, fallback: boolean = false): boolean {
  const val = env(key).toLowerCase();
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  return fallback;
}

export function loadConfig(): AppConfig {
  return {
    telegram: {
      botToken: env('TELEGRAM_BOT_TOKEN'),
      mode: (env('TELEGRAM_MODE', 'polling') as 'polling' | 'webhook'),
      webhookSecret: env('WEBHOOK_SECRET'),
      publicWebhookUrl: env('PUBLIC_WEBHOOK_URL'),
      port: parseInt(env('PORT', '3000'), 10),
    },
    llm: {
      enabled: envBool('LLM_ENABLED', false),
      provider: env('LLM_PROVIDER', 'openai'),
      openaiApiKey: env('OPENAI_API_KEY'),
    },
    storage: {
      provider: (env('STORAGE_PROVIDER', 'memory') as 'memory' | 'postgres'),
      databaseUrl: env('DATABASE_URL'),
    },
    logLevel: env('LOG_LEVEL', 'info'),
  };
}
