'use strict';

const { z } = require('zod');

const historyEntrySchema = z.object({
  role: z.string().trim().min(1),
  content: z.string(),
  signals: z.record(z.any()).optional()
});

const chatRequestSchema = z.object({
  message: z.string().trim().min(1),
  requestId: z.string().trim().optional(),
  conversationId: z.string().trim().min(1),
  isPrivateConversation: z.boolean().optional(),
  recentHistory: z.array(historyEntrySchema).optional(),
  conversationBranchHistory: z
    .array(historyEntrySchema.omit({ signals: true }))
    .optional()
});

const stateCandidateSchema = z
  .object({
    state: z.string().trim().min(1).optional(),
    family: z.string().trim().min(1).optional(),
    confidence: z.union([z.string(), z.number()]).optional()
  })
  .passthrough();

const stateProposalSchema = z
  .object({
    stateCandidates: z.array(stateCandidateSchema).min(1),
    contactAnalysis: z.any().optional(),
    dischargeAnalysis: z.any().optional()
  })
  .passthrough();

const postureDecisionSchema = z
  .object({
    conversationState: z.string().trim().min(1),
    forbidden: z.array(z.string()),
    flagUpdates: z.record(z.any())
  })
  .passthrough();

const debugMetaSchema = z
  .object({
    conversationState: z.string().trim().min(1),
    pipelineStages: z.array(
      z
        .object({
          stage: z.string().trim().min(1),
          deltaMs: z.number().nullable().optional()
        })
        .passthrough()
    )
  })
  .passthrough();

function formatIssues(result) {
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const pathLabel =
      Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.join('.')
        : 'value';
    return `${pathLabel}: ${issue.message}`;
  });
}

function validateShape(schema, payload) {
  return formatIssues(schema.safeParse(payload));
}

module.exports = {
  chatRequestSchema,
  stateProposalSchema,
  postureDecisionSchema,
  debugMetaSchema,
  validateShape
};
