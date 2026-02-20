import type { Bot } from 'grammy';
import type { FastifyBaseLogger } from 'fastify';
import type { WorkflowClient, WorkflowExecutionStatus } from './workflow-client';

type MonitorLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

const SCHEDULED_POLL_MS = 30_000;
const SINGLE_EXECUTION_POLL_MS = 5_000;

interface ScheduledMonitorParams {
  bot: Bot;
  chatId: number;
  userId: string;
  workflowId: string;
  timeBlockId: string;
  durationSeconds: number;
  workflowClient: WorkflowClient;
  signingBaseUrl: string;
  logger: MonitorLogger;
}

interface SingleExecutionMonitorParams {
  bot: Bot;
  chatId: number;
  userId: string;
  executionId: string;
  workflowClient: WorkflowClient;
  signingBaseUrl: string;
  logger: MonitorLogger;
}

export async function monitorScheduledWorkflow(params: ScheduledMonitorParams): Promise<void> {
  const {
    bot,
    chatId,
    userId,
    workflowId,
    timeBlockId,
    durationSeconds,
    workflowClient,
    signingBaseUrl,
    logger,
  } = params;

  const startedAt = Date.now();
  const timeoutAt = startedAt + durationSeconds * 1000;
  const seenExecutionIds = new Set<string>();
  const signingSentForExecution = new Set<string>();

  logger.info({ chatId, userId, workflowId, timeBlockId }, 'Scheduled workflow monitor started');

  while (Date.now() < timeoutAt) {
    try {
      const executions = await workflowClient.listExecutions(userId, workflowId);

      for (const execution of executions) {
        if (seenExecutionIds.has(execution.id)) {
          continue;
        }
        seenExecutionIds.add(execution.id);

        if (execution.status === 'WAITING_FOR_SIGNATURE') {
          signingSentForExecution.add(execution.id);
          await sendSigningMessage({
            bot,
            chatId,
            executionId: execution.id,
            signingBaseUrl,
            logger,
          });

          const finalStatus = await waitForSingleExecutionTerminal({
            bot,
            chatId,
            userId,
            executionId: execution.id,
            workflowClient,
            signingBaseUrl,
            logger,
            signingAlreadySent: true,
          });

          if (finalStatus?.status === 'SUCCESS') {
            await safeCancelTimeBlock(workflowClient, userId, timeBlockId, logger);
            await safeSendMessage(bot, chatId, 'Swap executed successfully. Monitoring is now stopped.', logger);
            return;
          }
          continue;
        }

        if (execution.status === 'SUCCESS') {
          const details = await safeGetExecutionStatus(workflowClient, userId, execution.id, logger);
          if (didSwapExecute(details ?? execution)) {
            await safeCancelTimeBlock(workflowClient, userId, timeBlockId, logger);
            await safeSendMessage(bot, chatId, 'Swap executed successfully. Monitoring is now stopped.', logger);
            return;
          }
        }

        if (execution.status === 'FAILED') {
          const details = await safeGetExecutionStatus(workflowClient, userId, execution.id, logger);
          const errMsg = details?.error?.message ?? execution.error?.message;
          await safeSendMessage(
            bot,
            chatId,
            `A scheduled run failed${errMsg ? `: ${errMsg}` : ''}. I will continue monitoring.`,
            logger,
          );
        }

        if (execution.status === 'WAITING_FOR_SIGNATURE' && !signingSentForExecution.has(execution.id)) {
          signingSentForExecution.add(execution.id);
        }
      }
    } catch (error) {
      logger.warn(
        {
          workflowId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        'Scheduled monitor poll failed',
      );
    }

    await sleep(SCHEDULED_POLL_MS);
  }

  await safeSendMessage(
    bot,
    chatId,
    'Monitoring window ended after 24 hours. The trigger condition was not met in time.',
    logger,
  );
}

export async function monitorSingleExecution(params: SingleExecutionMonitorParams): Promise<void> {
  await waitForSingleExecutionTerminal({
    ...params,
    signingAlreadySent: false,
  });
}

async function waitForSingleExecutionTerminal(
  params: SingleExecutionMonitorParams & { signingAlreadySent: boolean },
): Promise<WorkflowExecutionStatus | null> {
  const {
    bot,
    chatId,
    userId,
    executionId,
    workflowClient,
    signingBaseUrl,
    logger,
  } = params;
  let signingSent = params.signingAlreadySent;

  while (true) {
    try {
      const status = await workflowClient.getExecutionStatus(userId, executionId);
      const state = status.status;

      if (state === 'WAITING_FOR_SIGNATURE' && !signingSent) {
        signingSent = true;
        await sendSigningMessage({
          bot,
          chatId,
          executionId,
          signingBaseUrl,
          logger,
        });
      }

      if (state === 'SUCCESS') {
        await safeSendMessage(bot, chatId, 'Workflow completed successfully.', logger);
        return status;
      }

      if (state === 'FAILED') {
        const errMsg = status.error?.message;
        await safeSendMessage(
          bot,
          chatId,
          `Workflow execution failed${errMsg ? `: ${errMsg}` : ''}.`,
          logger,
        );
        return status;
      }
    } catch (error) {
      logger.warn(
        {
          executionId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        'Single execution monitor poll failed',
      );
    }

    await sleep(SINGLE_EXECUTION_POLL_MS);
  }
}

function didSwapExecute(execution: WorkflowExecutionStatus): boolean {
  const nodeExecutions = execution.nodeExecutions ?? [];
  for (const nodeExecution of nodeExecutions as Array<Record<string, unknown>>) {
    const nodeType = typeof nodeExecution.node_type === 'string' ? nodeExecution.node_type : '';
    const status = typeof nodeExecution.status === 'string' ? nodeExecution.status : '';
    if (nodeType === 'SWAP' && status === 'SUCCESS') {
      return true;
    }
  }

  if (execution.started_at && execution.finished_at) {
    const started = Date.parse(execution.started_at);
    const finished = Date.parse(execution.finished_at);
    if (!Number.isNaN(started) && !Number.isNaN(finished)) {
      return finished - started > 10_000;
    }
  }

  return false;
}

async function sendSigningMessage(params: {
  bot: Bot;
  chatId: number;
  executionId: string;
  signingBaseUrl: string;
  logger: MonitorLogger;
}): Promise<void> {
  const link = buildExecutionSigningLink(params.signingBaseUrl, params.executionId);
  await safeSendMessage(
    params.bot,
    params.chatId,
    `Action required: please sign the transaction to proceed.\n${link}`,
    params.logger,
  );
}

function buildExecutionSigningLink(frontendBaseUrl: string, executionId: string): string {
  const normalizedBase = frontendBaseUrl.replace(/\/$/, '');
  return `${normalizedBase}/agent-onboarding?executionId=${encodeURIComponent(executionId)}`;
}

async function safeGetExecutionStatus(
  workflowClient: WorkflowClient,
  userId: string,
  executionId: string,
  logger: MonitorLogger,
): Promise<WorkflowExecutionStatus | null> {
  try {
    return await workflowClient.getExecutionStatus(userId, executionId);
  } catch (error) {
    logger.warn(
      {
        executionId,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      'Failed to fetch execution details',
    );
    return null;
  }
}

async function safeCancelTimeBlock(
  workflowClient: WorkflowClient,
  userId: string,
  timeBlockId: string,
  logger: MonitorLogger,
): Promise<void> {
  try {
    await workflowClient.cancelTimeBlock(userId, timeBlockId);
  } catch (error) {
    logger.warn(
      {
        timeBlockId,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      'Failed to cancel time block',
    );
  }
}

async function safeSendMessage(
  bot: Bot,
  chatId: number,
  text: string,
  logger: MonitorLogger,
): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, text);
  } catch (error) {
    logger.warn(
      {
        chatId,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      'Failed to send monitor message to Telegram',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
