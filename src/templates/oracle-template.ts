import type { PlannerResult, PlannerStep } from '../planner/plan-types';

export interface OracleTemplateToken {
  id: string;
  symbol: string;
  pairSymbol: string;
  name: string;
}

export const ORACLE_TEMPLATE_TOKENS: OracleTemplateToken[] = [
  { id: 'ETH_USD', symbol: 'ETH', pairSymbol: 'ETH/USD', name: 'Ethereum / US Dollar' },
  { id: 'BTC_USD', symbol: 'BTC', pairSymbol: 'BTC/USD', name: 'Bitcoin / US Dollar' },
  { id: 'LINK_USD', symbol: 'LINK', pairSymbol: 'LINK/USD', name: 'Chainlink / US Dollar' },
  { id: 'ARB_USD', symbol: 'ARB', pairSymbol: 'ARB/USD', name: 'Arbitrum / US Dollar' },
];

/**
 * Build a natural-language prompt for the planner to create
 * a Chainlink + Telegram workflow for the given token on Arbitrum.
 *
 * This keeps the existing LLM-based planning and backend behavior;
 * we simply constrain the request shape based on a curated token list.
 */
export function buildOraclePrompt(token: OracleTemplateToken): string {
  const base = `Fetch the latest Chainlink price for ${token.pairSymbol} on ARBITRUM and send it to this Telegram chat.`;

  const details =
    `Use a single Chainlink oracle step (blockId \"chainlink\") with configHints.feed set to exactly \"${token.pairSymbol}\" and chain set to \"ARBITRUM\". ` +
    'Do NOT use any other feed symbol like \"ETH/USD\" or defaults. ' +
    'Then add a Telegram notification step (blockId \"telegram\") that sends a concise message including the human-readable price. ' +
    'Do not ask the user follow-up questions if you can infer everything from context; prefer reasonable defaults. ' +
    'Keep the workflow linear: chainlink -> telegram. ' +
    'Use ARBITRUM as the chain unless the context explicitly says otherwise.';

  return `${base}${details}`;
}

export function buildOraclePlan(token: OracleTemplateToken): PlannerResult {
  const steps: PlannerStep[] = [
    {
      blockId: 'chainlink',
      purpose: `${token.pairSymbol} price on ARBITRUM`,
      configHints: {
        feed: token.pairSymbol,
        chain: 'ARBITRUM',
      },
    },
    {
      blockId: 'telegram',
      purpose: `Price for ${token.pairSymbol} on ARBITRUM`,
      // message left to compiler/oracle post-processing to inject formattedAnswer
      configHints: {},
    },
  ];

  return {
    workflowName: `${token.pairSymbol} price on Arbitrum (Chainlink)`,
    description: `Fetches the latest Chainlink price feed for ${token.pairSymbol} on Arbitrum and sends it to this Telegram chat.`,
    steps,
    missingInputs: [],
    notes: [],
  };
}
