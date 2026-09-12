'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  isValidHumanSupportDecision,
  normalizeHumanSupportDecision
} = require('../lib/human-support-contract');

let passed = 0;

function check(label, condition) {
  if (!condition) {
    throw new Error(label);
  }
  passed += 1;
  console.log(`[PASS] ${label}`);
}

check(
  'propose requires ai_support_insufficient',
  isValidHumanSupportDecision('propose', 'ai_support_insufficient') === true
);
check(
  'not_indicated rejects ai_support_insufficient',
  isValidHumanSupportDecision('not_indicated', 'ai_support_insufficient') ===
    false
);
check(
  'an incoherent pair falls back atomically',
  JSON.stringify(
    normalizeHumanSupportDecision(
      'not_indicated',
      'ai_support_insufficient'
    )
  ) ===
    JSON.stringify({
      proposal: 'not_indicated',
      reason: 'human_support_not_needed'
    })
);

const debugSharedSource = fs.readFileSync(
  path.join(__dirname, '../public/js/debug-shared.js'),
  'utf8'
);
const browserContext = { window: {} };
vm.runInNewContext(debugSharedSource, browserContext, {
  filename: 'public/js/debug-shared.js'
});

const normalizedDebug =
  browserContext.window.FacilitatDebug.normalizeDebugMeta({
    humanSupportProposal: 'not_indicated',
    humanSupportProposalReason: 'ai_support_insufficient',
    humanSupportProposalEffective: true
  });

check(
  'admin/chat shared normalization uses the coherent fallback reason',
  normalizedDebug.humanSupportProposalReason === 'human_support_not_needed'
);
check(
  'admin/chat shared normalization cannot expose an incoherent effective decision',
  normalizedDebug.humanSupportProposalEffective === false
);

console.log(`\n${passed} human-support contract checks passed.`);
