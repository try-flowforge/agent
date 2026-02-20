import type { BackendContextClientConfig } from './backend-client';

const WORKFLOW_MAX_RETRIES = 2;
const WORKFLOW_RETRY_BASE_DELAY_MS = 1000;

export interface WorkflowClientConfig extends BackendContextClientConfig {
  workflowsPath: string;
  /** Request timeout in ms for each request. */
  requestTimeoutMs?: number;
}

function isRetryableWorkflowError(error: unknown): boolean {
  const name = error instanceof Error ? (error as Error & { name?: string }).name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Backend base URL is not configured')) return false;
  if (message.includes('invalid') && !message.includes('502') && !message.includes('503')) return false;
  if (message.includes('400') || message.includes('401') || message.includes('403') || message.includes('404')) return false;
  if (message.includes('502') || message.includes('503')) return true;
  if (name === 'AbortError' || message.includes('abort') || message.includes('aborted') || message.includes('timed out') || message.includes('timeout')) return true;
  if (message.includes('ECONNRESET') || message.includes('ENOTFOUND') || message.includes('ETIMEDOUT') || message.includes('ECONNREFUSED')) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export interface CreateWorkflowResponse {
  id: string;
}

export interface ExecuteWorkflowResponse {
  executionId: string;
  status: string;
  message: string;
  subscriptionToken: string;
}

export interface WorkflowExecutionStatus {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
}

export class WorkflowClient {
  constructor(private readonly config: WorkflowClientConfig) {}

  private get baseUrl(): string | undefined {
    return this.config.baseUrl;
  }

  private get timeoutMs(): number {
    return this.config.requestTimeoutMs ?? 30_000;
  }

  private buildHeaders(userId: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (this.config.serviceKey) {
      headers['x-service-key'] = this.config.serviceKey;
      headers['x-on-behalf-of'] = userId;
    }

    return headers;
  }

  private async fetchWithTimeout(
    endpoint: string,
    options: RequestInit & { method: 'GET' | 'POST'; body?: string },
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        ...options,
        signal: controller.signal,
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async createWorkflow(userId: string, body: unknown): Promise<CreateWorkflowResponse> {
    if (!this.baseUrl) {
      throw new Error('Backend base URL is not configured for WorkflowClient.');
    }

    const endpoint = `${this.baseUrl.replace(/\/$/, '')}${this.config.workflowsPath}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= WORKFLOW_MAX_RETRIES; attempt += 1) {
      try {
        const { ok, status, text } = await this.fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: this.buildHeaders(userId),
          body: JSON.stringify(body),
        });

        if (!ok) {
          throw new Error(`Failed to create workflow: ${status} ${text}`);
        }

        const payload = safeJsonParse<{ success?: boolean; data?: { id?: string } }>(text);
        if (!payload || payload.success !== true || !payload.data?.id) {
          throw new Error('Backend response for create workflow is invalid.');
        }

        return { id: payload.data.id };
      } catch (error) {
        lastError = error;
        if (!isRetryableWorkflowError(error) || attempt >= WORKFLOW_MAX_RETRIES) throw error;
        const delay = WORKFLOW_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
    throw lastError;
  }

  async executeWorkflow(userId: string, workflowId: string, initialInput: Record<string, unknown> = {}): Promise<ExecuteWorkflowResponse> {
    if (!this.baseUrl) {
      throw new Error('Backend base URL is not configured for WorkflowClient.');
    }

    const endpoint = `${this.baseUrl.replace(/\/$/, '')}${this.config.workflowsPath}/${workflowId}/execute`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= WORKFLOW_MAX_RETRIES; attempt += 1) {
      try {
        const { ok, status, text } = await this.fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: this.buildHeaders(userId),
          body: JSON.stringify({ initialInput }),
        });

        if (!ok) {
          throw new Error(`Failed to execute workflow: ${status} ${text}`);
        }

        const payload = safeJsonParse<{ success?: boolean; data?: ExecuteWorkflowResponse }>(text);
        if (!payload || payload.success !== true || !payload.data) {
          throw new Error('Backend response for execute workflow is invalid.');
        }

        return payload.data;
      } catch (error) {
        lastError = error;
        if (!isRetryableWorkflowError(error) || attempt >= WORKFLOW_MAX_RETRIES) throw error;
        const delay = WORKFLOW_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
    throw lastError;
  }

  async getExecutionStatus(userId: string, executionId: string): Promise<WorkflowExecutionStatus> {
    if (!this.baseUrl) {
      throw new Error('Backend base URL is not configured for WorkflowClient.');
    }

    const endpoint = `${this.baseUrl.replace(/\/$/, '')}${this.config.workflowsPath}/executions/${executionId}`;
    const { ok, status, text } = await this.fetchWithTimeout(endpoint, {
      method: 'GET',
      headers: this.buildHeaders(userId),
    });

    if (!ok) {
      throw new Error(`Failed to fetch execution status: ${status} ${text}`);
    }

    const payload = safeJsonParse<{ success?: boolean; data?: WorkflowExecutionStatus }>(text);
    if (!payload || payload.success !== true || !payload.data) {
      throw new Error('Backend response for execution status is invalid.');
    }

    return payload.data;
  }
}

