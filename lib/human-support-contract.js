'use strict';

const HUMAN_SUPPORT_REASONS_BY_PROPOSAL = Object.freeze({
  propose: Object.freeze(['ai_support_insufficient']),
  not_indicated: Object.freeze([
    'advice_request_only',
    'explicit_request_existing_path',
    'human_support_not_needed'
  ]),
  already_addressed: Object.freeze(['already_proposed_or_declined'])
});

function isValidHumanSupportDecision(proposal, reason) {
  return (
    Object.prototype.hasOwnProperty.call(
      HUMAN_SUPPORT_REASONS_BY_PROPOSAL,
      proposal
    ) && HUMAN_SUPPORT_REASONS_BY_PROPOSAL[proposal].includes(reason)
  );
}

function normalizeHumanSupportDecision(proposal, reason) {
  if (isValidHumanSupportDecision(proposal, reason)) {
    return { proposal, reason };
  }

  return {
    proposal: 'not_indicated',
    reason: 'human_support_not_needed'
  };
}

module.exports = {
  isValidHumanSupportDecision,
  normalizeHumanSupportDecision
};
