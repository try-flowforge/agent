import { randomUUID } from 'node:crypto';
import type { PlannerResult, PlannerStep } from '../planner/plan-types';
import { PLANNER_BLOCKS, VALID_PLANNER_BLOCK_IDS } from '../planner/block-catalog';

export interface CompiledNodePosition {
  x: number;
  y: number;
}

export interface CompiledNode {
  id: string;
  type: string;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  position: CompiledNodePosition;
  metadata?: Record<string, unknown>;
}

export interface CompiledEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  condition?: Record<string, unknown>;
  dataMapping?: Record<string, unknown>;
}

export interface CompiledWorkflow {
  name: string;
  description: string;
  nodes: CompiledNode[];
  edges: CompiledEdge[];
  triggerNodeId: string | null;
  category?: string;
  tags?: string[];
  isPublic?: boolean;
}

export interface CompileWorkflowOptions {
  /**
   * Raw planner result from EigenCloud-backed planner.
   */
  plan: PlannerResult;
  /**
   * Telegram chat ID associated with this workflow (used for Telegram nodes).
   */
  chatId?: string;
  /**
   * Optional logical category for created workflows.
   */
  category?: string;
  /**
   * Optional tags to attach to the workflow.
   */
  tags?: string[];
}

export interface CompileWorkflowResult {
  workflow: CompiledWorkflow;
  warnings: string[];
  schedule?: {
    intervalSeconds: number;
    durationSeconds: number;
  };
}

const START_NODE_TYPE = 'START';
const TIME_BLOCK_NODE_TYPE = 'TIME_BLOCK';
const DEFAULT_CATEGORY = 'automation';
const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_DURATION_SECONDS = 86_400;

export function compilePlannerResultToWorkflow(options: CompileWorkflowOptions): CompileWorkflowResult {
  const { plan, chatId, category, tags } = options;

  if (!plan.steps || plan.steps.length === 0) {
    throw new Error('Cannot compile workflow: planner returned no steps.');
  }

  const warnings: string[] = [];

  const nodes: CompiledNode[] = [];
  const edges: CompiledEdge[] = [];
  let schedule: CompileWorkflowResult['schedule'];

  const firstStep = plan.steps[0];
  const hasTimeBlockTrigger = firstStep?.blockId === 'time-block';
  const stepsToCompile = hasTimeBlockTrigger ? plan.steps.slice(1) : plan.steps;
  if (stepsToCompile.length === 0) {
    throw new Error('Cannot compile workflow: time-block trigger requires at least one downstream action step.');
  }

  // 1) Trigger node
  const triggerNodeId = randomUUID();
  let triggerNode: CompiledNode;

  if (hasTimeBlockTrigger) {
    const extracted = extractScheduleFromTimeBlockStep(firstStep, warnings);
    schedule = {
      intervalSeconds: extracted.intervalSeconds,
      durationSeconds: extracted.durationSeconds,
    };

    triggerNode = {
      id: triggerNodeId,
      type: TIME_BLOCK_NODE_TYPE,
      name: 'Time Block',
      description: firstStep.purpose || 'Scheduled trigger for this workflow.',
      config: {
        recurrence: extracted.recurrence,
        stopConditions: extracted.stopConditions,
      },
      position: { x: 0, y: 0 },
      metadata: {
        blockId: firstStep.blockId,
        plannerLabel: 'Scheduled Trigger',
      },
    };
  } else {
    triggerNode = {
      id: triggerNodeId,
      type: START_NODE_TYPE,
      name: 'Start',
      description: 'Manual trigger for this workflow.',
      config: {
        triggerType: 'MANUAL',
      },
      position: {
        x: 0,
        y: 0,
      },
      metadata: {},
    };
  }
  nodes.push(triggerNode);

  // 2) One node per non-trigger planner step
  const stepNodes: CompiledNode[] = stepsToCompile.map((step, index) =>
    compileStepToNode(step, index, chatId, warnings),
  );
  nodes.push(...stepNodes);

  // 3) Linear edges: trigger -> first step -> next ...
  let previousNodeId: string | null = triggerNodeId;
  for (const node of stepNodes) {
    if (previousNodeId) {
      const edgeId = `${previousNodeId}->${node.id}`;
      edges.push({
        id: edgeId,
        sourceNodeId: previousNodeId,
        targetNodeId: node.id,
        sourceHandle: null,
        targetHandle: null,
        condition: {},
        dataMapping: {},
      });
    }
    previousNodeId = node.id;
  }

  const workflow: CompiledWorkflow = {
    name: plan.workflowName || 'Untitled Workflow',
    description: plan.description || 'Generated from natural language request.',
    nodes,
    edges,
    triggerNodeId,
    category: category ?? DEFAULT_CATEGORY,
    tags: tags ?? [],
    isPublic: false,
  };

  validateCompiledWorkflow(workflow);

  return { workflow, warnings, schedule };
}

function extractScheduleFromTimeBlockStep(
  step: PlannerStep,
  warnings: string[],
): {
  intervalSeconds: number;
  durationSeconds: number;
  recurrence: Record<string, unknown>;
  stopConditions: Record<string, unknown>;
} {
  const hints = step.configHints ?? {};

  const intervalSeconds = toPositiveInt(
    hints.intervalSeconds,
    DEFAULT_INTERVAL_SECONDS,
    'time-block intervalSeconds',
    warnings,
  );
  const durationSeconds = toPositiveInt(
    hints.durationSeconds,
    DEFAULT_DURATION_SECONDS,
    'time-block durationSeconds',
    warnings,
  );

  const recurrenceTypeHint = String(hints.recurrenceType ?? '').toUpperCase();
  const cronExpression =
    typeof hints.cronExpression === 'string' && hints.cronExpression.trim().length > 0
      ? hints.cronExpression.trim()
      : null;
  const recurrenceType =
    recurrenceTypeHint === 'CRON' || cronExpression ? 'CRON' : 'INTERVAL';

  const recurrence: Record<string, unknown> =
    recurrenceType === 'CRON'
      ? {
        type: 'CRON',
        cronExpression: cronExpression ?? '*/5 * * * *',
      }
      : {
        type: 'INTERVAL',
        intervalSeconds,
      };

  return {
    intervalSeconds,
    durationSeconds,
    recurrence,
    stopConditions: {
      durationSeconds,
    },
  };
}

function toPositiveInt(
  rawValue: unknown,
  defaultValue: number,
  field: string,
  warnings: string[],
): number {
  const asNumber =
    typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string'
        ? Number(rawValue)
        : Number.NaN;

  if (Number.isInteger(asNumber) && asNumber > 0) {
    return asNumber;
  }

  if (rawValue !== undefined) {
    warnings.push(`Invalid ${field} "${String(rawValue)}", using default ${defaultValue}.`);
  }
  return defaultValue;
}

function compileStepToNode(
  step: PlannerStep,
  index: number,
  chatId: string | undefined,
  warnings: string[],
): CompiledNode {
  const { blockId, purpose, configHints } = step;

  if (!VALID_PLANNER_BLOCK_IDS.has(blockId)) {
    throw new Error(`Unknown planner blockId "${blockId}" in step ${index + 1}.`);
  }

  const blockDef = PLANNER_BLOCKS.find((block) => block.id === blockId);
  if (!blockDef) {
    throw new Error(`No planner block definition found for "${blockId}".`);
  }

  const nodeId = randomUUID();
  const baseX = 280;
  const nodeSpacingX = 260;

  const position: CompiledNodePosition = {
    x: baseX + index * nodeSpacingX,
    y: 0,
  };

  const baseConfig: Record<string, unknown> = buildBaseConfigForBlock(blockDef.backendType, {
    purpose,
    configHints,
    chatId,
    warnings,
  });

  return {
    id: nodeId,
    type: blockDef.backendType,
    name: blockDef.label,
    description: purpose,
    config: baseConfig,
    position,
    metadata: {
      blockId,
      plannerLabel: blockDef.label,
    },
  };
}

interface BuildConfigParams {
  purpose: string;
  configHints?: Record<string, string>;
  chatId?: string;
  warnings: string[];
}

function buildBaseConfigForBlock(
  backendType: string,
  params: BuildConfigParams,
): Record<string, unknown> {
  const { purpose, configHints, chatId, warnings } = params;

  const config: Record<string, unknown> = {};

  if (configHints) {
    for (const [key, value] of Object.entries(configHints)) {
      config[key] = value;
    }
  }

  switch (backendType) {
    case 'TELEGRAM': {
      if (!config.message) {
        config.message = purpose || 'Telegram notification from workflow.';
      }
      if (!config.chatId && chatId) {
        config.chatId = chatId;
      }
      if (!config.connectionId) {
        warnings.push('Telegram block is missing connectionId and will likely fail validation.');
      }
      break;
    }
    case 'CHAINLINK_PRICE_ORACLE':
    case 'PYTH_PRICE_ORACLE':
    case 'PRICE_ORACLE': {
      if (!config.description) {
        config.description = purpose;
      }
      break;
    }
    default:
      break;
  }

  return config;
}

function validateCompiledWorkflow(workflow: CompiledWorkflow): void {
  if (!workflow.nodes || workflow.nodes.length === 0) {
    throw new Error('Compiled workflow has no nodes.');
  }

  const triggerNodes = workflow.nodes.filter(
    (node) => node.type === START_NODE_TYPE || node.type === TIME_BLOCK_NODE_TYPE,
  );
  if (triggerNodes.length !== 1) {
    throw new Error(
      `Compiled workflow must contain exactly one trigger node (START or TIME_BLOCK), found ${triggerNodes.length}.`,
    );
  }

  if (!workflow.triggerNodeId || !workflow.nodes.some((node) => node.id === workflow.triggerNodeId)) {
    throw new Error('Compiled workflow is missing a valid triggerNodeId.');
  }

  const nonTriggerNodes = workflow.nodes.filter(
    (node) => node.type !== START_NODE_TYPE && node.type !== TIME_BLOCK_NODE_TYPE,
  );
  if (nonTriggerNodes.length === 0) {
    throw new Error('Compiled workflow must contain at least one non-trigger node.');
  }

  if (!workflow.edges || workflow.edges.length < nonTriggerNodes.length) {
    throw new Error('Compiled workflow edges do not connect all nodes linearly.');
  }
}
