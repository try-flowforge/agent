import { randomUUID, createHmac } from 'node:crypto';
import { buildPlannerSystemPrompt } from '../planner/system-prompt';
import { VALID_PLANNER_BLOCK_IDS } from '../planner/block-catalog';
import type { PlannerResult, PlannerStep, PlannerMissingInput, PlannerNote } from '../planner/plan-types';
import { plannerResponseSchema } from '../planner/schema';

export interface GeneratePlanInput {
  prompt: string;
  userId: string;
  supplementalContext?: Record<string, unknown>;
}

interface LlmClientConfig {
  baseUrl: string;
  hmacSecret: string;
  systemPrompt?: string;
}

interface LlmModelDefinition {
  id: string;
  provider: string;
  model: string;
}

interface LlmChatSuccess {
  success: true;
  data: {
    text?: string;
    json?: unknown;
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

const CHAT_PATH = '/v1/chat';
const DEFAULT_TEMPERATURE = 0;
const MAX_RETRIES_PER_MODEL = 2;
const RETRY_BASE_DELAY_MS = 1200;
const HARD_CODED_MODEL: LlmModelDefinition = {
  id: 'eigencloud-gpt-oss',
  provider: 'eigencloud',
  model: 'gpt-oss-120b-f16',
};
// const HARD_CODED_MODEL: LlmModelDefinition = {
//   id: 'eigencloud-qwen3',
//   provider: 'eigencloud',
//   model: 'qwen3-32b-128k-bf16',
// };

export class LlmServiceClient {
  constructor(private readonly config: LlmClientConfig) {}

  async generateWorkflowPlan(input: GeneratePlanInput): Promise<PlannerResult> {
    const failures: string[] = [];

    for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt += 1) {
      try {
        const response = await this.callChat(HARD_CODED_MODEL, input);
        const parsed = parsePlannerPayload(response.data);
        return sanitizePlannerResult(parsed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${HARD_CODED_MODEL.id} attempt ${attempt}: ${message}`);

        if (attempt < MAX_RETRIES_PER_MODEL) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await sleep(delay);
        }
      }
    }

    const detail = failures.slice(-4).join(' | ');
    throw new Error(`Planner request failed after retries. ${detail}`);
  }

  private async callChat(
    model: LlmModelDefinition,
    input: GeneratePlanInput,
  ): Promise<LlmChatSuccess> {
    const body = {
      provider: model.provider,
      model: model.id,
      messages: this.buildMessages(input.prompt, input.supplementalContext),
      temperature: DEFAULT_TEMPERATURE,
      ...(model.provider !== 'eigencloud' ? { responseSchema: plannerResponseSchema } : {}),
      requestId: randomUUID(),
      userId: input.userId,
    };

    const response = await this.signedRequest('POST', CHAT_PATH, body);
    const payload = safeJsonParse<LlmChatResponse>(response.text);

    if (!response.ok) {
      throw new Error(`llm-service returned ${response.status}`);
    }
    if (!payload || payload.success !== true) {
      const errMessage =
        payload && payload.success === false ? payload.error?.message ?? 'Provider returned error' : 'Invalid response';
      throw new Error(errMessage);
    }
    return payload;
  }

  private buildMessages(
    prompt: string,
    supplementalContext?: Record<string, unknown>,
  ): Array<{ role: 'system' | 'user'; content: string }> {
    const systemPrompt = this.config.systemPrompt ?? buildPlannerSystemPrompt();
    const userPrompt = buildUserPrompt(prompt, supplementalContext);
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }

  private async signedRequest(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const bodyString = body ? JSON.stringify(body) : '';
    const timestamp = Date.now().toString();
    const signature = signRequest(this.config.hmacSecret, method, path, bodyString, timestamp);
    const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
    const response = await fetch(endpoint, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
      ...(body ? { body: bodyString } : {}),
    });

    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
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

function parsePlannerPayload(data: LlmChatSuccess['data']): unknown {
  if (data.json && typeof data.json === 'object') {
    return data.json;
  }

  if (!data.text || data.text.trim().length === 0) {
    throw new Error('Planner returned empty text');
  }

  const plain = normalizeModelText(stripCodeFence(data.text));
  const parsed = safeJsonParse<unknown>(plain) ?? safeJsonParse<unknown>(extractJsonObject(plain));
  if (!parsed) {
    return buildClarificationFallback(plain);
  }
  return parsed;
}

function stripCodeFence(value: string): string {
  const codeMatch = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeMatch) {
    return codeMatch[1].trim();
  }
  return value.trim();
}

function extractJsonObject(value: string): string {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return '';
  }
  return value.slice(start, end + 1).trim();
}

function normalizeModelText(value: string): string {
  const messageToken = '<|message|>';
  if (value.includes(messageToken)) {
    return value.split(messageToken).slice(1).join(messageToken).trim();
  }
  return value
    .replace(/<\|channel\|>[a-zA-Z0-9_-]+/g, '')
    .replace(/<\|end\|>/g, '')
    .trim();
}

function sanitizePlannerResult(input: unknown): PlannerResult {
  if (!input || typeof input !== 'object') {
    throw new Error('Planner response is not an object');
  }

  const candidate = input as {
    workflowName?: unknown;
    description?: unknown;
    steps?: unknown;
    missingInputs?: unknown;
    notes?: unknown;
    heading1_workflow?: unknown;
    heading2_notes?: unknown;
  };

  const workflowSection =
    candidate.heading1_workflow && typeof candidate.heading1_workflow === 'object'
      ? (candidate.heading1_workflow as Record<string, unknown>)
      : candidate;
  const notesSection =
    candidate.heading2_notes && typeof candidate.heading2_notes === 'object'
      ? (candidate.heading2_notes as Record<string, unknown>)
      : candidate;

  const workflowName =
    typeof workflowSection.workflowName === 'string' && workflowSection.workflowName.trim().length > 0
      ? workflowSection.workflowName.trim().slice(0, 200)
      : 'Untitled Workflow';
  const description =
    typeof workflowSection.description === 'string' && workflowSection.description.trim().length > 0
      ? workflowSection.description.trim().slice(0, 500)
      : 'Generated workflow plan';
  const steps = sanitizeSteps(workflowSection.steps);
  const missingInputs = sanitizeMissingInputs(
    notesSection.missingInputs !== undefined ? notesSection.missingInputs : candidate.missingInputs,
  );
  const notes = sanitizeNotes(notesSection.notes);

  if (steps.length === 0) {
    throw new Error('Planner returned no valid steps');
  }

  return {
    workflowName,
    description,
    steps,
    missingInputs,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function sanitizeSteps(input: unknown): PlannerStep[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const steps: PlannerStep[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const item = value as { blockId?: unknown; purpose?: unknown; configHints?: unknown };
    if (typeof item.blockId !== 'string') {
      continue;
    }

    const blockId = normalizePlannerBlockId(item.blockId);
    if (!blockId) {
      continue;
    }

    const purpose =
      typeof item.purpose === 'string' && item.purpose.trim().length > 0
        ? item.purpose.trim().slice(0, 240)
        : 'Execute this workflow step.';

    const configHints = sanitizeStringRecord(item.configHints);
    steps.push({
      blockId,
      purpose,
      ...(configHints ? { configHints } : {}),
    });
  }

  return steps.slice(0, 20);
}

function normalizePlannerBlockId(rawBlockId: string): string | null {
  const trimmed = rawBlockId.trim();
  if (!trimmed) {
    return null;
  }

  if (VALID_PLANNER_BLOCK_IDS.has(trimmed)) {
    return trimmed;
  }

  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, '_');
  const aliasMap: Record<string, string> = {
    swap: 'uniswap',
    lifi_swap: 'lifi',
    oneinch_swap: 'oneinch',
    uniswap_swap: 'uniswap',
    pyth_price_oracle: 'pyth',
    chainlink_price_oracle: 'chainlink',
    llm_transform: 'ai-openai-chatgpt',
    email: 'mail',
  };

  const mapped = aliasMap[normalized];
  if (mapped && VALID_PLANNER_BLOCK_IDS.has(mapped)) {
    return mapped;
  }

  const compact = normalized.replace(/_/g, '-');
  if (VALID_PLANNER_BLOCK_IDS.has(compact)) {
    return compact;
  }

  return null;
}

function sanitizeMissingInputs(input: unknown): PlannerMissingInput[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const items: PlannerMissingInput[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const item = value as { field?: unknown; question?: unknown };
    if (typeof item.field !== 'string' || typeof item.question !== 'string') {
      continue;
    }

    const field = item.field.trim();
    const question = item.question.trim();
    if (!field || !question) {
      continue;
    }

    items.push({
      field: field.slice(0, 120),
      question: question.slice(0, 240),
    });
  }

  return items.slice(0, 10);
}

function sanitizeStringRecord(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (!trimmedKey || !trimmedValue) {
      continue;
    }
    output[trimmedKey.slice(0, 100)] = trimmedValue.slice(0, 200);
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeNotes(input: unknown): PlannerNote[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const allowedTypes = new Set<PlannerNote['type']>([
    'missing_data',
    'assumption',
    'risk',
    'preference',
    'other',
  ]);

  const notes: PlannerNote[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const item = value as { type?: unknown; message?: unknown; field?: unknown };
    if (typeof item.type !== 'string' || typeof item.message !== 'string') {
      continue;
    }
    if (!allowedTypes.has(item.type as PlannerNote['type'])) {
      continue;
    }

    const message = item.message.trim();
    if (!message) {
      continue;
    }

    const note: PlannerNote = {
      type: item.type as PlannerNote['type'],
      message: message.slice(0, 280),
    };

    if (typeof item.field === 'string' && item.field.trim()) {
      note.field = item.field.trim().slice(0, 120);
    }

    notes.push(note);
  }

  return notes.slice(0, 12);
}

function buildUserPrompt(prompt: string, supplementalContext?: Record<string, unknown>): string {
  if (!supplementalContext || Object.keys(supplementalContext).length === 0) {
    return prompt;
  }

  return [
    `User request: ${prompt}`,
    '',
    'Trusted backend context (safe fields only):',
    JSON.stringify(supplementalContext),
    '',
    'Use this context to fill missing inputs when possible.',
  ].join('\n');
}

function buildClarificationFallback(rawText: string): Record<string, unknown> {
  return {
    heading1_workflow: {
      workflowName: 'Need Clarification',
      description: 'Could not derive a valid workflow JSON from model output; asking for clarification.',
      steps: [
        {
          blockId: 'telegram',
          purpose: 'Ask user for clarification before building workflow.',
          configHints: {
            message: 'Please clarify your request and required details.',
          },
        },
      ],
    },
    heading2_notes: {
      missingInputs: [
        {
          field: 'intent',
          question: 'Please clarify what you want to achieve (trigger, action, constraints).',
        },
      ],
      notes: [
        {
          type: 'other',
          message: `Raw model output (trimmed): ${rawText.slice(0, 220)}`,
        },
      ],
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
