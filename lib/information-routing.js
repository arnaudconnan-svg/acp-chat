'use strict';

const { buildDefaultPromptRegistry } = require('./prompts');

function parseInfoRequestResult(rawContent = '') {
  const raw = String(rawContent || '')
    .replace(/```json|```/g, '')
    .trim();
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Invalid information request analysis');
  }
  return parsed.isInfoRequest === true;
}

function createInformationRequestAnalyzer({
  mistralTransport,
  modelId,
  trimInfoAnalysisHistory
}) {
  return async function llmInfoAnalysis(
    message = '',
    history = [],
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const context = trimInfoAnalysisHistory(history);

    try {
      const response = await mistralTransport.complete({
        model: modelId,
        temperature: 0,
        maxTokens: 60,
        messages: [
          { role: 'system', content: promptRegistry.ANALYZE_INFO },
          ...context.map((item) => ({
            role: item.role,
            content: item.content
          })),
          { role: 'user', content: message }
        ]
      });

      return {
        isInfoRequest: parseInfoRequestResult(response.content),
        source: 'llm'
      };
    } catch {
      return {
        isInfoRequest: false,
        source: 'llm_fallback'
      };
    }
  };
}

module.exports = {
  createInformationRequestAnalyzer,
  parseInfoRequestResult
};
