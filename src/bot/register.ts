import type { FastifyBaseLogger } from 'fastify';
import { Bot } from 'grammy';
import { registerStartCommand } from './commands/start';
import { registerTextMessageHandler } from './handlers/text-message';

type BotLogger = Pick<FastifyBaseLogger, 'info' | 'error'>;

export function createTelegramBot(token: string): Bot {
  return new Bot(token);
}

export function registerBotHandlers(bot: Bot, logger: BotLogger): void {
  registerStartCommand(bot);
  registerTextMessageHandler(bot, logger);

  bot.catch((error) => {
    logger.error({ error }, 'Telegram bot error');
  });
}
