export interface PlannerStep {
  blockId: string;
  purpose: string;
  configHints?: Record<string, string>;
}

export interface PlannerMissingInput {
  field: string;
  question: string;
}

export interface PlannerNote {
  type: 'missing_data' | 'assumption' | 'risk' | 'preference' | 'other';
  message: string;
  field?: string;
}

export interface PlannerResult {
  workflowName: string;
  description: string;
  steps: PlannerStep[];
  missingInputs: PlannerMissingInput[];
  notes?: PlannerNote[];
}
