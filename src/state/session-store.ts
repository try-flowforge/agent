import type { ChatSession } from '../types/session';

export class SessionStore {
  private readonly sessions = new Map<number, ChatSession>();

  get(chatId: number): ChatSession | undefined {
    return this.sessions.get(chatId);
  }

  upsert(session: ChatSession): void {
    this.sessions.set(session.chatId, session);
  }
}
