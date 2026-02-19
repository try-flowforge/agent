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
  llmProvider: string;
  llmModel: string;
  llmTemperature: number;
  llmSystemPrompt?: string;
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
  const rawTemperature = process.env.LLM_TEMPERATURE ?? '0';
  const llmTemperature = Number(rawTemperature);

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be a positive number, got "${rawPort}"`);
  }
  if (!Number.isFinite(llmTemperature)) {
    throw new Error(`LLM_TEMPERATURE must be a valid number, got "${rawTemperature}"`);
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
    llmProvider: process.env.LLM_PROVIDER ?? 'openrouter',
    llmModel: requiredEnv('LLM_MODEL'),
    llmTemperature,
    llmSystemPrompt: process.env.LLM_SYSTEM_PROMPT,
  };
}
