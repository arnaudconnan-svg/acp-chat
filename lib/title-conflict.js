'use strict';

function createTitleConflictProtection({
  mistralTransport,
  analysisModelId,
  titleModelId,
  normalizeMemory
}) {
  async function analyzeModelConflict(content = '', promptRegistry = {}) {
    try {
      const response = await mistralTransport.complete({
        model: analysisModelId,
        temperature: 0,
        maxTokens: 40,
        messages: [
          { role: 'system', content: promptRegistry.ANALYZE_CONFLICT_MODEL },
          { role: 'user', content }
        ]
      });
      const raw = String(response?.content || '')
        .replace(/```json|```/g, '')
        .trim();
      const parsed = JSON.parse(raw);
      return { modelConflict: parsed.modelConflict === true };
    } catch {
      return { modelConflict: false };
    }
  }

  async function rewriteConflictModelContent({
    message = '',
    history = [],
    memory = '',
    originalContent,
    promptRegistry = {}
  }) {
    const user = `
Message utilisateur :
${message}

Contexte recent :
${history.map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.content}`).join('\n')}

Memoire :
${normalizeMemory(memory, promptRegistry)}

Contenu initial a reformuler :
${originalContent}
`;

    try {
      const response = await mistralTransport.complete({
        model: titleModelId,
        temperature: 0.3,
        maxTokens: 500,
        messages: [
          {
            role: 'system',
            content: promptRegistry.REWRITE_TITLE_CONFLICT_MODEL
          },
          { role: 'user', content: user }
        ]
      });
      return String(response?.content || '').trim() || originalContent;
    } catch {
      return originalContent;
    }
  }

  return { analyzeModelConflict, rewriteConflictModelContent };
}

module.exports = { createTitleConflictProtection };
