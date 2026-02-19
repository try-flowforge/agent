export interface ChatSession {
  chatId: number;
  linkedUserId?: string;
  stage: 'idle' | 'awaiting_link' | 'draft_created' | 'awaiting_confirmation';
  pendingWorkflowJson?: Record<string, unknown>;
  updatedAt: string;
}
