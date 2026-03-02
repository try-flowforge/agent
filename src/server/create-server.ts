import Fastify, { type FastifyInstance } from 'fastify';
import { webhookCallback } from 'grammy';
import type { Bot } from 'grammy';
import Redis from 'ioredis';
import rateLimit from '@fastify/rate-limit';
import type { AppEnv } from '../config/env';

export function createServer(env: AppEnv): FastifyInstance {
  const server = Fastify({ logger: true });

  // Rate limiting
  const redis = new Redis(env.redisUrl);
  server.register(rateLimit, {
    redis,
    global: true,
    max: 20,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const userId = request.headers['x-on-behalf-of'];
      return (typeof userId === 'string' ? userId : (request as any).userId) || request.ip;
    },
  });

  server.get('/health', async () => ({ ok: true, mode: env.mode }));

  return server;
}

const BACKEND_INGEST_PATH = '/api/v1/integrations/telegram/ingest';

export interface WebhookIngestConfig {
  backendBaseUrl: string;
  backendServiceKey: string;
  requestTimeoutMs?: number;
}

export function registerWebhookRoute(
  server: FastifyInstance,
  bot: Bot,
  webhookPath: string,
  ingestConfig?: WebhookIngestConfig,
): void {
  const handleUpdate = webhookCallback(bot, 'fastify');

  server.post(webhookPath, async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;

    if (ingestConfig?.backendBaseUrl && ingestConfig?.backendServiceKey && body) {
      const ingestUrl = `${ingestConfig.backendBaseUrl.replace(/\/$/, '')}${BACKEND_INGEST_PATH}`;
      const timeoutMs = ingestConfig.requestTimeoutMs ?? 10_000;
      try {
        await fetch(ingestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-service-key': ingestConfig.backendServiceKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        server.log.warn({ err }, 'Failed to forward update to backend ingest (non-fatal)');
      }
    }

    return handleUpdate(request, reply);
  });
}
