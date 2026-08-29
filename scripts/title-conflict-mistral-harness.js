'use strict';

const assert = require('assert');
const { createTitleConflictProtection } = require('../lib/title-conflict');

function createProtection(mistralTransport) {
  return createTitleConflictProtection({
    mistralTransport,
    analysisModelId: 'mistral-small-latest',
    titleModelId: 'mistral-title-latest',
    normalizeMemory: (value) => String(value || '')
  });
}

const promptRegistry = {
  ANALYZE_CONFLICT_MODEL: 'Detecte un conflit et reponds en JSON.',
  REWRITE_TITLE_CONFLICT_MODEL: 'Reformule uniquement le titre.'
};

async function main() {
  const requests = [];
  const protection = createProtection({
    async complete(request) {
      requests.push(request);
      if (request.model === 'mistral-small-latest') {
        return { content: '{"modelConflict": true}' };
      }
      return { content: 'Titre reformule' };
    }
  });

  assert.deepStrictEqual(
    await protection.analyzeModelConflict('Titre initial', promptRegistry),
    { modelConflict: true }
  );
  assert.strictEqual(requests[0].model, 'mistral-small-latest');
  assert.strictEqual(requests[0].maxTokens, 40);
  assert.strictEqual(
    requests[0].messages[0].content,
    promptRegistry.ANALYZE_CONFLICT_MODEL
  );

  const rewritten = await protection.rewriteConflictModelContent({
    message: 'Message utilisateur neutre',
    history: [{ role: 'assistant', content: 'Contexte neutre' }],
    memory: '',
    originalContent: 'Titre initial',
    promptRegistry
  });
  assert.strictEqual(rewritten, 'Titre reformule');
  assert.strictEqual(requests[1].model, 'mistral-title-latest');
  assert.strictEqual(requests[1].maxTokens, 500);
  assert.strictEqual(
    requests[1].messages[0].content,
    promptRegistry.REWRITE_TITLE_CONFLICT_MODEL
  );
  assert.match(requests[1].messages[1].content, /Titre initial/);

  const invalidDetection = createProtection({
    async complete() {
      return { content: 'JSON invalide' };
    }
  });
  assert.deepStrictEqual(
    await invalidDetection.analyzeModelConflict('Titre initial', promptRegistry),
    { modelConflict: false }
  );

  const unavailableDetection = createProtection({
    async complete() {
      throw new Error('provider unavailable');
    }
  });
  assert.deepStrictEqual(
    await unavailableDetection.analyzeModelConflict(
      'Titre initial',
      promptRegistry
    ),
    { modelConflict: false }
  );

  const emptyRewrite = createProtection({
    async complete() {
      return { content: '   ' };
    }
  });
  assert.strictEqual(
    await emptyRewrite.rewriteConflictModelContent({
      originalContent: 'Titre original',
      promptRegistry
    }),
    'Titre original'
  );

  const unavailableRewrite = createProtection({
    async complete() {
      throw new Error('provider unavailable');
    }
  });
  assert.strictEqual(
    await unavailableRewrite.rewriteConflictModelContent({
      originalContent: 'Titre original',
      promptRegistry
    }),
    'Titre original'
  );

  console.log('title conflict Mistral harness: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
