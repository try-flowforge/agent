import type { Bot } from 'grammy';

export function registerStartCommand(bot: Bot): void {
  bot.command('start', async (ctx) => {
    await ctx.reply('FlowForge agent is online. Send any message and I will log it on the server.');
  });
}
