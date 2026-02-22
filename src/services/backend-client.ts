export interface BackendContextClientConfig {
  baseUrl?: string;
  serviceKey?: string;
  contextPath: string;
  /** Request timeout in ms. */
  requestTimeoutMs?: number;
}

export interface PlannerContextRequest {
  userId: string;
  telegramUserId?: string;
  chatId: string;
  requestedFields: string[];
  prompt: string;
}

export type PlannerContext = Record<string, string | number | boolean | string[]>;

export interface BuildIntentStep {
  blockType: 'swap' | 'lending';
  configHints: Record<string, string | number>;
}

export interface BuildIntentRequest {
  userId: string;
  agentUserId: string;
  safeAddress: string;
  chainId: number;
  description?: string;
  steps: BuildIntentStep[];
}

export interface TelegramConnectionLookupRequest {
  userId: string;
  chatId: string;
}

export interface TelegramConnectionLookupResult {
  connectionId: string;
  userId: string;
}

export interface TransactionIntentResponse {
  id: string;
  userId: string;
  status: string;
  safeTxHash?: string;
  txHash?: string;
}

export class BackendContextClient {
  constructor(private readonly config: BackendContextClientConfig) { }

  async fetchPlannerContext(request: PlannerContextRequest): Promise<PlannerContext | null> {
    if (!this.config.baseUrl) {
      return null;
    }

    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}${this.config.contextPath}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (this.config.serviceKey) {
      headers['x-service-key'] = this.config.serviceKey;
      headers['x-on-behalf-of'] = request.userId;
    }

    const run = async (): Promise<{ context: PlannerContext | null; status?: number; retryable?: boolean }> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers,
          body: JSON.stringify({
            userId: request.userId,
            telegramUserId: request.telegramUserId,
            chatId: request.chatId,
            requestedFields: request.requestedFields,
            prompt: request.prompt,
          }),
        });

        const text = await response.text();

        if (!response.ok) {
          logBackendContextFailure(endpoint, response.status, text);
          const retryable = response.status >= 500;
          return { context: null, status: response.status, retryable };
        }

        const payload = safeJsonParse<{ success?: boolean; data?: unknown }>(text);
        if (!payload || payload.success !== true || !payload.data || typeof payload.data !== 'object') {
          return { context: null };
        }

        const dataRecord = payload.data as Record<string, unknown>;
        const contextCandidate =
          dataRecord.context && typeof dataRecord.context === 'object'
            ? (dataRecord.context as Record<string, unknown>)
            : dataRecord;

        return { context: sanitizePlannerContext(contextCandidate) };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    try {
      let result = await run();
      if (result.context != null) return result.context;
      if (result.retryable === true) {
        await new Promise((r) => setTimeout(r, 800));
        result = await run();
      }
      return result.context;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = message.includes('abort') || message.includes('timeout');
      logBackendContextFailure(endpoint, undefined, isTimeout ? 'Request timed out' : message);
      const networkRetryable = isTimeout || message.includes('ECONNRESET') || message.includes('ENOTFOUND') || message.includes('ETIMEDOUT');
      if (networkRetryable) {
        await new Promise((r) => setTimeout(r, 800));
        try {
          const retryResult = await run();
          return retryResult.context;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /**
   * Calls POST /api/v1/intents/build — backend builds the exact multicall calldata,
   * computes safeTxHash, and stores the intent ready for frontend signing.
   */
  async buildTransactionIntent(request: BuildIntentRequest): Promise<TransactionIntentResponse | null> {
    if (!this.config.baseUrl) return null;

    try {
      const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}/api/v1/intents/build`;
      const headers: Record<string, string> = { 'content-type': 'application/json' };

      if (this.config.serviceKey) {
        headers['x-service-key'] = this.config.serviceKey;
        headers['x-on-behalf-of'] = request.userId;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        console.error(`Failed to build intent: ${response.status} ${await response.text()}`);
        return null;
      }

      const payload = safeJsonParse<{ success?: boolean; data?: TransactionIntentResponse }>(await response.text());
      if (!payload || payload.success !== true || !payload.data) return null;

      return payload.data;
    } catch (e) {
      console.error('Error building transaction intent', e);
      return null;
    }

  }

  /**
   * Resolve Telegram chatId to connectionId and linked Privy userId. Uses backend endpoint that accepts
   * service key only (GET /connection-by-chat/:chatId). Returns both so the agent can create
   * workflows under the real user (users table) not a synthetic id.
   */
  async fetchTelegramConnection(
    request: TelegramConnectionLookupRequest,
  ): Promise<TelegramConnectionLookupResult | null> {
    if (!this.config.baseUrl || !this.config.serviceKey) return null;

    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const base = this.config.baseUrl.replace(/\/$/, '');
    const endpoint = `${base}/api/v1/integrations/telegram/connection-by-chat/${encodeURIComponent(request.chatId)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'x-service-key': this.config.serviceKey,
        },
      });

      if (!response.ok) {
        return null;
      }

      const payload = safeJsonParse<{
        success?: boolean;
        data?: { connectionId?: string; userId?: string };
      }>(await response.text());

      if (
        !payload ||
        payload.success !== true ||
        !payload.data?.connectionId ||
        !payload.data?.userId
      ) {
        return null;
      }

      return {
        connectionId: payload.data.connectionId,
        userId: payload.data.userId,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}


function logBackendContextFailure(endpoint: string, status?: number, bodyOrMessage?: string): void {
  const preview = typeof bodyOrMessage === 'string' ? bodyOrMessage.slice(0, 200) : '';
  const msg = `Backend context fetch failed: ${endpoint}${status != null ? ` status=${status}` : ''} ${preview}`.trim();
  if (status != null && status >= 500) {
    console.error(msg);
  } else {
    console.warn(msg);
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
