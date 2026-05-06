'use strict';

const {
  chatRequestSchema,
  stateProposalSchema,
  postureDecisionSchema,
  debugMetaSchema
} = require('../lib/runtime-schemas');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`[PASS] ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`[FAIL] ${label}: ${err.message}`);
    failed += 1;
  }
}

function expectSuccess(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} should succeed`);
  }
}

function expectFailure(schema, value, label) {
  const result = schema.safeParse(value);
  if (result.success) {
    throw new Error(`${label} should fail`);
  }
}

check('chatRequest accepts minimal valid payload', () => {
  expectSuccess(
    chatRequestSchema,
    {
      message: 'Bonjour',
      conversationId: 'conv_1'
    },
    'chatRequest minimal'
  );
});

check('chatRequest rejects empty message', () => {
  expectFailure(
    chatRequestSchema,
    {
      message: '   ',
      conversationId: 'conv_1'
    },
    'chatRequest empty message'
  );
});

check('stateProposal requires candidates', () => {
  expectFailure(
    stateProposalSchema,
    {
      stateCandidates: []
    },
    'stateProposal missing candidates'
  );
});

check('stateProposal accepts enriched payload', () => {
  expectSuccess(
    stateProposalSchema,
    {
      stateCandidates: [{ state: 'exploration', confidence: 'high' }],
      contactAnalysis: { isContact: false }
    },
    'stateProposal enriched'
  );
});

check('postureDecision requires conversationState', () => {
  expectFailure(
    postureDecisionSchema,
    {
      forbidden: [],
      flagUpdates: {}
    },
    'postureDecision missing conversationState'
  );
});

check('postureDecision accepts minimal valid payload', () => {
  expectSuccess(
    postureDecisionSchema,
    {
      conversationState: 'exploration_open',
      forbidden: [],
      flagUpdates: {}
    },
    'postureDecision minimal'
  );
});

check('debugMeta requires pipelineStages array', () => {
  expectFailure(
    debugMetaSchema,
    {
      conversationState: 'exploration_open'
    },
    'debugMeta missing pipelineStages'
  );
});

check('debugMeta accepts pipeline stage entries', () => {
  expectSuccess(
    debugMetaSchema,
    {
      conversationState: 'exploration_open',
      pipelineStages: [{ stage: 'suicide_analysis', deltaMs: 12 }]
    },
    'debugMeta minimal'
  );
});

console.log(`\n[RUNTIME-SCHEMAS] ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
