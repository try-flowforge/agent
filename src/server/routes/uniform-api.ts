import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AgentService } from '../../core/agent-service';
import type { PlannerResult } from '../../planner/plan-types';

interface PlanBody {
  prompt: string;
  channelId?: string;
  channel?: 'telegram' | 'a2a';
}

interface ExecuteBody {
  prompt?: string;
  plan?: PlannerResult;
  channelId?: string;
  channel?: 'telegram' | 'a2a';
}

function getUserId(request: FastifyRequest): string | null {
  const onBehalfOf = request.headers['x-on-behalf-of'];
  if (typeof onBehalfOf === 'string' && onBehalfOf.trim().length > 0) {
    return onBehalfOf.trim();
  }
  return null;
}

function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  serviceKey: string | undefined,
): boolean {
  if (!serviceKey) {
    reply.status(500).send({
      success: false,
      error: 'Uniform API auth is not configured (missing service key).',
    });
    return false;
  }
  const key = request.headers['x-service-key'];
  if (typeof key !== 'string' || key !== serviceKey) {
    reply.status(401).send({
      success: false,
      error: 'Missing or invalid X-Service-Key.',
    });
    return false;
  }
  const userId = getUserId(request);
  if (!userId) {
    reply.status(401).send({
      success: false,
      error: 'Missing or invalid X-On-Behalf-Of (userId).',
    });
    return false;
  }
  return true;
}

export interface RegisterUniformApiOptions {
  agentService: AgentService;
  serviceKey: string | undefined;
}

export function registerUniformApiRoutes(
  server: FastifyInstance,
  options: RegisterUniformApiOptions,
): void {
  const { agentService, serviceKey } = options;

  server.post<{ Body: PlanBody }>('/v1/plan', async (request, reply) => {
    if (!requireAuth(request, reply, serviceKey)) return;
    const userId = getUserId(request)!;
    const body = request.body ?? {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      reply.status(400).send({
        success: false,
        error: 'Missing or empty prompt.',
      });
      return;
    }
    try {
      const result = await agentService.plan({
        prompt,
        userId,
        channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
        channel: body.channel === 'telegram' || body.channel === 'a2a' ? body.channel : undefined,
      });
      return reply.status(200).send({ success: true, plan: result.plan });
    } catch (err) {
      request.log.error({ err, userId }, 'POST /v1/plan failed');
      reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : 'Plan failed.',
      });
    }
  });

  server.post<{ Body: ExecuteBody }>('/v1/execute', async (request, reply) => {
    if (!requireAuth(request, reply, serviceKey)) return;
    const userId = getUserId(request)!;
    const body = request.body ?? {};
    const prompt =
      typeof body.prompt === 'string' ? body.prompt.trim() : undefined;
    const rawPlan = body.plan;
    const plan =
      rawPlan &&
      typeof rawPlan === 'object' &&
      typeof (rawPlan as PlannerResult).workflowName === 'string' &&
      Array.isArray((rawPlan as PlannerResult).steps)
        ? (rawPlan as PlannerResult)
        : undefined;
    if (!prompt && !plan) {
      reply.status(400).send({
        success: false,
        error: 'Missing prompt or plan. Provide one to execute.',
      });
      return;
    }
    try {
      const result = await agentService.execute({
        prompt,
        plan,
        userId,
        channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
        channel: body.channel === 'telegram' || body.channel === 'a2a' ? body.channel : undefined,
      });
      return reply.status(200).send({
        success: true,
        workflowId: result.workflowId,
        executionId: result.executionId,
        timeBlockId: result.timeBlockId,
        schedule: result.schedule,
        executionUserId: result.executionUserId,
      });
    } catch (err) {
      request.log.error({ err, userId }, 'POST /v1/execute failed');
      reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : 'Execute failed.',
      });
    }
  });
}
