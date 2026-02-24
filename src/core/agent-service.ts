import type { BackendContextClient } from '../services/backend-client';
import type { LlmServiceClient } from '../services/planner-client';
import type { WorkflowClient } from '../services/workflow-client';
import type { PlannerResult } from '../planner/plan-types';
import { compilePlannerResultToWorkflow } from '../services/workflow-compiler';
import type { SessionStore } from './session-store';
import {
  type PlanRequest,
  type PlanResponse,
  type ExecuteRequest,
  type ExecuteResponse,
  type Channel,
  sessionKey,
} from './types';

const REQUESTED_FIELDS_FOR_CONTEXT = [
  'telegramChatId',
  'privyUserId',
  'userAddress',
  'preferredChains',
  'preferredTokens',
];

export interface AgentLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

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
    body = JSON.parse(match[1].trim()) as {
      error?: { details?: Array<{ field?: string }> };
    };
  } catch {
    return false;
  }
  const details = body?.error?.details;
  if (!Array.isArray(details)) return false;
  const connectionIdError = details.some(
    (d) =>
      typeof d.field === 'string' &&
      /nodes\.\d+\.config\.connectionId/.test(d.field),
  );
  if (!connectionIdError) return false;
  for (const node of payload.nodes) {
    if (node.type === 'TELEGRAM' && node.config) {
      node.config.connectionId = telegramConnectionId;
    }
  }
  return true;
}

export interface AgentServiceConfig {
  llmClient: LlmServiceClient;
  backendContextClient: BackendContextClient;
  workflowClient: WorkflowClient | null;
  sessionStore: SessionStore;
  logger: AgentLogger;
}

export class AgentService {
  constructor(private readonly config: AgentServiceConfig) {}

  async plan(request: PlanRequest): Promise<PlanResponse> {
    const { prompt, userId, channelId, channel } = request;
    const ch = channel ?? 'a2a';
    const key = channelId ? sessionKey(ch, channelId) : sessionKey(ch, userId);
    const chatIdStr = channelId ?? userId;

    const backendContext = await this.config.backendContextClient.fetchPlannerContext({
      userId,
      telegramUserId: ch === 'telegram' ? userId.replace(/^telegram-(user|chat)-/, '') : undefined,
      chatId: chatIdStr,
      requestedFields: REQUESTED_FIELDS_FOR_CONTEXT,
      prompt,
    });

    const userContext: Record<string, string | number | boolean | string[]> = {
      ...(backendContext ?? {}),
      telegramChatId: chatIdStr,
    };
    if (backendContext && Object.keys(backendContext).length > 0) {
      this.config.logger.info(
        { userId, channelId, contextKeys: Object.keys(backendContext) },
        'Using backend context for planner',
      );
    }

    let plannerResult = await this.config.llmClient.generateWorkflowPlan({
      prompt,
      userId,
      supplementalContext: userContext,
    });

    if (plannerResult.missingInputs.length > 0) {
      const requestedFields = plannerResult.missingInputs.map((item) => item.field);
      const refineContext =
        await this.config.backendContextClient.fetchPlannerContext({
          userId,
          telegramUserId: ch === 'telegram' ? userId.replace(/^telegram-(user|chat)-/, '') : undefined,
          chatId: chatIdStr,
          requestedFields,
          prompt,
        });
      if (refineContext && Object.keys(refineContext).length > 0) {
        this.config.logger.info(
          { userId, channelId, contextKeys: Object.keys(refineContext) },
          'Refining planner with backend context',
        );
        const mergedContext = { ...userContext, ...refineContext };
        plannerResult = await this.config.llmClient.generateWorkflowPlan({
          prompt,
          userId,
          supplementalContext: mergedContext,
        });
      }
    }

    const existing = this.config.sessionStore.get(key);
    this.config.sessionStore.set(key, {
      userId,
      lastPlan: plannerResult,
      lastWorkflowId: existing?.lastWorkflowId,
      lastExecutionId: existing?.lastExecutionId,
      lastTimeBlockId: existing?.lastTimeBlockId,
    });

    return { plan: plannerResult };
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    const { prompt, plan: requestPlan, userId, channelId, channel } = request;
    const ch = channel ?? 'a2a';
    const key = channelId ? sessionKey(ch, channelId) : sessionKey(ch, userId);
    const chatIdStr = channelId ?? userId;

    const workflowClient = this.config.workflowClient;
    if (!workflowClient) {
      throw new Error(
        'Workflow execution is not configured (missing backend). Set BACKEND_BASE_URL to use execute.',
      );
    }

    let plan: PlannerResult | undefined = requestPlan;
    let executionUserId = userId;

    if (plan === undefined && typeof prompt === 'string' && prompt.trim()) {
      const planResponse = await this.plan({
        prompt: prompt.trim(),
        userId,
        channelId,
        channel: ch,
      });
      plan = planResponse.plan;
      const session = this.config.sessionStore.get(key);
      executionUserId = session?.userId ?? userId;
    }

    if (!plan) {
      const session = this.config.sessionStore.get(key);
      plan = session?.lastPlan;
      if (session) executionUserId = session.userId;
    }

    if (!plan) {
      throw new Error(
        'No plan to execute. Provide a prompt or plan, or run plan first.',
      );
    }

    if (plan.missingInputs.length > 0) {
      throw new Error(
        'Cannot execute: plan has missing inputs. Add the missing details and plan again.',
      );
    }

    const requiresTelegramConnection = plan.steps.some(
      (step) => step.blockId === 'telegram',
    );
    let telegramConnectionId: string | undefined;

    if (requiresTelegramConnection && ch === 'telegram') {
      const connection =
        await this.config.backendContextClient.fetchTelegramConnection({
          userId: executionUserId,
          chatId: chatIdStr,
        });
      if (!connection) {
        throw new Error(
          'Telegram connection is not linked for this chat. Send your verify-... code first, then run execute again.',
        );
      }
      telegramConnectionId = connection.connectionId;
      executionUserId = connection.userId;
    }

    if (requiresTelegramConnection && ch !== 'telegram') {
      throw new Error(
        'This workflow requires a Telegram connection. Use the Telegram interface to execute it.',
      );
    }

    const { workflow, schedule } = compilePlannerResultToWorkflow({
      plan,
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
      if (
        tryPatchWorkflowPayloadFromValidationError(
          firstError,
          payload,
          telegramConnectionId,
        )
      ) {
        this.config.logger.info(
          { key },
          'Retrying workflow create after patching connectionId',
        );
        created = await workflowClient.createWorkflow(
          executionUserId,
          payload,
        );
      } else {
        throw firstError;
      }
    }

    const session = this.config.sessionStore.get(key);
    const sessionForWrite = session ?? { userId: executionUserId };
    this.config.sessionStore.set(key, {
      ...sessionForWrite,
      lastPlan: plan,
      lastWorkflowId: created.id,
    });

    if (schedule) {
      const now = new Date();
      const timeBlock = await workflowClient.createTimeBlock(
        executionUserId,
        {
          workflowId: created.id,
          runAt: now.toISOString(),
          recurrence: {
            type: 'INTERVAL',
            intervalSeconds: schedule.intervalSeconds,
            untilAt: new Date(
              now.getTime() + schedule.durationSeconds * 1000,
            ).toISOString(),
          },
        },
      );
      this.config.sessionStore.set(key, {
        ...sessionForWrite,
        lastPlan: plan,
        lastWorkflowId: created.id,
        lastTimeBlockId: timeBlock.id,
      });
      return {
        workflowId: created.id,
        timeBlockId: timeBlock.id,
        schedule: {
          intervalSeconds: schedule.intervalSeconds,
          durationSeconds: schedule.durationSeconds,
        },
        executionUserId: executionUserId,
      };
    }

    const executed = await workflowClient.executeWorkflow(
      executionUserId,
      created.id,
    );
    this.config.sessionStore.set(key, {
      ...sessionForWrite,
      lastPlan: plan,
      lastWorkflowId: created.id,
      lastExecutionId: executed.executionId,
    });

    return {
      workflowId: created.id,
      executionId: executed.executionId,
      executionUserId: executionUserId,
    };
  }
}
