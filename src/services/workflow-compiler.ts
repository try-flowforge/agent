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
  /**
   * Telegram connection id for TELEGRAM nodes.
   */
  telegramConnectionId?: string;
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
const DEFAULT_ORACLE_CHAIN = 'ARBITRUM';
const CHAINLINK_ETH_USD_AGGREGATORS: Record<string, string> = {
  ARBITRUM: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
  ETHEREUM: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
};

/** Chainlink price feed aggregator addresses by chain and feed symbol (must match backend oracle-feeds). */
const CHAINLINK_AGGREGATORS_BY_CHAIN: Record<string, Record<string, string>> = {
  ARBITRUM: {
    'ETH/USD': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
    'BTC/USD': '0x6ce185860a4963106506C203335A2910413708e9',
    'LINK/USD': '0x86E53CF1B870786351Da77A57575e79CB55812CB',
    'ARB/USD': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
  },
};

/** Common token addresses by chain (symbol uppercase). Used to build SWAP inputConfig from planner symbols. */
const COMMON_TOKENS_BY_CHAIN: Record<
  string,
  Record<string, { address: string; symbol: string; decimals: number }>
> = {
  ARBITRUM_SEPOLIA: {
    WETH: { address: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', symbol: 'WETH', decimals: 18 },
    USDC: { address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', symbol: 'USDC', decimals: 6 },
  },
  ETHEREUM_SEPOLIA: {
    WETH: { address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', symbol: 'WETH', decimals: 18 },
    USDC: { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', symbol: 'USDC', decimals: 6 },
  },
  UNICHAIN_SEPOLIA: {
    WETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    USDC: { address: '0x31d0220469e10c4e71834a79b1f276d740d3768f', symbol: 'USDC', decimals: 6 },
  },
  ARBITRUM: {
    WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
    USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
  },
  ETHEREUM: {
    WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
  },
  UNICHAIN: {
    WETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    USDC: { address: '0x078d782b760474a361dda0af3839290b0ef57ad6', symbol: 'USDC', decimals: 6 },
  },
  BASE: {
    WETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  },
};

export function compilePlannerResultToWorkflow(options: CompileWorkflowOptions): CompileWorkflowResult {
  const { plan, chatId, category, tags, telegramConnectionId } = options;

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
    compileStepToNode(step, index, chatId, warnings, telegramConnectionId),
  );

  // Post-process nodes: if a TELEGRAM node directly follows an oracle node and
  // does not have an explicit templated message, default to showing the oracle price.
  for (let i = 0; i < stepNodes.length; i += 1) {
    const node = stepNodes[i];
    const prevNode = i > 0 ? stepNodes[i - 1] : null;
    if (
      node.type === 'TELEGRAM' &&
      prevNode &&
      (prevNode.type === 'CHAINLINK_PRICE_ORACLE' ||
        prevNode.type === 'PYTH_PRICE_ORACLE' ||
        prevNode.type === 'PRICE_ORACLE')
    ) {
      const config = node.config as Record<string, unknown>;
      const message = typeof config.message === 'string' ? config.message : '';
      // Only override when the planner did not already include a template.
      if (!message || !message.includes('{{')) {
        config.message = 'Price: ${{blocks.' + prevNode.id + '.formattedAnswer}}';
      }
    }
  }
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

/** Convert human amount (e.g. "10") to wei/smallest unit string for given decimals. */
function toWeiString(amountHuman: string, decimals: number): string {
  const n = parseFloat(amountHuman);
  if (!Number.isFinite(n) || n < 0) return '0';
  const s = n.toFixed(decimals);
  const [head, tail] = s.split('.');
  const frac = (tail ?? '').padEnd(decimals, '0').slice(0, decimals);
  return (head === '0' ? '' : head) + frac;
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
  telegramConnectionId?: string,
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
    telegramConnectionId,
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
  telegramConnectionId?: string;
}

const IF_OPERATOR_MAP: Record<string, 'lt' | 'gt' | 'lte' | 'gte' | 'equals' | 'notEquals'> = {
  '<': 'lt',
  '>': 'gt',
  '<=': 'lte',
  '>=': 'gte',
  '==': 'equals',
  '=': 'equals',
  '!=': 'notEquals',
};

/**
 * Parse a condition string like "ETH/USD < 1750" or "price > 100" into IF node config.
 * For price-feed style left sides (e.g. ETH/USD), leftPath is set to "formattedAnswer" (oracle output key).
 */
function parseIfConditionString(
  condition: string,
): { leftPath: string; operator: string; rightValue: string } | null {
  const trimmed = condition.trim();
  // Match operator (longest first): <=, >=, ==, !=, <, >, =
  const operatorMatch = trimmed.match(/\s*(<=|>=|==|!=|<|>|=)\s*/);
  if (!operatorMatch) return null;

  const op = operatorMatch[1];
  const operator = IF_OPERATOR_MAP[op];
  if (!operator) return null;

  const [left, right] = trimmed.split(operatorMatch[0], 2).map((s) => s.trim());
  if (left === undefined || right === undefined) return null;

  // Price-feed style (e.g. "ETH/USD", "BTC/USD") -> use oracle output key
  const leftPath = /^[A-Z0-9]+\/[A-Z0-9]+$/i.test(left)
    ? 'formattedAnswer'
    : left;

  return {
    leftPath,
    operator,
    rightValue: right,
  };
}

function looksLikePriceFeedPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  const s = path.trim();
  return (
    /^[A-Z0-9]+\/[A-Z0-9]+$/i.test(s) ||
    /^[A-Z0-9]+\/[A-Z0-9]+\s+price$/i.test(s) ||
    /^[A-Z0-9]+USD$/i.test(s) ||
    s.toLowerCase() === 'price'
  );
}

function buildBaseConfigForBlock(
  backendType: string,
  params: BuildConfigParams,
): Record<string, unknown> {
  const { purpose, configHints, chatId, warnings, telegramConnectionId } = params;

  const config: Record<string, unknown> = {};

  if (configHints) {
    for (const [key, value] of Object.entries(configHints)) {
      config[key] = value;
    }
  }

  switch (backendType) {
    case 'SWAP': {
      const chain = normalizeChain(config.chain);
      config.chain = chain;
      const providerRaw = config.provider ?? 'UNISWAP_V4';
      config.provider =
        typeof providerRaw === 'string' && /^[A-Z_0-9]+$/.test(providerRaw)
          ? providerRaw
          : 'UNISWAP_V4';
      const tokens = COMMON_TOKENS_BY_CHAIN[chain];
      const fromSymbol = String(config.fromToken ?? config.sourceToken ?? '')
        .trim()
        .toUpperCase();
      const toSymbol = String(config.toToken ?? config.destinationToken ?? '')
        .trim()
        .toUpperCase();
      const amountHuman = String(config.amount ?? '0').trim();
      const sourceToken = tokens?.[fromSymbol]
        ? { address: tokens[fromSymbol].address, symbol: tokens[fromSymbol].symbol, decimals: tokens[fromSymbol].decimals }
        : { address: (config.sourceToken as any)?.address ?? '0x0000000000000000000000000000000000000000', symbol: fromSymbol || '', decimals: 18 };
      const destinationToken = tokens?.[toSymbol]
        ? { address: tokens[toSymbol].address, symbol: tokens[toSymbol].symbol, decimals: tokens[toSymbol].decimals }
        : { address: (config.destinationToken as any)?.address ?? '0x0000000000000000000000000000000000000000', symbol: toSymbol || '', decimals: 18 };
      const amountWei = toWeiString(amountHuman, sourceToken.decimals);
      config.inputConfig = {
        sourceToken,
        destinationToken,
        amount: amountWei,
        swapType: (config.swapType as string) === 'EXACT_OUTPUT' ? 'EXACT_OUTPUT' : 'EXACT_INPUT',
        walletAddress: (config.walletAddress as string)?.match(/^0x[a-fA-F0-9]{40}$/)
          ? (config.walletAddress as string)
          : '0x0000000000000000000000000000000000000000',
        slippageTolerance: typeof config.slippageTolerance === 'number' ? config.slippageTolerance : 0.5,
      };
      if (!tokens?.[fromSymbol] || !tokens?.[toSymbol]) {
        warnings.push(
          `SWAP: unknown token symbol(s) for chain ${chain}; using placeholder addresses. fromToken=${fromSymbol || '?'}, toToken=${toSymbol || '?'}.`
        );
      }
      delete (config as any).fromToken;
      delete (config as any).toToken;
      delete (config as any).sourceToken;
      delete (config as any).destinationToken;
      break;
    }
    case 'TELEGRAM': {
      if (telegramConnectionId && !config.connectionId) {
        config.connectionId = telegramConnectionId;
      }
      if (!config.message && typeof config.text === 'string' && config.text.trim().length > 0) {
        config.message = config.text.trim();
      }
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
    case 'IF': {
      // Planner may send condition as a string (e.g. "ETH/USD < 1750"). Parse into leftPath, operator, rightValue.
      const conditionStr = typeof config.condition === 'string' ? config.condition.trim() : '';
      if (conditionStr) {
        const parsed = parseIfConditionString(conditionStr);
        if (parsed) {
          config.leftPath = parsed.leftPath;
          config.operator = parsed.operator;
          config.rightValue = parsed.rightValue;
        }
        delete (config as Record<string, unknown>).condition;
      }
      if (!config.leftPath) config.leftPath = '';
      if (!config.operator) config.operator = 'equals';
      if (config.rightValue === undefined) config.rightValue = '';
      // Planner sometimes sends leftPath like "ETH/USD price" or "ETHUSD"; normalize to oracle output key.
      if (typeof config.leftPath === 'string' && looksLikePriceFeedPath(config.leftPath)) {
        config.leftPath = 'formattedAnswer';
      }
      break;
    }
    case 'CHAINLINK_PRICE_ORACLE':
    case 'PYTH_PRICE_ORACLE':
    case 'PRICE_ORACLE': {
      const provider = normalizeOracleProvider(config.provider, backendType);
      config.provider = provider;
      const chain = normalizeChain(config.chain);
      config.chain = chain;

      if (provider === 'CHAINLINK' && !config.aggregatorAddress) {
        const feedKey =
          typeof config.feed === 'string' && config.feed.trim()
            ? String(config.feed).trim().toUpperCase().replace(/\s+/g, '')
            : '';
        if (feedKey) {
          const byChain = CHAINLINK_AGGREGATORS_BY_CHAIN[chain];
          const addr = byChain?.[feedKey];
          if (addr) {
            config.aggregatorAddress = addr;
          }
        }
        if (!config.aggregatorAddress) {
          const guessed = guessAggregatorFromHints(chain, configHints);
          if (guessed) {
            config.aggregatorAddress = guessed;
          }
        }
      }

      if (provider === 'CHAINLINK' && !config.aggregatorAddress) {
        config.aggregatorAddress =
          CHAINLINK_ETH_USD_AGGREGATORS[chain] ?? CHAINLINK_ETH_USD_AGGREGATORS.ARBITRUM;
        warnings.push('Oracle block missing aggregatorAddress; defaulted to Chainlink ETH/USD feed.');
      }

      if (provider === 'PYTH' && !config.priceFeedId) {
        warnings.push('Pyth oracle block missing priceFeedId and will likely fail validation.');
      }

      if (!config.staleAfterSeconds) {
        config.staleAfterSeconds = 3600;
      }

      if (typeof config.output === 'string' && config.output.trim().length > 0 && !config.outputMapping) {
        config.outputMapping = { [config.output.trim()]: 'formattedAnswer' };
      }

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

function normalizeChain(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_ORACLE_CHAIN;
  const normalized = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return normalized || DEFAULT_ORACLE_CHAIN;
}

function normalizeOracleProvider(raw: unknown, backendType: string): 'CHAINLINK' | 'PYTH' {
  if (typeof raw === 'string') {
    const normalized = raw.trim().toUpperCase();
    if (normalized === 'PYTH') return 'PYTH';
    if (normalized === 'CHAINLINK') return 'CHAINLINK';
  }
  return backendType === 'PYTH_PRICE_ORACLE' ? 'PYTH' : 'CHAINLINK';
}

function guessAggregatorFromHints(
  chain: string,
  configHints?: Record<string, string>,
): string | null {
  const feed = String(configHints?.feed ?? '').toUpperCase().replace(/\s+/g, '');
  const asset = String(configHints?.asset ?? '').toUpperCase();
  const currency = String(configHints?.currency ?? '').toUpperCase();
  const isEthUsd = feed === 'ETH/USD' || (asset === 'ETH' && currency === 'USD');

  if (!isEthUsd) return null;
  return CHAINLINK_ETH_USD_AGGREGATORS[chain] ?? CHAINLINK_ETH_USD_AGGREGATORS.ARBITRUM;
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
