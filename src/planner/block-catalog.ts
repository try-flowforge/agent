export interface PlannerBlockDefinition {
  id: string;
  backendType: string;
  label: string;
  description: string;
}

export const PLANNER_BLOCKS: PlannerBlockDefinition[] = [
  { id: 'api', backendType: 'API', label: 'HTTP Request', description: 'Make HTTP calls to external APIs.' },
  {
    id: 'time-block',
    backendType: 'TIME_BLOCK',
    label: 'Scheduled Trigger',
    description:
      'Run workflow on a schedule (one-time, interval, or cron). Use for delayed or recurring workflows.',
  },
  { id: 'telegram', backendType: 'TELEGRAM', label: 'Telegram', description: 'Send message updates to Telegram chat.' },
  { id: 'slack', backendType: 'SLACK', label: 'Slack', description: 'Send a message to Slack.' },
  { id: 'mail', backendType: 'EMAIL', label: 'Email', description: 'Send email notification.' },
  { id: 'if', backendType: 'IF', label: 'If / Condition', description: 'Branch flow based on condition true/false.' },
  { id: 'switch', backendType: 'SWITCH', label: 'Switch', description: 'Route by multiple conditional cases.' },
  { id: 'wallet', backendType: 'WALLET', label: 'Wallet', description: 'Access wallet context for onchain actions.' },
  { id: 'uniswap', backendType: 'SWAP', label: 'Uniswap Swap', description: 'Swap tokens on one chain.' },
  { id: 'oneinch', backendType: 'SWAP', label: '1inch Swap', description: 'Swap tokens through 1inch aggregator.' },
  { id: 'lifi', backendType: 'SWAP', label: 'LiFi', description: 'Cross-chain bridge/swap flow.' },
  { id: 'relay', backendType: 'SWAP', label: 'Relay', description: 'Relay-powered token/tx routing.' },
  { id: 'aave', backendType: 'LENDING', label: 'Aave', description: 'Lending operations with Aave.' },
  { id: 'compound', backendType: 'LENDING', label: 'Compound', description: 'Lending operations with Compound.' },
  { id: 'chainlink', backendType: 'CHAINLINK_PRICE_ORACLE', label: 'Chainlink', description: 'Read price/data from Chainlink feed.' },
  { id: 'pyth', backendType: 'PYTH_PRICE_ORACLE', label: 'Pyth', description: 'Read price/data from Pyth feed.' },
  {
    id: 'ai-openai-chatgpt',
    backendType: 'LLM_TRANSFORM',
    label: 'ChatGPT',
    description: 'AI transform/generation using OpenAI model.',
  },
  {
    id: 'ai-openrouter-qwen-free',
    backendType: 'LLM_TRANSFORM',
    label: 'Qwen',
    description: 'AI transform/generation using OpenRouter Qwen.',
  },
  {
    id: 'ai-openrouter-glm-free',
    backendType: 'LLM_TRANSFORM',
    label: 'GLM',
    description: 'AI transform/generation using OpenRouter GLM.',
  },
  {
    id: 'ai-openrouter-deepseek-free',
    backendType: 'LLM_TRANSFORM',
    label: 'DeepSeek',
    description: 'AI transform/generation using OpenRouter DeepSeek.',
  },
];

export const VALID_PLANNER_BLOCK_IDS = new Set(PLANNER_BLOCKS.map((block) => block.id));
