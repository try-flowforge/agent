import type { FastifyBaseLogger } from 'fastify';
import { Bot } from 'grammy';
import { registerStartCommand } from './commands/start';
import { registerTextMessageHandler } from './handlers/text-message';
import type { BackendContextClient } from '../services/backend-client';
import type { LlmServiceClient } from '../services/planner-client';

type BotLogger = Pick<FastifyBaseLogger, 'info' | 'error'>;

export function createTelegramBot(token: string): Bot {
  return new Bot(token);
}

export function registerBotHandlers(
  bot: Bot,
  logger: BotLogger,
  llmClient: LlmServiceClient,
  backendContextClient: BackendContextClient,
): void {
  registerStartCommand(bot);
  registerTextMessageHandler(bot, logger, llmClient, backendContextClient);

  bot.catch((error) => {
    logger.error({ error }, 'Telegram bot error');
  });
}
