import type { AgentSession } from './types';

export interface SessionStore {
  get(key: string): AgentSession | undefined;
  set(key: string, session: AgentSession): void;
}

export function createInMemorySessionStore(): SessionStore {
  const map = new Map<string, AgentSession>();
  return {
    get(key: string): AgentSession | undefined {
      return map.get(key);
    },
    set(key: string, session: AgentSession): void {
      map.set(key, session);
    },
  };
}
