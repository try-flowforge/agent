import type { PlannerResult } from '../planner/plan-types';

export type Channel = 'telegram' | 'a2a';

export interface PlanRequest {
  prompt: string;
  userId: string;
  channelId?: string;
  channel?: Channel;
}

export interface PlanResponse {
  plan: PlannerResult;
}

export interface ExecuteRequest {
  prompt?: string;
  plan?: PlannerResult;
  userId: string;
  channelId?: string;
  channel?: Channel;
}

export interface ExecuteResponse {
  workflowId: string;
  executionId?: string;
  timeBlockId?: string;
  schedule?: {
    intervalSeconds: number;
    durationSeconds: number;
  };
  /** When channel is telegram and connection was resolved, the backend user id used for execution (for monitoring). */
  executionUserId?: string;
}

export interface AgentSession {
  userId: string;
  lastPlan?: PlannerResult;
  lastWorkflowId?: string;
  lastExecutionId?: string;
  lastTimeBlockId?: string;
}

export function sessionKey(channel: Channel, channelId: string): string {
  return `${channel}:${channelId}`;
}
