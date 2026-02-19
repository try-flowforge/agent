import dotenv from 'dotenv';

dotenv.config();

export type BotMode = 'polling' | 'webhook';

export interface AppEnv {
  port: number;
  mode: BotMode;
  appBaseUrl?: string;
  telegramBotToken: string;
  telegramWebhookPath: string;
  telegramWebhookSecret?: string;
  llmServiceBaseUrl: string;
  llmServiceHmacSecret: string;
  llmSystemPrompt?: string;
  backendBaseUrl?: string;
  backendServiceKey?: string;
  backendContextPath: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not set`);
  }
  return value;
}

function parseMode(input: string | undefined): BotMode {
  return input === 'webhook' ? 'webhook' : 'polling';
}

export function loadEnv(): AppEnv {
  const rawPort = process.env.PORT ?? '8080';
  const port = Number(rawPort);

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be a positive number, got "${rawPort}"`);
  }

  return {
    port,
    mode: parseMode(process.env.TELEGRAM_MODE),
    appBaseUrl: process.env.APP_BASE_URL,
    telegramBotToken: requiredEnv('TELEGRAM_BOT_TOKEN'),
    telegramWebhookPath: process.env.TELEGRAM_WEBHOOK_PATH ?? '/telegram/webhook',
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    llmServiceBaseUrl: requiredEnv('LLM_SERVICE_BASE_URL'),
    llmServiceHmacSecret: requiredEnv('LLM_SERVICE_HMAC_SECRET'),
    llmSystemPrompt: process.env.LLM_SYSTEM_PROMPT,
    backendBaseUrl: process.env.BACKEND_BASE_URL,
    backendServiceKey: process.env.BACKEND_SERVICE_KEY,
    backendContextPath: process.env.BACKEND_CONTEXT_PATH ?? '/api/v1/agent/context',
  };
}
