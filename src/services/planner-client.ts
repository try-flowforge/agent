import { randomUUID, createHmac } from 'node:crypto';

export interface GeneratePlanInput {
  prompt: string;
  userId: string;
}

interface LlmClientConfig {
  baseUrl: string;
  hmacSecret: string;
  provider: string;
  model: string;
  temperature: number;
  systemPrompt?: string;
}

interface LlmChatSuccess {
  success: true;
  data: {
    text: string;
  };
}

interface LlmChatFailure {
  success: false;
  error?: {
    code?: string;
    message?: string;
  };
}

type LlmChatResponse = LlmChatSuccess | LlmChatFailure;

export class LlmServiceClient {
  constructor(private readonly config: LlmClientConfig) {}

  async generateWorkflowPlan(input: GeneratePlanInput): Promise<string> {
    const path = '/v1/chat';
    const timestamp = Date.now().toString();
    const messages = this.buildMessages(input.prompt);
    const body = {
      provider: this.config.provider,
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      requestId: randomUUID(),
      userId: input.userId,
    };
    const bodyString = JSON.stringify(body);
    const signature = signRequest(
      this.config.hmacSecret,
      'POST',
      path,
      bodyString,
      timestamp,
    );
    const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}${path}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
      body: bodyString,
    });

    const text = await response.text();
    const payload = safeJsonParse<LlmChatResponse>(text);

    if (!response.ok) {
      const message =
        payload && payload.success === false
          ? (payload.error?.message ?? `llm-service request failed with ${response.status}`)
          : `llm-service request failed with ${response.status}`;
      throw new Error(message);
    }

    if (!payload || payload.success !== true || !payload.data?.text) {
      throw new Error('Invalid llm-service response: missing data.text');
    }

    return payload.data.text;
  }

  private buildMessages(prompt: string): Array<{ role: 'system' | 'user'; content: string }> {
    if (!this.config.systemPrompt) {
      return [{ role: 'user', content: prompt }];
    }

    return [
      { role: 'system', content: this.config.systemPrompt },
      { role: 'user', content: prompt },
    ];
  }
}

function signRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  timestamp: string,
): string {
  const payload = `${timestamp}:${method.toUpperCase()}:${path}:${body}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
