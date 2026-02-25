import type { FastifyBaseLogger } from 'fastify';
import { Bot } from 'grammy';
import {
  registerTextMessageHandler,
  registerOracleCallbackHandler,
} from './handlers/text-message';
import type { AgentService } from '../core/agent-service';
import type { WorkflowClient } from '../services/workflow-client';
import type { TextHandlerBackendConfig } from './handlers/text-message';

type BotLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export function createTelegramBot(token: string): Bot {
  return new Bot(token);
}

export function registerBotHandlers(
  bot: Bot,
  logger: BotLogger,
  agentService: AgentService,
  backendConfig: TextHandlerBackendConfig | undefined,
  workflowClient: WorkflowClient | null,
): void {
  registerTextMessageHandler(
    bot,
    logger,
    agentService,
    backendConfig,
    workflowClient,
  );

  registerOracleCallbackHandler(
    bot,
    logger,
    agentService,
    backendConfig,
    workflowClient,
  );

  bot.catch((error) => {
    logger.error({ error }, 'Telegram bot error');
  });
}
