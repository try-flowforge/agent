import type { FastifyBaseLogger } from 'fastify';
import type { Bot, Context } from 'grammy';
import type { LlmServiceClient } from '../../services/planner-client';

type BotLogger = Pick<FastifyBaseLogger, 'info' | 'error'>;

export function registerTextMessageHandler(
  bot: Bot,
  logger: BotLogger,
  llmClient: LlmServiceClient,
): void {
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    const text = ctx.message.text;

    logger.info({ chatId, userId, text }, 'Telegram message received');
    if (text.startsWith('/')) {
      return;
    }

    try {
      const response = await llmClient.generateWorkflowPlan({
        prompt: text,
        userId: userId ? `telegram-user-${userId}` : `telegram-chat-${chatId}`,
      });
      await replyInChunks(ctx, response);
    } catch (error) {
      logger.error({ error, chatId, userId }, 'Failed to get llm-service response');
      await ctx.reply('I could not get a response from llm-service. Please try again.');
    }
  });
}

async function replyInChunks(ctx: Context, text: string): Promise<void> {
  const maxLength = 4096;
  if (text.length <= maxLength) {
    await ctx.reply(text);
    return;
  }

  for (let index = 0; index < text.length; index += maxLength) {
    const chunk = text.slice(index, index + maxLength);
    await ctx.reply(chunk);
  }
}
