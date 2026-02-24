import dotenv from 'dotenv';

dotenv.config();

export type BotMode = 'polling' | 'webhook';

const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_BACKEND_REQUEST_TIMEOUT_MS = 30_000;

export interface AppEnv {
  port: number;
  mode: BotMode;
  appBaseUrl?: string;
  /** When unset, Telegram bot and webhook are not registered (uniform API and health still work). */
  telegramBotToken?: string;
  telegramWebhookPath: string;
  telegramWebhookSecret?: string;
  llmServiceBaseUrl: string;
  llmServiceHmacSecret: string;
  llmSystemPrompt?: string;
  /** Request timeout in ms for llm-service calls (planner). */
  llmRequestTimeoutMs: number;
  /** Request timeout in ms for backend API calls (workflows, context). */
  backendRequestTimeoutMs: number;
  backendBaseUrl?: string;
  backendServiceKey?: string;
  backendContextPath: string;
  frontendBaseUrl: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not set`);
  }
  return value;
}

function parseMode(input: string | undefined, appBaseUrl: string | undefined): BotMode {
  if (input === 'webhook') return 'webhook';
  if (appBaseUrl) return 'webhook';
  return 'polling';
}

export function loadEnv(): AppEnv {
  const rawPort = process.env.PORT ?? '8080';
  const port = Number(rawPort);

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be a positive number, got "${rawPort}"`);
  }

  const llmRequestTimeoutMs = parsePositiveInt(
    process.env.LLM_REQUEST_TIMEOUT_MS,
    DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  );
  const backendRequestTimeoutMs = parsePositiveInt(
    process.env.BACKEND_REQUEST_TIMEOUT_MS,
    DEFAULT_BACKEND_REQUEST_TIMEOUT_MS,
  );

  const appBaseUrl = process.env.APP_BASE_URL;
  return {
    port,
    mode: parseMode(process.env.TELEGRAM_MODE, appBaseUrl),
    appBaseUrl,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramWebhookPath: process.env.TELEGRAM_WEBHOOK_PATH ?? '/telegram/webhook',
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    llmServiceBaseUrl: requiredEnv('LLM_SERVICE_BASE_URL'),
    llmServiceHmacSecret: requiredEnv('LLM_SERVICE_HMAC_SECRET'),
    llmSystemPrompt: process.env.LLM_SYSTEM_PROMPT,
    llmRequestTimeoutMs,
    backendRequestTimeoutMs,
    backendBaseUrl: process.env.BACKEND_BASE_URL,
    backendServiceKey: process.env.BACKEND_SERVICE_KEY,
    backendContextPath: process.env.BACKEND_CONTEXT_PATH ?? '/api/v1/agent/context',
    frontendBaseUrl: process.env.FRONTEND_BASE_URL ?? 'https://flowforge.app',
  };
}

function parsePositiveInt(value: string | undefined, defaultVal: number): number {
  if (value === undefined || value === '') return defaultVal;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return n;
}
