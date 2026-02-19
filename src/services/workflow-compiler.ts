export interface PlannerStep {
  blockId: string;
}

export interface PlannerResult {
  workflowName: string;
  steps: PlannerStep[];
}

export function compileWorkflow(_plannerResult: PlannerResult): Record<string, unknown> {
  // Placeholder scaffold for the next milestone.
  throw new Error('workflow compiler not implemented yet');
}
