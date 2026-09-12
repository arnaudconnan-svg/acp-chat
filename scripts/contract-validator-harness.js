'use strict';

// ─── contract-validator harness ─────────────────────────────────────────────
// Pure deterministic checks for posture contracts and writer mode tables.
// No server, no LLM, no network.

const { buildPostureDecision } = require('../lib/pipeline');

const { buildDefaultPromptRegistry } = require('../lib/prompts');

const { createWriter } = require('../lib/writer');

const {
  CONVERSATION_STATES,
  STATE_FORBIDDEN,
  STATE_ALLOWED,
  STATE_INTENT
} = require('../lib/conversation-state');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`[FAIL] ${label}: ${err.message}`);
  }
}

function baseInput(overrides = {}) {
  return {
    detectedState: 'exploration',
    contactAnalysis: { selfCriticismLevel: null, insightMoment: false },
    relationalAdjustmentAnalysis: { needsRelationalAdjustment: false },
    calibrationAnalysis: {
      calibrationLevel: 0,
      explorationSignal: 'interpretation'
    },
    technicalContextDetected: false,
    interpretationRejection: {
      isInterpretationRejection: false,
      needsSoberReadjustment: false,
      rejectsUnderlyingPhenomenon: false,
      tensionHoldLevel: 'medium'
    },
    effectiveExplorationDirectivityLevel: 0,
    previousConversationState: 'exploration',
    affiliationEstablished: true,
    currentConsecutiveNonExplorationTurns: 0,
    currentExplorationRelanceWindow: [false, false, false, false],
    allianceSignal: 'good',
    engagementLevel: 'active',
    attentionWindow: 'open',
    closureIntent: false,
    message: '',
    recentHistory: [],
    ...overrides
  };
}

function createWriterForHarness() {
  return createWriter({
    mistralTransport: {
      complete: async () => ({ content: '', usage: null }),
      stream: async () => ({ content: '', usage: null })
    },
    MISTRAL_MODEL_IDS: { generation: 'test-model' },
    normalizeMemory: (value) => String(value || '')
  });
}

// Maps each base CONVERSATION_STATE to its extended STATE_ALLOWED key candidates.
// discharge → ["discharge_regulated", "discharge_dysregulated"] ; etc.
function expectedStatesForBaseState(state) {
  if (state === 'exploration')
    return ['exploration_open', 'exploration_restrained'];
  if (state === 'discharge')
    return ['discharge_regulated', 'discharge_dysregulated'];
  if (state === 'info')
    return ['info_pure', 'info_psychoeducation', 'info_features'];
  return [state]; // alliance_rupture, need_human_support, closure
}

check('state tables are aligned', () => {
  const allowedKeys = Object.keys(STATE_ALLOWED).sort();
  const forbiddenKeys = Object.keys(STATE_FORBIDDEN).sort();
  const intentKeys = Object.keys(STATE_INTENT).sort();

  assert(
    JSON.stringify(allowedKeys) === JSON.stringify(forbiddenKeys),
    'STATE_FORBIDDEN keys mismatch STATE_ALLOWED'
  );
  assert(
    JSON.stringify(allowedKeys) === JSON.stringify(intentKeys),
    'STATE_INTENT keys mismatch STATE_ALLOWED'
  );
});

check('every conversation state maps to a known extended state', () => {
  const stateSet = new Set(Object.keys(STATE_ALLOWED));
  for (const state of CONVERSATION_STATES) {
    const candidates = expectedStatesForBaseState(state);
    for (const extState of candidates) {
      assert(
        stateSet.has(extState),
        `base state '${state}' maps to unknown extended state '${extState}'`
      );
    }
  }
});

check('posture decision always returns known conversationState', () => {
  const stateSet = new Set(Object.keys(STATE_ALLOWED));

  const cases = [
    baseInput({
      detectedState: 'exploration',
      calibrationAnalysis: {
        calibrationLevel: 0,
        explorationSignal: 'interpretation'
      }
    }),
    baseInput({
      detectedState: 'exploration',
      calibrationAnalysis: {
        calibrationLevel: 3,
        explorationSignal: 'interpretation'
      },
      effectiveExplorationDirectivityLevel: 4
    }),
    baseInput({ detectedState: 'discharge_regulated' }),
    baseInput({ detectedState: 'discharge_dysregulated' }),
    baseInput({ detectedState: 'info_pure' }),
    baseInput({ detectedState: 'info_psychoeducation' }),
    baseInput({ detectedState: 'info_features' }),
    baseInput({ detectedState: 'exploration', allianceSignal: 'rupture' }),
    baseInput({ detectedState: 'exploration', closureIntent: true }),
    baseInput({
      detectedState: 'exploration',
      attentionWindow: 'overloaded',
      engagementLevel: 'withdrawn'
    })
  ];

  for (const input of cases) {
    const out = buildPostureDecision(input);
    assert(
      stateSet.has(out.conversationState),
      `unknown conversationState '${out.conversationState}'`
    );
  }
});

check('confidenceSignal is float between 0 and 1', () => {
  const cases = [
    baseInput({
      message: 'je sais pas',
      recentHistory: [{ role: 'user', content: "c'est pas ca" }]
    }),
    baseInput({
      message: 'ok',
      recentHistory: [{ role: 'user', content: 'merci' }]
    })
  ];

  for (const input of cases) {
    const out = buildPostureDecision(input);
    assert(
      typeof out.confidenceSignal === 'number' &&
        out.confidenceSignal >= 0 &&
        out.confidenceSignal <= 1,
      `invalid confidenceSignal '${out.confidenceSignal}' (must be number 0.00-1.00)`
    );
  }
});

check('relancePolicy follows contract constraints', () => {
  const openExploration = buildPostureDecision(
    baseInput({
      detectedState: 'exploration',
      effectiveExplorationDirectivityLevel: 0,
      calibrationAnalysis: {
        calibrationLevel: 0,
        explorationSignal: 'interpretation'
      }
    })
  );
  assert(
    openExploration.relancePolicy === 'open',
    'exploration level 0 should keep relance open'
  );

  const selectiveExploration = buildPostureDecision(
    baseInput({
      detectedState: 'exploration',
      effectiveExplorationDirectivityLevel: 4,
      calibrationAnalysis: {
        calibrationLevel: 4,
        explorationSignal: 'interpretation'
      }
    })
  );
  assert(
    selectiveExploration.relancePolicy === 'selective',
    'exploration level 4 should keep relance selective'
  );

  const ruptureForbidden = buildPostureDecision(
    baseInput({
      detectedState: 'exploration',
      allianceSignal: 'rupture'
    })
  );
  assert(
    ruptureForbidden.relancePolicy === 'forbidden',
    'alliance_rupture should forbid relance'
  );
});

check('intervention feedback forbids every form of relance', () => {
  const out = buildPostureDecision(
    baseInput({
      interpretationRejection: {
        isInterpretationRejection: true,
        rejectsUnderlyingPhenomenon: false,
        relationalFrictionSignal: 'strong'
      }
    })
  );
  assert(out.relancePolicy === 'forbidden', 'feedback must forbid relance');
  assert(out.forbidden.includes('relance'), 'relance must be forbidden');
  assert(
    out.finalDirectivityLevel >= 3,
    'feedback must produce a restrained response'
  );
});

check('forbidden relance gives the writer a contradiction-free contract', () => {
  const writer = createWriterForHarness();
  const posture = buildPostureDecision(
    baseInput({ allianceSignal: 'rupture' })
  );
  const contract = writer.buildPostureContractBlock(posture);
  assert(
    contract.includes('aucune question, invitation ou affirmation'),
    'writer contract must prohibit interrogative and declarative relances'
  );
  assert(
    !contract.includes("n'ouvre pas de relance"),
    'obsolete, underspecified relance instruction must be absent'
  );
});

check('writer contract keeps relational repair non-solutionist', () => {
  const writer = createWriterForHarness();
  const contract = writer.buildPostureContractBlock({
    conversationState: 'alliance_rupture',
    humanSupportProposal: 'propose',
    humanSupportProposalEffective: true,
    humanHandoffAvailable: true
  });

  assert(
    contract.includes('Le caractere facultatif ou non prescriptif'),
    'optional wording must not permit a fabricated solution'
  );
  assert(
    contract.includes("changer effectivement de conduite signifie seulement"),
    'relational repair must be explicitly bounded'
  );
  assert(
    contract.includes('simple presence dans la memoire ne suffit jamais'),
    'remembered people must not automatically become resources'
  );
  assert(
    contract.includes('Ressources relationnelles personnelles a proposer ce tour'),
    'personal resources must be driven by the semantic proposal'
  );
  assert(
    contract.includes('nomme-les obligatoirement'),
    'established personal resources must be named'
  );
  assert(
    contract.includes("tu n'inventes rien"),
    'personal resources must never be invented'
  );
  assert(
    contract.includes(
      "peut coexister avec l'option professionnelle Facilitat.io"
    ),
    'personal and professional support must remain independent'
  );
  assert(
    contract.includes("Demander a en parler avec un professionnel humain"),
    'professional handoff option must use its precise UI label'
  );
});

check('writer contract gates personal resources on the semantic decision', () => {
  const writer = createWriterForHarness();
  const contract = writer.buildPostureContractBlock({
    humanSupportProposal: 'not_indicated',
    humanSupportProposalEffective: true,
    humanHandoffAvailable: true
  });

  assert(
    contract.includes("n'invite pas spontanement la personne a contacter"),
    'not_indicated must prohibit a spontaneous personal-support invitation'
  );
  assert(
    contract.includes('relation deja au centre du recit'),
    'the guard must preserve discussion of an existing relational topic'
  );
  assert(
    contract.includes('envie de contact amenee par la personne'),
    'the guard must preserve user-initiated contact wishes'
  );
  assert(
    !contract.includes('Ressources relationnelles personnelles a proposer ce tour'),
    'an effective professional proposal must not enable personal resources'
  );
  assert(
    !contract.includes('nomme-les obligatoirement'),
    'not_indicated must not inject the personal-resource naming rule'
  );
});

check('personal and professional support remain independently gated', () => {
  const writer = createWriterForHarness();
  const unavailableContract = writer.buildPostureContractBlock({
    humanSupportProposal: 'propose',
    humanSupportProposalEffective: false,
    humanHandoffAvailable: false
  });
  const availableContract = writer.buildPostureContractBlock({
    humanSupportProposal: 'propose',
    humanSupportProposalEffective: true,
    humanHandoffAvailable: true
  });

  for (const contract of [unavailableContract, availableContract]) {
    assert(
      contract.includes('nomme-les obligatoirement'),
      'propose must preserve qualified personal-resource naming regardless of handoff availability'
    );
  }
  assert(
    !unavailableContract.includes('Relais humain a proposer ce tour'),
    'technical unavailability must suppress the professional option'
  );
  assert(
    availableContract.includes('Relais humain a proposer ce tour'),
    'technical availability must preserve the professional option alongside personal resources'
  );
});

check('rejected intervention cannot return as a softer assertion', () => {
  const writer = createWriterForHarness();
  const block = writer.buildInterpretationRejectionPromptBlock({
    isInterpretationRejection: true,
    needsSoberReadjustment: true,
    phenomenonAnchorInstruction: 'keep_if_concrete',
    tensionHoldLevel: 'medium'
  });
  assert(
    block.includes('meme adouci, indirect ou transforme en affirmation'),
    'rejection block must prevent softened reproposals'
  );
  assert(
    block.includes('feedback sur ton intervention'),
    'rejection block must prioritize intervention feedback'
  );
});

check('situated impasse activates action collapse guard', () => {
  const out = buildPostureDecision(
    baseInput({
      detectedState: 'exploration',
      technicalContextDetected: true
    })
  );
  assert(
    out.actionCollapseGuardActive === true,
    'actionCollapseGuardActive should be true'
  );
  assert(
    out.forbidden.includes('action_concrete_proposal'),
    'forbidden should include action_concrete_proposal'
  );
});

check('narrowed processing adds soft attention guidance hint', () => {
  const out = buildPostureDecision(
    baseInput({
      detectedState: 'exploration',
      engagementAllianceAnalysis: {
        allianceSignal: 'good',
        engagementLevel: 'active',
        attentionQuality: 'narrowed'
      }
    })
  );
  assert(
    out.writerIntentHints.includes('attention_engagement_soft_guidance'),
    'narrowed processing must add soft attention guidance hint'
  );
  assert(
    !out.writerIntentHints.includes('attention_narrow_single_axis'),
    'attention_narrow_single_axis should be absent'
  );
});

check(
  'info features prompt enforces Option B for bot nature and capacity doubts',
  () => {
    const prompt = String(
      buildDefaultPromptRegistry().STATE_INFO_FEATURES || ''
    );
    const optionBCount = (prompt.match(/Option B \(obligatoire\)/g) || [])
      .length;
    assert(
      optionBCount >= 2,
      'expected Option B policy in both bot_nature_question and bot_capacity_doubt sections'
    );
    assert(
      prompt.includes('mouvement 1 : transparence minimale'),
      'missing movement 1 transparency rule'
    );
    assert(
      prompt.includes('mouvement 2 : retour immediat'),
      'missing movement 2 return-to-user rule'
    );
  }
);

check('writer contract forces formalAddress over hint examples', () => {
  const writer = createWriterForHarness();
  const contract = writer.buildPostureContractBlock({
    conversationState: 'exploration_open',
    formalAddress: true,
    useDirectAddress: true,
    writerIntentHints: ['hold_emotional_thread']
  });

  assert(
    contract.includes('convertis-le mentalement en vouvoiement'),
    'formalAddress should override tutoiement examples in hints'
  );
  assert(
    contract.includes(
      "Chaque phrase qui s'adresse a la personne doit utiliser vous/votre/vos"
    ),
    'formalAddress hard constraint missing'
  );
});

check('procedural temptation hint avoids golden canned formula', () => {
  const writer = createWriterForHarness();
  const contract = writer.buildPostureContractBlock({
    conversationState: 'exploration_open',
    writerIntentHints: [
      'procedural_temptation_light',
      'procedural_temptation_neutral'
    ]
  });

  assert(
    !contract.includes(
      'Je pourrais facilement vous repondre de facon tres technique'
    ),
    'golden procedural formula should be removed'
  );
  assert(
    !contract.includes(
      'Je sens la tentation de vous faire une reponse bien rangee'
    ),
    'second canned procedural formula should be removed'
  );
  assert(
    contract.includes('sans formule figee'),
    'procedural_temptation_light should forbid canned phrasing'
  );
  assert(
    contract.includes('sans phrase signature'),
    'procedural_temptation_neutral should forbid signature phrasing'
  );
});

if (failed > 0) {
  console.error(`\n[CONTRACT-VALIDATOR] ${passed} passed, ${failed} failed.`);
  process.exit(1);
}

console.log(`\n[CONTRACT-VALIDATOR] ${passed} checks passed.`);
