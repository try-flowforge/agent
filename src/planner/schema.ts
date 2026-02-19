const stepSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['blockId', 'purpose'],
  properties: {
    blockId: { type: 'string', minLength: 1, maxLength: 100 },
    purpose: { type: 'string', minLength: 1, maxLength: 240 },
    configHints: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
};

const missingInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['field', 'question'],
  properties: {
    field: { type: 'string', minLength: 1, maxLength: 120 },
    question: { type: 'string', minLength: 1, maxLength: 240 },
  },
};

const noteSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'message'],
  properties: {
    type: {
      type: 'string',
      enum: ['missing_data', 'assumption', 'risk', 'preference', 'other'],
    },
    message: { type: 'string', minLength: 1, maxLength: 280 },
    field: { type: 'string', minLength: 1, maxLength: 120 },
  },
};

const headedSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['heading1_workflow', 'heading2_notes'],
  properties: {
    heading1_workflow: {
      type: 'object',
      additionalProperties: false,
      required: ['workflowName', 'description', 'steps'],
      properties: {
        workflowName: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', minLength: 1, maxLength: 500 },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: stepSchema,
        },
      },
    },
    heading2_notes: {
      type: 'object',
      additionalProperties: false,
      required: ['missingInputs'],
      properties: {
        missingInputs: {
          type: 'array',
          maxItems: 10,
          items: missingInputSchema,
        },
        notes: {
          type: 'array',
          maxItems: 12,
          items: noteSchema,
        },
      },
    },
  },
};

export const plannerResponseSchema: Record<string, unknown> = {
  anyOf: [headedSchema],
};
