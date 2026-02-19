export interface CreateWorkflowInput {
  workflow: Record<string, unknown>;
  onBehalfOfUserId: string;
}

export async function createWorkflow(_input: CreateWorkflowInput): Promise<unknown> {
  // Placeholder scaffold for backend execution bridge milestone.
  throw new Error('backend client not implemented yet');
}
