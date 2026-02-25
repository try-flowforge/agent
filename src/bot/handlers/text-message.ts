import type { FastifyBaseLogger } from 'fastify';
import type { Bot, Context } from 'grammy';
import type { AgentService } from '../../core/agent-service';
import type { WorkflowClient } from '../../services/workflow-client';
import { monitorScheduledWorkflow, monitorSingleExecution } from '../../services/execution-monitor';
import {
  ORACLE_TEMPLATE_TOKENS,
  buildOraclePlan,
  type OracleTemplateToken,
} from '../../templates/oracle-template';

type BotLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
type SupportedCommand = 'oracle' | 'swap' | 'aave' | 'perp';
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

    if (parsedCommand.command === 'oracle') {
      await handleOracleCommand(ctx, {
        logger,
        agentUserId,
        channelIdStr,
        agentService,
      });
      return;
    }

    if (
      parsedCommand.command === 'swap' ||
      parsedCommand.command === 'aave' ||
      parsedCommand.command === 'perp'
    ) {
      await ctx.reply('Coming soon.');
      return;
    }
  });
}

export function registerOracleCallbackHandler(
  bot: Bot,
  logger: BotLogger,
  agentService: AgentService,
  backendConfig: TextHandlerBackendConfig | undefined,
  workflowClient: WorkflowClient | null,
): void {
  const frontendBaseUrl = backendConfig?.frontendBaseUrl ?? 'https://flowforge.app';

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data ?? '';
    if (!data.startsWith('oracle:')) {
      return;
    }

    const tokenId = data.slice('oracle:'.length);
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;

    if (chatId == null) {
      await ctx.answerCallbackQuery({
        text: 'Missing chat context for oracle selection.',
        show_alert: true,
      });
      return;
    }

    const token = ORACLE_TEMPLATE_TOKENS.find((t) => t.id === tokenId);
    if (!token) {
      await ctx.answerCallbackQuery({
        text: 'Unknown token selection.',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    const agentUserId =
      userId != null ? `telegram-user-${userId}` : `telegram-chat-${chatId}`;
    const channelIdStr = String(chatId);

    if (!workflowClient) {
      await ctx.reply(
        'Workflow execution is not configured (missing BACKEND_BASE_URL). Set it in .env to use /oracle.',
      );
      return;
    }

    try {
      const result = await agentService.execute({
        plan: buildOraclePlan(token),
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
          tokenId: token.id,
        },
        'Oracle execute completed from callback',
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
            'Scheduled workflow monitor crashed (oracle)',
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
            'Single execution monitor crashed (oracle)',
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
        'Failed to execute oracle template from callback',
      );
      await ctx.reply(`Oracle template failed: ${message}`);
    }
  });
}

async function handleOracleCommand(
  ctx: Context,
  options: {
    logger: BotLogger;
    agentUserId: string;
    channelIdStr: string;
    agentService: AgentService;
  },
): Promise<void> {
  const {
    logger,
    agentUserId,
    channelIdStr,
    agentService,
  } = options;
  const chatId = ctx.chat?.id;
  if (chatId == null) {
    await ctx.reply('Missing chat context for this command.');
    return;
  }

  const tokens = ORACLE_TEMPLATE_TOKENS;
  if (!tokens.length) {
    await ctx.reply(
      'Could not load the list of supported tokens. Please try again later.',
    );
    return;
  }

  const keyboard = buildOracleTokenKeyboard(tokens);
  await ctx.reply(
    'Choose a token on Arbitrum to fetch its Chainlink price:',
    { reply_markup: { inline_keyboard: keyboard } },
  );
}

function buildOracleTokenKeyboard(
  tokens: OracleTemplateToken[],
): Array<Array<{ text: string; callback_data: string }>> {
  const maxButtonsPerRow = 3;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < tokens.length; i += maxButtonsPerRow) {
    const row = tokens
      .slice(i, i + maxButtonsPerRow)
      .map((t) => ({
        text: t.symbol,
        callback_data: `oracle:${t.id}`,
      }));
    rows.push(row);
  }
  return rows;
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

  if (command === 'oracle' || command === 'swap' || command === 'aave' || command === 'perp') {
    return { kind: 'supported', command, args };
  }

  return { kind: 'unsupported' };
}

function formatSupportedCommandsReply(): string {
  return [
    'Use one of these commands:',
    '/oracle – Fetch token price via Chainlink on Arbitrum',
    '/swap – Swap tokens using Li.Fi (coming soon)',
    '/aave – Lend/borrow using Aave (coming soon)',
    '/perp – Open a perp position using Ostium (coming soon)',
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
    return 'No plan found for this chat. Use one of the template commands like /oracle.';
  }

  if (raw.includes('Cannot execute: plan has missing inputs')) {
    return 'Cannot execute yet. Please try again with a simpler request or adjust your template choice.';
  }

  if (raw.includes('Telegram connection is not linked')) {
    return 'Telegram connection is not linked for this chat. Send your verify-... code first, then try again.';
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
