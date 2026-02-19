import { createTelegramBot, registerBotHandlers } from './bot/register';
import { loadEnv } from './config/env';
import { createServer, registerWebhookRoute } from './server/create-server';
import { BackendContextClient } from './services/backend-client';
import { LlmServiceClient } from './services/planner-client';

async function main() {
  const env = loadEnv();
  const server = createServer(env.mode);
  const bot = createTelegramBot(env.telegramBotToken);
  const llmClient = new LlmServiceClient({
    baseUrl: env.llmServiceBaseUrl,
    hmacSecret: env.llmServiceHmacSecret,
    systemPrompt: env.llmSystemPrompt,
  });
  const backendContextClient = new BackendContextClient({
    baseUrl: env.backendBaseUrl,
    serviceKey: env.backendServiceKey,
    contextPath: env.backendContextPath,
  });

  registerBotHandlers(bot, server.log, llmClient, backendContextClient);

  if (env.mode === 'webhook') {
    registerWebhookRoute(server, bot, env.telegramWebhookPath);

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
    server.log.info('Starting Telegram bot in long polling mode');
    await bot.start({
      drop_pending_updates: true,
      onStart: () => {
        server.log.info('Telegram bot polling started');
      },
    });
  }
}

main().catch((error) => {
  console.error('Fatal error starting agent:', error);
  process.exit(1);
});
