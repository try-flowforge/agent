import type { FastifyBaseLogger } from 'fastify';
import type { Bot, Context } from 'grammy';
import type { BackendContextClient } from '../../services/backend-client';
import type { LlmServiceClient } from '../../services/planner-client';
import type { PlannerResult } from '../../planner/plan-types';

type BotLogger = Pick<FastifyBaseLogger, 'info' | 'error'>;

export function registerTextMessageHandler(
  bot: Bot,
  logger: BotLogger,
  llmClient: LlmServiceClient,
  backendContextClient: BackendContextClient,
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
      const agentUserId = userId ? `telegram-user-${userId}` : `telegram-chat-${chatId}`;
      let plannerResult = await llmClient.generateWorkflowPlan({
        prompt: text,
        userId: agentUserId,
      });

      if (plannerResult.missingInputs.length > 0) {
        const requestedFields = plannerResult.missingInputs.map((item) => item.field);
        const context = await backendContextClient.fetchPlannerContext({
          userId: agentUserId,
          telegramUserId: userId ? String(userId) : undefined,
          chatId: String(chatId),
          requestedFields,
          prompt: text,
        });

        if (context && Object.keys(context).length > 0) {
          logger.info({ chatId, userId, contextKeys: Object.keys(context) }, 'Refining planner with backend context');
          plannerResult = await llmClient.generateWorkflowPlan({
            prompt: text,
            userId: agentUserId,
            supplementalContext: context,
          });
        }
      }

      await replyInChunks(ctx, formatPlannerReply(plannerResult));
    } catch (error) {
      logger.error(
        {
          chatId,
          userId,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        'Failed to get llm-service response',
      );
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

function formatPlannerReply(plan: PlannerResult): string {
  const lines: string[] = [];
  lines.push(`Draft workflow: ${plan.workflowName}`);
  lines.push(plan.description);
  lines.push('');
  lines.push('Proposed steps:');
  plan.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.blockId} - ${step.purpose}`);
    if (step.configHints) {
      const hints = Object.entries(step.configHints)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      if (hints) {
        lines.push(`   hints: ${hints}`);
      }
    }
  });

  if (plan.missingInputs.length > 0) {
    lines.push('');
    lines.push('I still need:');
    plan.missingInputs.forEach((item) => {
      lines.push(`- ${item.question} (${item.field})`);
    });
  }

  if (plan.notes && plan.notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    plan.notes.forEach((note) => {
      lines.push(`- [${note.type}] ${note.message}${note.field ? ` (${note.field})` : ''}`);
    });
  }

  return lines.join('\n');
}
