/**
 * FlowForge Agent: single entry point for Telegram updates (webhook).
 * Receives all Telegram updates, handles /plan and /execute, verify-* (via backend),
 * and forwards raw updates to the backend ingest for message storage and chat discovery.
 * Frontend and backend use the backend API for Telegram UI; only this service talks to Telegram.
 */
import { createTelegramBot, registerBotHandlers } from './bot/register';
import { loadEnv } from './config/env';
import { createServer, registerWebhookRoute } from './server/create-server';
import { BackendContextClient } from './services/backend-client';
import { LlmServiceClient } from './services/planner-client';

const TELEGRAM_COMMANDS = [
  {
    command: 'plan',
    description: 'Will provide the steps and providers that will be used for the prompt user describes with this command.',
  },
  {
    command: 'execute',
    description: 'Executes already discussed plan or straight away executes according to accompanying prompt.',
  },
] as const;

async function main() {
  const env = loadEnv();
  const server = createServer(env.mode);
  const bot = createTelegramBot(env.telegramBotToken);
  const llmClient = new LlmServiceClient({
    baseUrl: env.llmServiceBaseUrl,
    hmacSecret: env.llmServiceHmacSecret,
    systemPrompt: env.llmSystemPrompt,
    requestTimeoutMs: env.llmRequestTimeoutMs,
  });
  const backendContextClient = new BackendContextClient({
    baseUrl: env.backendBaseUrl,
    serviceKey: env.backendServiceKey,
    contextPath: env.backendContextPath,
    requestTimeoutMs: env.backendRequestTimeoutMs,
  });

  registerBotHandlers(bot, server.log, llmClient, backendContextClient, {
    backendBaseUrl: env.backendBaseUrl,
    backendServiceKey: env.backendServiceKey,
    backendRequestTimeoutMs: env.backendRequestTimeoutMs,
    frontendBaseUrl: env.frontendBaseUrl,
  });

  try {
    await bot.api.setMyCommands([...TELEGRAM_COMMANDS]);
    server.log.info({ commands: TELEGRAM_COMMANDS.map((item) => item.command) }, 'Telegram commands configured');
  } catch (error) {
    server.log.warn({ error }, 'Failed to configure Telegram commands');
  }

  if (env.mode === 'webhook') {
    const ingestConfig =
      env.backendBaseUrl && env.backendServiceKey
        ? {
            backendBaseUrl: env.backendBaseUrl,
            backendServiceKey: env.backendServiceKey,
            requestTimeoutMs: env.backendRequestTimeoutMs,
          }
        : undefined;
    registerWebhookRoute(server, bot, env.telegramWebhookPath, ingestConfig);

    if (env.appBaseUrl) {
      const normalizedBaseUrl = env.appBaseUrl.replace(/\/$/, '');
      const webhookUrl = `${normalizedBaseUrl}${env.telegramWebhookPath}`;
      await bot.api.setWebhook(webhookUrl, {
        secret_token: env.telegramWebhookSecret,
      });
      server.log.info({ webhookUrl }, 'Telegram webhook configured');
    } else {
      server.log.warn('APP_BASE_URL is not set; webhook is not auto-registered');
    }
  }

  try {
    await server.listen({ port: env.port, host: '0.0.0.0' });
    server.log.info({ mode: env.mode, port: env.port }, 'Agent server started');
  } catch (error) {
    server.log.error(error, 'Failed to start server');
    process.exit(1);
  }

  if (env.mode === 'polling') {
    const maxPollRetries = 3;
    for (let attempt = 1; attempt <= maxPollRetries; attempt++) {
      try {
        await bot.api.deleteWebhook({ drop_pending_updates: false });
        server.log.info('Cleared any existing Telegram webhook so polling can receive updates');
      } catch (err) {
        server.log.warn({ err }, 'deleteWebhook failed (non-fatal)');
      }
      server.log.info({ attempt }, 'Starting Telegram bot in long polling mode');
      try {
        await bot.start({
          drop_pending_updates: attempt === 1,
          onStart: () => {
            server.log.info('Telegram bot polling started');
          },
        });
        return;
      } catch (err: unknown) {
        const code = (err as { error_code?: number })?.error_code;
        const isWebhookConflict = code === 409;
        if (isWebhookConflict && attempt < maxPollRetries) {
          server.log.warn(
            { attempt, maxPollRetries },
            'Polling ended due to webhook conflict (another process may have set webhook). Clearing webhook and retrying.',
          );
          continue;
        }
        throw err;
      }
    }
  }
}

main().catch((error) => {
  console.error('Fatal error starting agent:', error);
  process.exit(1);
});
