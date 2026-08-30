'use strict';

const assert = require('assert');
const {
  createTitleRequester,
  sanitizeGeneratedTitleCandidate
} = require('../lib/title-generation');

async function main() {
  const requests = [];
  const fakeTransport = {
    async complete(request) {
      requests.push(request);
      return { content: '  "Traverser une periode difficile"  ' };
    }
  };
  const requestTitle = createTitleRequester({
    transport: fakeTransport,
    modelId: 'mistral-small-latest'
  });
  const title = await requestTitle('Contenu utilisateur neutre', [
    'Titre deja utilise',
    'Titre deja utilise'
  ]);

  assert.strictEqual(title, 'Traverser une periode difficile');
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].model, 'mistral-small-latest');
  assert.strictEqual(requests[0].maxTokens, 30);
  assert.match(requests[0].messages[0].content, /2 a 6 mots/);
  assert.match(requests[0].messages[1].content, /Contenu utilisateur neutre/);
  assert.strictEqual(
    requests[0].messages[1].content.match(/- Titre deja utilise/g).length,
    1
  );

  assert.strictEqual(
    sanitizeGeneratedTitleCandidate('  `Titre propre` '),
    'Titre propre'
  );
  assert.strictEqual(
    sanitizeGeneratedTitleCandidate(
      'Un titre beaucoup trop long qui depasse nettement la limite'
    ),
    'Un titre beaucoup trop long qui depasse'
  );

  const failingRequester = createTitleRequester({
    modelId: 'mistral-small-latest',
    transport: {
      async complete() {
        throw new Error('provider unavailable');
      }
    }
  });
  await assert.rejects(
    () => failingRequester('Contenu neutre'),
    /provider unavailable/
  );

  console.log('title generation harness: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
