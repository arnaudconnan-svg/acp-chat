'use strict';

function sanitizeGeneratedTitleCandidate(value = '') {
  let title = String(value || '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (title.length > 40) {
    title = title.slice(0, 40).trim();
  }

  return title;
}

function createTitleRequester({ transport, modelId }) {
  if (!transport || typeof transport.complete !== 'function') {
    throw new TypeError('A Mistral transport is required for title generation');
  }

  return async function requestTitleFromLlm(
    sourceText = '',
    forbiddenTitles = []
  ) {
    const effectiveForbidden = Array.from(
      new Set(
        forbiddenTitles
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    ).slice(0, 80);
    const avoidBlock =
      effectiveForbidden.length > 0
        ? [
            'Titres interdits (ne pas proposer ces formulations exactes, meme avec ponctuation/casse differente) :',
            ...effectiveForbidden.map((title) => `- ${title}`)
          ].join('\n')
        : 'Aucun titre interdit fourni.';

    const completion = await transport.complete({
      model: modelId,
      temperature: 0.2,
      maxTokens: 30,
      messages: [
        {
          role: 'system',
          content: [
            'Tu generes un titre tres court en francais pour une conversation.',
            'Contraintes :',
            '- 2 a 6 mots',
            '- pas de guillemets',
            "- pas d'emoji",
            '- pas de point final',
            '- formulation naturelle et specifique',
            '- ne recopie pas simplement le premier message',
            "- ne commence pas par Verbatim de type Je, J, Tu, Mon, Ma sauf si c'est indispensable",
            '- respecte strictement la liste des titres interdits'
          ].join('\n')
        },
        {
          role: 'user',
          content: `${sourceText}\n\n${avoidBlock}`
        }
      ]
    });

    return sanitizeGeneratedTitleCandidate(completion.content);
  };
}

module.exports = {
  createTitleRequester,
  sanitizeGeneratedTitleCandidate
};
