export interface GeneratePlanInput {
  prompt: string;
}

export async function generateWorkflowPlan(_input: GeneratePlanInput): Promise<unknown> {
  // Placeholder scaffold for llm-service integration milestone.
  throw new Error('planner client not implemented yet');
}
