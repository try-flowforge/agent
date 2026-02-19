import type { FastifyBaseLogger } from 'fastify';
import type { Bot } from 'grammy';

type BotLogger = Pick<FastifyBaseLogger, 'info'>;

export function registerTextMessageHandler(bot: Bot, logger: BotLogger): void {
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    const text = ctx.message.text;

    logger.info({ chatId, userId, text }, 'Telegram message received');
    await ctx.reply('Received. Your message has been logged by the agent server.');
  });
}
