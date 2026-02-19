export interface BackendContextClientConfig {
  baseUrl?: string;
  serviceKey?: string;
  contextPath: string;
}

export interface PlannerContextRequest {
  userId: string;
  telegramUserId?: string;
  chatId: string;
  requestedFields: string[];
  prompt: string;
}

export type PlannerContext = Record<string, string | number | boolean | string[]>;

export class BackendContextClient {
  constructor(private readonly config: BackendContextClientConfig) {}

  async fetchPlannerContext(request: PlannerContextRequest): Promise<PlannerContext | null> {
    if (!this.config.baseUrl) {
      return null;
    }

    try {
      const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}${this.config.contextPath}`;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };

      if (this.config.serviceKey) {
        headers['x-service-key'] = this.config.serviceKey;
        headers['x-on-behalf-of'] = request.userId;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: request.userId,
          telegramUserId: request.telegramUserId,
          chatId: request.chatId,
          requestedFields: request.requestedFields,
          prompt: request.prompt,
        }),
      });

      if (!response.ok) {
        return null;
      }

      const payload = safeJsonParse<{ success?: boolean; data?: unknown }>(await response.text());
      if (!payload || payload.success !== true || !payload.data || typeof payload.data !== 'object') {
        return null;
      }

      const dataRecord = payload.data as Record<string, unknown>;
      const contextCandidate =
        dataRecord.context && typeof dataRecord.context === 'object'
          ? (dataRecord.context as Record<string, unknown>)
          : dataRecord;

      return sanitizePlannerContext(contextCandidate);
    } catch {
      return null;
    }
  }
}

function sanitizePlannerContext(input: Record<string, unknown>): PlannerContext {
  const safeKeys = new Set([
    'userAddress',
    'privyUserId',
    'telegramChatId',
    'preferredChains',
    'preferredTokens',
    'riskProfile',
    'slippageBps',
  ]);

  const result: PlannerContext = {};
  for (const [key, value] of Object.entries(input)) {
    if (!safeKeys.has(key) || value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
      continue;
    }

    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      result[key] = value;
    }
  }

  return result;
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
