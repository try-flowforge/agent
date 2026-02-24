import type { FastifyBaseLogger } from 'fastify';
import type { Bot, Context } from 'grammy';
import type { AgentService } from '../../core/agent-service';
import type { PlannerResult } from '../../planner/plan-types';
import type { WorkflowClient } from '../../services/workflow-client';
import { monitorScheduledWorkflow, monitorSingleExecution } from '../../services/execution-monitor';

type BotLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
type SupportedCommand = 'plan' | 'execute';
type ParsedTelegramCommand =
  | { kind: 'supported'; command: SupportedCommand; args: string }
  | { kind: 'unsupported' }
  | { kind: 'not-command' };

export interface TextHandlerBackendConfig {
  backendBaseUrl?: string;
  backendServiceKey?: string;
  backendRequestTimeoutMs?: number;
  frontendBaseUrl?: string;
}

export function registerTextMessageHandler(
  bot: Bot,
  logger: BotLogger,
  agentService: AgentService,
  backendConfig: TextHandlerBackendConfig | undefined,
  workflowClient: WorkflowClient | null,
): void {
  const frontendBaseUrl = backendConfig?.frontendBaseUrl ?? 'https://flowforge.app';
  const supportedCommandsReply = formatSupportedCommandsReply();

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    const text = ctx.message.text;

    logger.info({ chatId, userId, text }, 'Telegram message received');

    const trimmed = text.trim().toLowerCase();
    if (
      trimmed.startsWith('verify-') &&
      backendConfig?.backendBaseUrl &&
      backendConfig?.backendServiceKey
    ) {
      const code = text.trim();
      const chatTitle =
        ctx.chat.title ?? ctx.chat.first_name ?? ctx.chat.username ?? 'Unknown';
      const chatType = ctx.chat.type ?? 'private';
      try {
        const baseUrl = backendConfig.backendBaseUrl.replace(/\/$/, '');
        const res = await fetch(
          `${baseUrl}/api/v1/integrations/telegram/verification/verify-from-agent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-service-key': backendConfig.backendServiceKey,
            },
            body: JSON.stringify({
              code,
              chatId: String(chatId),
              chatTitle,
              chatType,
            }),
            signal: AbortSignal.timeout(
              backendConfig.backendRequestTimeoutMs ?? 30_000,
            ),
          },
        );
        const data = (await res.json()) as {
          success?: boolean;
          message?: string;
        };
        const message =
          typeof data.message === 'string'
            ? data.message
            : data.success
              ? 'Verified.'
              : 'Verification failed.';
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn({ chatId, err }, 'verify-from-agent request failed');
        await ctx.reply(
          'Verification request failed. Please try again later.',
        );
      }
      return;
    }

    const parsedCommand = parseTelegramCommand(text);
    if (parsedCommand.kind === 'unsupported') {
      await ctx.reply(supportedCommandsReply);
      return;
    }
    if (parsedCommand.kind === 'not-command') {
      await ctx.reply(supportedCommandsReply);
      return;
    }

    const agentUserId =
      userId != null
        ? `telegram-user-${userId}`
        : `telegram-chat-${chatId}`;
    const channelIdStr = String(chatId);

    if (parsedCommand.command === 'plan') {
      if (!parsedCommand.args) {
        await ctx.reply(
          'Usage: /plan <prompt>\nExample: /plan Get me the ETH price.',
        );
        return;
      }

      try {
        const result = await agentService.plan({
          prompt: parsedCommand.args,
          userId: agentUserId,
          channelId: channelIdStr,
          channel: 'telegram',
        });

        logger.info(
          {
            chatId,
            userId,
            workflowName: result.plan.workflowName,
            stepCount: result.plan.steps.length,
            missingInputsCount: result.plan.missingInputs.length,
          },
          'Planner result received for /plan',
        );

        await replyInChunks(ctx, formatPlannerReply(result.plan));
      } catch (error) {
        logger.error(
          {
            chatId,
            userId,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          'Failed to get plan from agent core for /plan',
        );
        await ctx.reply(
          'I could not get a response from the planner. Please try again.',
        );
      }
      return;
    }

    if (!workflowClient) {
      await ctx.reply(
        'Workflow execution is not configured (missing BACKEND_BASE_URL). Set it in .env to use /execute.',
      );
      return;
    }

    try {
      const result = await agentService.execute({
        prompt: parsedCommand.args || undefined,
        userId: agentUserId,
        channelId: channelIdStr,
        channel: 'telegram',
      });

      logger.info(
        {
          chatId,
          userId,
          workflowId: result.workflowId,
          executionId: result.executionId,
          timeBlockId: result.timeBlockId,
        },
        'Execute completed from /execute',
      );

      const monitorUserId = result.executionUserId ?? agentUserId;

      if (result.schedule && result.timeBlockId) {
        void monitorScheduledWorkflow({
          bot,
          chatId,
          userId: monitorUserId,
          workflowId: result.workflowId,
          timeBlockId: result.timeBlockId,
          durationSeconds: result.schedule.durationSeconds,
          workflowClient,
          signingBaseUrl: frontendBaseUrl,
          logger,
        }).catch((error) => {
          logger.error(
            {
              chatId,
              workflowId: result.workflowId,
              errorMessage: error instanceof Error ? error.message : String(error),
            },
            'Scheduled workflow monitor crashed',
          );
        });
      } else if (result.executionId) {
        void monitorSingleExecution({
          bot,
          chatId,
          userId: monitorUserId,
          executionId: result.executionId,
          workflowClient,
          signingBaseUrl: frontendBaseUrl,
          logger,
        }).catch((error) => {
          logger.error(
            {
              chatId,
              executionId: result.executionId,
              errorMessage: error instanceof Error ? error.message : String(error),
            },
            'Single execution monitor crashed',
          );
        });
      }
    } catch (error) {
      const message = translateWorkflowError(error);
      logger.error(
        {
          chatId,
          userId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        'Failed to execute from /execute',
      );
      await ctx.reply(message);
    }
  });
}

function parseTelegramCommand(text: string): ParsedTelegramCommand {
  const commandMatch = text
    .trim()
    .match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/);
  if (!commandMatch) {
    return { kind: 'not-command' };
  }

  const command = commandMatch[1].toLowerCase();
  const args = (commandMatch[2] ?? '').trim();

  if (command === 'plan' || command === 'execute') {
    return { kind: 'supported', command, args };
  }

  return { kind: 'unsupported' };
}

function formatSupportedCommandsReply(): string {
  return [
    'Use one of these commands:',
    '/plan <prompt> - Will provide the steps and providers that will be used for the prompt user describes with this command.',
    '/execute [prompt] - Executes already discussed plan or straight away executes according to accompanying prompt.',
  ].join('\n');
}

function translateWorkflowError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (
    raw.includes('Backend base URL is not configured') ||
    raw.includes('BACKEND_BASE_URL')
  ) {
    return 'Workflow backend is not configured. Please try again later or contact support.';
  }

  if (raw.includes('No plan to execute')) {
    return 'No plan found for this chat. Run /plan <prompt> first, or use /execute <prompt>.';
  }

  if (raw.includes('Cannot execute: plan has missing inputs')) {
    return 'Cannot execute yet. Add the missing details, then run /execute <updated prompt>.';
  }

  if (raw.includes('Telegram connection is not linked')) {
    return 'Telegram connection is not linked for this chat. Send your verify-... code first, then run /execute again.';
  }

  const statusMatch = raw.match(
    /Failed to (?:create|execute|fetch)[^:]*:\s*(\d+)\s+(.+)/,
  );
  if (statusMatch) {
    const status = statusMatch[1];
    const body = statusMatch[2].trim();
    type ErrorBody = {
      error?: { message?: string; code?: string; details?: unknown };
    };
    let parsed: ErrorBody | null = null;
    try {
      parsed = JSON.parse(body) as ErrorBody;
    } catch {
      // not JSON
    }

    const msg = parsed?.error?.message;
    if (status === '400') {
      if (msg) return `Validation failed: ${msg.slice(0, 200)}`;
      return 'The workflow or request was invalid. Please adjust your request and try again.';
    }
    if (status === '401' || status === '403') {
      return 'Permission denied. Make sure the agent is allowed to act on your behalf.';
    }
    if (Number(status) >= 500) {
      return 'The backend is temporarily unavailable. Please try again in a moment.';
    }
    if (msg) return msg.slice(0, 300);
  }

  if (
    raw.includes('Unknown planner blockId') ||
    raw.includes('No planner block definition')
  ) {
    return "This workflow uses a block I don't support yet. Try a simpler request.";
  }

  return 'Something went wrong. Please try again or rephrase your request.';
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
      lines.push(
        `- [${note.type}] ${note.message}${note.field ? ` (${note.field})` : ''}`,
      );
    });
  }

  lines.push('');
  if (plan.missingInputs.length > 0) {
    lines.push(
      'Add the missing details, then run /plan <updated prompt> or /execute <updated prompt>.',
    );
  } else {
    lines.push('Run /execute to create and run this workflow.');
  }

  return lines.join('\n');
}
