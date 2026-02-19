import type { FastifyBaseLogger } from 'fastify';
import { Bot } from 'grammy';
import { registerStartCommand } from './commands/start';
import { registerTextMessageHandler } from './handlers/text-message';
import type { LlmServiceClient } from '../services/planner-client';

type BotLogger = Pick<FastifyBaseLogger, 'info' | 'error'>;

export function createTelegramBot(token: string): Bot {
  return new Bot(token);
}

export function registerBotHandlers(bot: Bot, logger: BotLogger, llmClient: LlmServiceClient): void {
  registerStartCommand(bot);
  registerTextMessageHandler(bot, logger, llmClient);

  bot.catch((error) => {
    logger.error({ error }, 'Telegram bot error');
  });
}
