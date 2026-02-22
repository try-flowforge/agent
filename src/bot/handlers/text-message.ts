import type { FastifyBaseLogger } from 'fastify';
import type { Bot, Context } from 'grammy';
import type { BackendContextClient } from '../../services/backend-client';
import type { LlmServiceClient } from '../../services/planner-client';
import type { PlannerResult } from '../../planner/plan-types';
import { compilePlannerResultToWorkflow } from '../../services/workflow-compiler';
import { WorkflowClient } from '../../services/workflow-client';
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
  llmClient: LlmServiceClient,
  backendContextClient: BackendContextClient,
  backendConfig?: TextHandlerBackendConfig,
): void {
  type Session = {
    userId: string;
    lastPlan?: PlannerResult;
    lastWorkflowId?: string;
    lastExecutionId?: string;
    lastTimeBlockId?: string;
  };

  const sessions = new Map<number, Session>();

  const workflowClient =
    backendConfig?.backendBaseUrl != null && backendConfig.backendBaseUrl !== ''
      ? new WorkflowClient({
        baseUrl: backendConfig.backendBaseUrl,
        serviceKey: backendConfig.backendServiceKey,
        contextPath: '',
        workflowsPath: '/api/v1/workflows',
        requestTimeoutMs: backendConfig.backendRequestTimeoutMs ?? 30_000,
      })
      : null;

  const frontendBaseUrl = backendConfig?.frontendBaseUrl || 'https://flowforge.app';
  const supportedCommandsReply = formatSupportedCommandsReply();

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    const text = ctx.message.text;

    logger.info({ chatId, userId, text }, 'Telegram message received');

    const trimmed = text.trim().toLowerCase();
    if (trimmed.startsWith('verify-') && backendConfig?.backendBaseUrl && backendConfig?.backendServiceKey) {
      const code = text.trim();
      const chatTitle =
        ctx.chat.title ?? ctx.chat.first_name ?? ctx.chat.username ?? 'Unknown';
      const chatType = ctx.chat.type ?? 'private';
      try {
        const baseUrl = backendConfig.backendBaseUrl.replace(/\/$/, '');
        const res = await fetch(`${baseUrl}/api/v1/integrations/telegram/verification/verify-from-agent`, {
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
          signal: AbortSignal.timeout(backendConfig.backendRequestTimeoutMs ?? 30_000),
        });
        const data = (await res.json()) as { success?: boolean; message?: string };
        const message = typeof data.message === 'string' ? data.message : (data.success ? 'Verified.' : 'Verification failed.');
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn({ chatId, err }, 'verify-from-agent request failed');
        await ctx.reply('Verification request failed. Please try again later.');
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

    if (parsedCommand.command === 'plan') {
      if (!parsedCommand.args) {
        await ctx.reply('Usage: /plan <prompt>\nExample: /plan Get me the ETH price.');
        return;
      }

      try {
        const { agentUserId, plannerResult } = await buildPlannerResultForPrompt({
          prompt: parsedCommand.args,
          chatId,
          userId,
          backendContextClient,
          llmClient,
          logger,
        });

        logger.info(
          { chatId, userId, workflowName: plannerResult.workflowName, stepCount: plannerResult.steps.length, missingInputsCount: plannerResult.missingInputs.length },
          'Planner result received for /plan',
        );

        const existingSession = sessions.get(chatId);
        sessions.set(chatId, {
          userId: agentUserId,
          lastPlan: plannerResult,
          lastWorkflowId: existingSession?.lastWorkflowId,
          lastExecutionId: existingSession?.lastExecutionId,
          lastTimeBlockId: existingSession?.lastTimeBlockId,
        });

        await replyInChunks(ctx, formatPlannerReply(plannerResult));
      } catch (error) {
        logger.error(
          {
            chatId,
            userId,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          'Failed to get llm-service response for /plan',
        );
        await ctx.reply('I could not get a response from llm-service. Please try again.');
      }
      return;
    }

    if (!workflowClient) {
      await ctx.reply('Workflow execution is not configured (missing BACKEND_BASE_URL). Set it in .env to use /execute.');
      return;
    }

    let session = sessions.get(chatId);
    let planToExecute: PlannerResult | undefined = session?.lastPlan;
    let executionUserId = session?.userId ?? (userId ? `telegram-user-${userId}` : `telegram-chat-${chatId}`);

    if (parsedCommand.args) {
      try {
        const { agentUserId, plannerResult } = await buildPlannerResultForPrompt({
          prompt: parsedCommand.args,
          chatId,
          userId,
          backendContextClient,
          llmClient,
          logger,
        });

        logger.info(
          { chatId, userId, workflowName: plannerResult.workflowName, stepCount: plannerResult.steps.length, missingInputsCount: plannerResult.missingInputs.length },
          'Planner result received for /execute',
        );

        executionUserId = agentUserId;
        const existingSession = sessions.get(chatId);
        sessions.set(chatId, {
          userId: agentUserId,
          lastPlan: plannerResult,
          lastWorkflowId: existingSession?.lastWorkflowId,
          lastExecutionId: existingSession?.lastExecutionId,
          lastTimeBlockId: existingSession?.lastTimeBlockId,
        });
        session = sessions.get(chatId);
        planToExecute = plannerResult;
      } catch (error) {
        logger.error(
          {
            chatId,
            userId,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          'Failed to get llm-service response for /execute',
        );
        await ctx.reply('I could not get a response from llm-service. Please try again.');
        return;
      }
    }

    if (!planToExecute) {
      await ctx.reply('No plan found for this chat. Run /plan <prompt> first, or use /execute <prompt>.');
      return;
    }

    if (planToExecute.missingInputs.length > 0) {
      await replyInChunks(ctx, formatPlannerReply(planToExecute));
      await ctx.reply('Cannot execute yet. Add the missing details, then run /execute <updated prompt>.');
      return;
    }

    try {
      logger.info(
        { chatId, userId, workflowName: planToExecute.workflowName, stepCount: planToExecute.steps.length },
        'Compiling and executing workflow from /execute',
      );

      const chatIdStr = String(chatId);
      const requiresTelegramConnection = planToExecute.steps.some((step) => step.blockId === 'telegram');
      let telegramConnectionId: string | undefined;

      if (requiresTelegramConnection) {
        const connection = await backendContextClient.fetchTelegramConnection({
          userId: executionUserId,
          chatId: chatIdStr,
        });

        if (!connection) {
          await ctx.reply(
            'Telegram connection is not linked for this chat. Send your `verify-...` code first, then run /execute again.',
          );
          return;
        }

        telegramConnectionId = connection.connectionId;
        executionUserId = connection.userId;
      }

      const { workflow, schedule } = compilePlannerResultToWorkflow({
        plan: planToExecute,
        chatId: chatIdStr,
        telegramConnectionId,
      });

      const payload = {
        name: workflow.name,
        description: workflow.description,
        nodes: workflow.nodes,
        edges: workflow.edges,
        triggerNodeId: workflow.triggerNodeId,
        category: workflow.category,
        tags: workflow.tags,
        isPublic: workflow.isPublic,
      };

      let created: { id: string };
      try {
        created = await workflowClient.createWorkflow(executionUserId, payload);
      } catch (firstError) {
        if (tryPatchWorkflowPayloadFromValidationError(firstError, payload, telegramConnectionId)) {
          logger.info({ chatId }, 'Retrying workflow create after patching connectionId from validation error');
          created = await workflowClient.createWorkflow(executionUserId, payload);
        } else {
          throw firstError;
        }
      }

      logger.info({ chatId, userId, workflowId: created.id }, 'Workflow created');

      const sessionForWrite = session ?? { userId: executionUserId };

      if (schedule) {
        const now = new Date();
        const untilAt = new Date(now.getTime() + schedule.durationSeconds * 1000);
        const timeBlock = await workflowClient.createTimeBlock(executionUserId, {
          workflowId: created.id,
          runAt: now.toISOString(),
          recurrence: {
            type: 'INTERVAL',
            intervalSeconds: schedule.intervalSeconds,
            untilAt: untilAt.toISOString(),
          },
        });

        sessions.set(chatId, {
          ...sessionForWrite,
          lastPlan: planToExecute,
          lastWorkflowId: created.id,
          lastTimeBlockId: timeBlock.id,
        });

        void monitorScheduledWorkflow({
          bot,
          chatId,
          userId: executionUserId,
          workflowId: created.id,
          timeBlockId: timeBlock.id,
          durationSeconds: schedule.durationSeconds,
          workflowClient,
          signingBaseUrl: frontendBaseUrl,
          logger,
        }).catch((error) => {
          logger.error(
            {
              chatId,
              workflowId: created.id,
              errorMessage: error instanceof Error ? error.message : String(error),
            },
            'Scheduled workflow monitor crashed',
          );
        });
      } else {
        const executed = await workflowClient.executeWorkflow(executionUserId, created.id);

        logger.info({ chatId, userId, workflowId: created.id, executionId: executed.executionId }, 'Workflow execution started');

        sessions.set(chatId, {
          ...sessionForWrite,
          lastPlan: planToExecute,
          lastWorkflowId: created.id,
          lastExecutionId: executed.executionId,
        });

        void monitorSingleExecution({
          bot,
          chatId,
          userId: executionUserId,
          executionId: executed.executionId,
          workflowClient,
          signingBaseUrl: frontendBaseUrl,
          logger,
        }).catch((error) => {
          logger.error(
            {
              chatId,
              executionId: executed.executionId,
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
        'Failed to create or execute workflow from /execute',
      );
      await ctx.reply(message);
    }
  });
}

async function buildPlannerResultForPrompt(params: {
  prompt: string;
  chatId: number;
  userId: number | undefined;
  backendContextClient: BackendContextClient;
  llmClient: LlmServiceClient;
  logger: BotLogger;
}): Promise<{ agentUserId: string; plannerResult: PlannerResult }> {
  const agentUserId = params.userId ? `telegram-user-${params.userId}` : `telegram-chat-${params.chatId}`;
  const chatIdStr = String(params.chatId);

  const requestedFieldsForContext = [
    'telegramChatId',
    'privyUserId',
    'userAddress',
    'preferredChains',
    'preferredTokens',
  ];
  const backendContext = await params.backendContextClient.fetchPlannerContext({
    userId: agentUserId,
    telegramUserId: params.userId ? String(params.userId) : undefined,
    chatId: chatIdStr,
    requestedFields: requestedFieldsForContext,
    prompt: params.prompt,
  });

  const userContext: Record<string, string | number | boolean | string[]> = {
    ...(backendContext ?? {}),
    telegramChatId: chatIdStr,
  };
  if (backendContext && Object.keys(backendContext).length > 0) {
    params.logger.info({ chatId: params.chatId, userId: params.userId, contextKeys: Object.keys(backendContext) }, 'Using backend context for planner');
  }

  let plannerResult = await params.llmClient.generateWorkflowPlan({
    prompt: params.prompt,
    userId: agentUserId,
    supplementalContext: userContext,
  });

  if (plannerResult.missingInputs.length > 0) {
    const requestedFields = plannerResult.missingInputs.map((item) => item.field);
    const refineContext = await params.backendContextClient.fetchPlannerContext({
      userId: agentUserId,
      telegramUserId: params.userId ? String(params.userId) : undefined,
      chatId: chatIdStr,
      requestedFields,
      prompt: params.prompt,
    });

    if (refineContext && Object.keys(refineContext).length > 0) {
      params.logger.info({ chatId: params.chatId, userId: params.userId, contextKeys: Object.keys(refineContext) }, 'Refining planner with backend context');
      const mergedContext = { ...userContext, ...refineContext };
      plannerResult = await params.llmClient.generateWorkflowPlan({
        prompt: params.prompt,
        userId: agentUserId,
        supplementalContext: mergedContext,
      });
    }
  }

  return { agentUserId, plannerResult };
}

function parseTelegramCommand(text: string): ParsedTelegramCommand {
  const commandMatch = text.trim().match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/);
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

/**
 * If the error is a 400 validation error for nodes.*.config.connectionId and we have
 * telegramConnectionId, patch all TELEGRAM nodes in payload and return true so caller can retry.
 * Mutates payload.nodes in place.
 */
function tryPatchWorkflowPayloadFromValidationError(
  error: unknown,
  payload: { nodes: Array<{ type: string; config?: Record<string, unknown> }> },
  telegramConnectionId: string | undefined,
): boolean {
  if (!telegramConnectionId) return false;
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/Failed to create workflow:\s*400\s+(.+)/s);
  if (!match) return false;
  let body: { error?: { details?: Array<{ field?: string }> } };
  try {
    body = JSON.parse(match[1].trim()) as { error?: { details?: Array<{ field?: string }> } };
  } catch {
    return false;
  }
  const details = body?.error?.details;
  if (!Array.isArray(details)) return false;
  const connectionIdError = details.some(
    (d) => typeof d.field === 'string' && /nodes\.\d+\.config\.connectionId/.test(d.field),
  );
  if (!connectionIdError) return false;
  for (const node of payload.nodes) {
    if (node.type === 'TELEGRAM' && node.config) {
      node.config.connectionId = telegramConnectionId;
    }
  }
  return true;
}

/**
 * Map backend/workflow errors to short, user-friendly Telegram messages.
 */
function translateWorkflowError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (raw.includes('Backend base URL is not configured') || raw.includes('BACKEND_BASE_URL')) {
    return 'Workflow backend is not configured. Please try again later or contact support.';
  }

  const statusMatch = raw.match(/Failed to (?:create|execute|fetch)[^:]*:\s*(\d+)\s+(.+)/);
  if (statusMatch) {
    const status = statusMatch[1];
    const body = statusMatch[2].trim();
    type ErrorBody = { error?: { message?: string; code?: string; details?: unknown } };
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

  if (raw.includes('Unknown planner blockId') || raw.includes('No planner block definition')) {
    return 'This workflow uses a block I don’t support yet. Try a simpler request.';
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
      lines.push(`- [${note.type}] ${note.message}${note.field ? ` (${note.field})` : ''}`);
    });
  }

  lines.push('');
  if (plan.missingInputs.length > 0) {
    lines.push('Add the missing details, then run /plan <updated prompt> or /execute <updated prompt>.');
  } else {
    lines.push('Run /execute to create and run this workflow.');
  }

  return lines.join('\n');
}
