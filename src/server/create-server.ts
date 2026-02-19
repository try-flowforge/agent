import Fastify, { type FastifyInstance } from 'fastify';
import { webhookCallback } from 'grammy';
import type { Bot } from 'grammy';
import type { BotMode } from '../config/env';

export function createServer(mode: BotMode): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get('/health', async () => ({ ok: true, mode }));

  return server;
}

export function registerWebhookRoute(
  server: FastifyInstance,
  bot: Bot,
  webhookPath: string,
): void {
  server.post(webhookPath, webhookCallback(bot, 'fastify'));
}
