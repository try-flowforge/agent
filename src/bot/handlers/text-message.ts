import type { FastifyBaseLogger } from 'fastify';
import type { Bot, Context } from 'grammy';
import type { BackendContextClient } from '../../services/backend-client';
import type { LlmServiceClient } from '../../services/planner-client';
import type { PlannerResult } from '../../planner/plan-types';
import { compilePlannerResultToWorkflow } from '../../services/workflow-compiler';
import { WorkflowClient } from '../../services/workflow-client';
import { monitorScheduledWorkflow, monitorSingleExecution } from '../../services/execution-monitor';

type BotLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

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

    if (text.startsWith('/')) {
      if (text === '/confirm') {
        if (!workflowClient) {
          await ctx.reply('Workflow execution is not configured (missing BACKEND_BASE_URL). Set it in .env to create and run workflows.');
          return;
        }

        const session = sessions.get(chatId);
        if (!session || !session.lastPlan) {
          await ctx.reply('I do not have a pending workflow to confirm. Send a new request first.');
          return;
        }

        if (session.lastPlan.missingInputs.length > 0) {
          await ctx.reply(
            'This plan still has missing details. Please answer the questions I asked (or send an updated request) before using /confirm.',
          );
          return;
        }

        try {
          logger.info(
            { chatId, userId, workflowName: session.lastPlan.workflowName, stepCount: session.lastPlan.steps.length },
            'Compiling and executing confirmed workflow',
          );

          const { workflow, schedule } = compilePlannerResultToWorkflow({
            plan: session.lastPlan,
            chatId: String(chatId),
          });

          const created = await workflowClient.createWorkflow(session.userId, {
            name: workflow.name,
            description: workflow.description,
            nodes: workflow.nodes,
            edges: workflow.edges,
            triggerNodeId: workflow.triggerNodeId,
            category: workflow.category,
            tags: workflow.tags,
            isPublic: workflow.isPublic,
          });

          logger.info({ chatId, userId, workflowId: created.id }, 'Workflow created');

          if (schedule) {
            const now = new Date();
            const untilAt = new Date(now.getTime() + schedule.durationSeconds * 1000);
            const timeBlock = await workflowClient.createTimeBlock(session.userId, {
              workflowId: created.id,
              runAt: now.toISOString(),
              recurrence: {
                type: 'INTERVAL',
                intervalSeconds: schedule.intervalSeconds,
                untilAt: untilAt.toISOString(),
              },
            });

            sessions.set(chatId, {
              ...session,
              lastWorkflowId: created.id,
              lastTimeBlockId: timeBlock.id,
            });

            void monitorScheduledWorkflow({
              bot,
              chatId,
              userId: session.userId,
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

            await ctx.reply(
              `Workflow created and scheduled. I'll check every ${Math.round(schedule.intervalSeconds / 60)} minutes for the next ${Math.round(schedule.durationSeconds / 3600)} hours and notify you here when action is needed.`,
            );
          } else {
            const executed = await workflowClient.executeWorkflow(session.userId, created.id);

            logger.info({ chatId, userId, workflowId: created.id, executionId: executed.executionId }, 'Workflow execution started');

            sessions.set(chatId, {
              ...session,
              lastWorkflowId: created.id,
              lastExecutionId: executed.executionId,
            });

            void monitorSingleExecution({
              bot,
              chatId,
              userId: session.userId,
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

            await ctx.reply(
              'Workflow created and running. I will notify you here when it completes or needs your signature.',
            );
          }
        } catch (error) {
          const message = translateWorkflowError(error);
          logger.error(
            {
              chatId,
              userId,
              errorMessage: error instanceof Error ? error.message : String(error),
            },
            'Failed to create or execute workflow from confirmed plan',
          );
          await ctx.reply(message);
        }
        return;
      }

      if (text === '/status') {
        if (!workflowClient) {
          await ctx.reply('Workflow status is not available (missing BACKEND_BASE_URL).');
          return;
        }

        const session = sessions.get(chatId);
        if (!session || !session.lastExecutionId) {
          await ctx.reply('No recent execution found for this chat. Use /confirm after sending a request first.');
          return;
        }

        try {
          const status = await workflowClient.getExecutionStatus(session.userId, session.lastExecutionId);

          await ctx.reply(
            [
              `Execution ${status.id}: ${status.status}`,
              status.started_at ? `Started: ${status.started_at}` : '',
              status.finished_at ? `Finished: ${status.finished_at}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        } catch (error) {
          const message = translateWorkflowError(error);
          logger.error(
            {
              chatId,
              userId,
              errorMessage: error instanceof Error ? error.message : String(error),
            },
            'Failed to fetch execution status',
          );
          await ctx.reply(message);
        }
        return;
      }

      return;
    }

    try {
      const agentUserId = userId ? `telegram-user-${userId}` : `telegram-chat-${chatId}`;
      const chatIdStr = String(chatId);

      // Fetch user context before first planner call so the LLM has telegramChatId etc. upfront
      const requestedFieldsForContext = [
        'telegramChatId',
        'privyUserId',
        'userAddress',
        'preferredChains',
        'preferredTokens',
      ];
      const backendContext = await backendContextClient.fetchPlannerContext({
        userId: agentUserId,
        telegramUserId: userId ? String(userId) : undefined,
        chatId: chatIdStr,
        requestedFields: requestedFieldsForContext,
        prompt: text,
      });

      // Always pass at least telegramChatId (current chat) so the LLM can fill notification steps
      const userContext: Record<string, string | number | boolean | string[]> = {
        ...(backendContext ?? {}),
        telegramChatId: chatIdStr,
      };
      if (backendContext && Object.keys(backendContext).length > 0) {
        logger.info({ chatId, userId, contextKeys: Object.keys(backendContext) }, 'Using backend context for planner');
      }

      let plannerResult = await llmClient.generateWorkflowPlan({
        prompt: text,
        userId: agentUserId,
        supplementalContext: userContext,
      });

      // If the first pass still has missing inputs, try refining with a focused context fetch
      if (plannerResult.missingInputs.length > 0) {
        const requestedFields = plannerResult.missingInputs.map((item) => item.field);
        const refineContext = await backendContextClient.fetchPlannerContext({
          userId: agentUserId,
          telegramUserId: userId ? String(userId) : undefined,
          chatId: chatIdStr,
          requestedFields,
          prompt: text,
        });

        if (refineContext && Object.keys(refineContext).length > 0) {
          logger.info({ chatId, userId, contextKeys: Object.keys(refineContext) }, 'Refining planner with backend context');
          const mergedContext = { ...userContext, ...refineContext };
          plannerResult = await llmClient.generateWorkflowPlan({
            prompt: text,
            userId: agentUserId,
            supplementalContext: mergedContext,
          });
        }
      }

      logger.info(
        { chatId, userId, workflowName: plannerResult.workflowName, stepCount: plannerResult.steps.length, missingInputsCount: plannerResult.missingInputs.length },
        'Planner result received',
      );

      await replyInChunks(ctx, formatPlannerReply(plannerResult));

      const existingSession = sessions.get(chatId);
      sessions.set(chatId, {
        userId: agentUserId,
        lastPlan: plannerResult,
        lastWorkflowId: existingSession?.lastWorkflowId,
        lastExecutionId: existingSession?.lastExecutionId,
      });
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
  lines.push('Reply /confirm to create & run this as a workflow, or edit your request.');

  return lines.join('\n');
}
