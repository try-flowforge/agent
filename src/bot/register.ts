import type { FastifyBaseLogger } from 'fastify';
import { Bot } from 'grammy';
import {
  registerTextMessageHandler,
  registerOracleCallbackHandler,
} from './handlers/text-message';
import { limit } from '@grammyjs/ratelimiter';
import Redis from 'ioredis';
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
  rateLimitConfig: {
    redisUrl: string;
    limitMax: number;
    limitWindowMs: number;
  },
): void {
  // Apply rate limiting middleware
  const redis = new Redis(rateLimitConfig.redisUrl);
  bot.use(
    limit({
      timeFrame: rateLimitConfig.limitWindowMs,
      limit: rateLimitConfig.limitMax,
      storageClient: redis,
      onLimitExceeded: async (ctx) => {
        await ctx.reply(
          'You are sending messages too fast. Please wait a moment.',
        );
      },
      keyGenerator: (ctx) => {
        return ctx.from?.id.toString() ?? ctx.chat?.id.toString() ?? '';
      },
    }),
  );
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
