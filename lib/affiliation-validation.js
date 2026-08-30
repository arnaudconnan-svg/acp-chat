'use strict';

function createAffiliationShortValidationAnalyzer({
  mistralTransport,
  modelId,
  hasShortAffiliationMarker,
  trimInfoAnalysisHistory
}) {
  return async function analyzeAffiliationShortValidationCoherence(
    message = '',
    history = []
  ) {
    const trimmedMessage = String(message || '').trim();
    const normalizedLead = trimmedMessage
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2019]/g, "'");

    if (!hasShortAffiliationMarker(message)) {
      return {
        shortValidationConfirmed: true,
        source: 'deterministic_no_short_marker'
      };
    }

    if (
      /^(?:oui|exact(?:ement)?|c[' ]est\s*(?:exactement\s+)?ca)\b/.test(
        normalizedLead
      ) &&
      !/^oui\s*,?\s*mais\s+non\b/.test(normalizedLead)
    ) {
      return {
        shortValidationConfirmed: true,
        source: 'deterministic_leading_marker'
      };
    }

    const context = trimInfoAnalysisHistory(history);
    const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.content}`).join('\n')}
`;

    try {
      const response = await mistralTransport.complete({
        model: modelId,
        temperature: 0,
        maxTokens: 60,
        messages: [
          {
            role: 'system',
            content:
              "Tu determines si un marqueur lexical court de validation (ex: 'exactement', 'c'est ca') confirme reellement le message assistant precedent. Reponds STRICTEMENT en JSON: {\"shortValidationConfirmed\": true|false}. true uniquement si la validation est contextuellement coherente et non ironique/non contestataire."
          },
          { role: 'user', content: user }
        ]
      });

      const raw = String(response?.content || '')
        .replace(/```json|```/g, '')
        .trim();
      const parsed = JSON.parse(raw);
      return {
        shortValidationConfirmed: parsed.shortValidationConfirmed === true,
        source: 'llm'
      };
    } catch {
      return {
        shortValidationConfirmed: false,
        source: 'llm_fallback'
      };
    }
  };
}

module.exports = { createAffiliationShortValidationAnalyzer };
