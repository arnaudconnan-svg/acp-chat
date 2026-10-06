'use strict';
const assert = require('assert/strict');
const { loadApplication } = require('./runtime.cjs');
let done = false;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
const token = (app) =>
  'userSessionId=' + app.evaluate("buildUserSessionToken('u_A',0)");
(async () => {
  const app = loadApplication({
    seed: {
      users: { u_A: { authVersion: 0 }, u_B: { authVersion: 0 } },
      conversations: {
        c_A: { userId: 'u_A', title: 'A' },
        c_B: { userId: 'u_B', memory: 'B_MEMORY' },
        c_private: { userId: 'u_A', isPrivate: true },
        c_removed: { userId: 'u_A', deletedAt: 1 }
      },
      messages: {
        m_A: {
          id: 'contradictory',
          userId: 'u_A',
          conversationId: 'c_A',
          role: 'user',
          content: 'OWNED',
          timestamp: 1
        },
        m_B: {
          userId: 'u_B',
          conversationId: 'c_A',
          role: 'user',
          content: 'B_CHILD'
        },
        m_unknown: {
          conversationId: 'c_A',
          role: 'assistant',
          content: 'UNKNOWN_CHILD'
        },
        m_private: {
          userId: 'u_A',
          conversationId: 'c_A',
          isPrivate: true,
          role: 'assistant',
          content: 'PRIVATE_CHILD'
        },
        m_orphan: {
          userId: 'u_B',
          conversationId: 'c_orphan',
          role: 'user',
          content: 'ORPHAN'
        }
      },
      branches: {},
      branchSeeds: {}
    }
  });
  const cookie = token(app);
  const read = await app.request('get', '/api/account/conversations/c_A', {
    cookie
  });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(
    read.body.messages.map((m) => [m.id, m.content]),
    [['m_A', 'OWNED']]
  );
  assert(!JSON.stringify(read.body).includes('B_CHILD'));
  assert(!JSON.stringify(read.body).includes('UNKNOWN_CHILD'));
  assert(!JSON.stringify(read.body).includes('PRIVATE_CHILD'));
  const history = await app.evaluate(
    "loadConversationBranchHistoryForRecall({userId:'u_A',conversationId:'c_A'})"
  );
  assert.deepEqual(JSON.parse(JSON.stringify(history)), [
    { role: 'user', content: 'OWNED' }
  ]);
  const created = await app.request('post', '/api/branches/from-message', {
    cookie,
    body: { sourceConversationId: 'c_A', anchorMessageId: 'm_A' }
  });
  assert.equal(created.statusCode, 201);
  const branchId = created.body.branch.id;
  // Resolve the real configured namespaces rather than inventing fake route state.
  const branchPath = app.db.operations.find(
    (op) =>
      op.action === 'set' &&
      op.path.endsWith('/' + branchId) &&
      !op.path.includes('Snapshots')
  ).path;
  const branchRoot = branchPath.split('/')[0];
  const branch = app.db.data[branchRoot][branchId];
  const seedPath = app.db.operations.find(
    (op) =>
      op.action === 'set' &&
      op.path.endsWith('/' + branchId) &&
      op.path !== branchPath
  ).path;
  const seedRoot = seedPath.split('/')[0];
  const seed = app.db.data[seedRoot][branchId];
  assert.equal(seed.messages.length, 1);
  assert.equal(seed.messages[0].content, 'OWNED');
  for (const method of ['get', 'post'])
    for (const corruption of [
      'destination',
      'source',
      'seed',
      'seedOwner',
      'invalidPath'
    ]) {
      const validBranch = structuredClone(branch),
        validSeed = structuredClone(seed);
      if (corruption === 'destination') branch.branchConversationId = 'c_B';
      if (corruption === 'source') branch.sourceConversationId = 'c_B';
      if (corruption === 'seed') seed.sourceConversationId = 'c_B';
      if (corruption === 'seedOwner') seed.userId = 'u_B';
      if (corruption === 'invalidPath')
        branch.branchConversationId = 'c_B/path';
      const before = structuredClone(app.db.data);
      const r = await app.request(
        method,
        '/api/branches/' + branchId + (method === 'post' ? '/activate' : ''),
        { cookie, body: { memory: 'ATTACK', flags: { acuteCrisis: true } } }
      );
      assert.equal(r.statusCode, 403, corruption);
      assert.deepEqual(app.db.data, before, 'no mutation for ' + corruption);
      Object.assign(branch, validBranch);
      Object.assign(seed, validSeed);
    }
  assert.equal(
    (await app.request('get', '/api/branches/' + branchId, { cookie }))
      .statusCode,
    200
  );
  const activation = await app.request(
    'post',
    '/api/branches/' + branchId + '/activate',
    {
      cookie,
      body: {
        memory: 'Contexte stable:\n- OWNED_MEMORY',
        flags: { acuteCrisis: false }
      }
    }
  );
  assert.equal(activation.statusCode, 200);
  assert.equal(
    app.db.data.conversations[branch.branchConversationId].userId,
    'u_A'
  );
  assert.equal(app.db.data.conversations.c_B.memory, 'B_MEMORY');
  const foreignSeed = await app.request(
    'post',
    '/api/branches/create-and-activate',
    {
      cookie,
      body: {
        sourceConversationId: 'c_A',
        anchorMessageId: 'm_B',
        seedMessages: [{ id: 'm_B', role: 'user', content: 'B_CHILD' }]
      }
    }
  );
  assert([403, 404].includes(foreignSeed.statusCode));
  const incoming = (id) => ({
    id,
    title: 'Publication volontaire',
    isPrivate: true,
    memoryState: {
      sessionStableContext: ['LOCAL_FULL_STATE'],
      onGoingMovements: [],
      ancientMovements: []
    },
    messages: [{ role: 'user', content: 'LOCAL_PUBLIC_COPY' }]
  });
  for (const id of [
    'c_B',
    'c_orphan',
    'c_private',
    'c_removed',
    'c_A',
    'bad/path',
    '../c_B',
    'c_B%2fpath',
    ''
  ]) {
    const before = structuredClone(app.db.data);
    const r = await app.request(
      'post',
      '/api/account/conversations/import-local',
      { cookie, body: { conversations: [incoming(id)], forceOverwrite: true } }
    );
    assert([400, 403].includes(r.statusCode), id);
    assert.deepEqual(app.db.data, before, 'refusal has no effects: ' + id);
  }
  const mixedBefore = structuredClone(app.db.data);
  assert.equal(
    (
      await app.request('post', '/api/account/conversations/import-local', {
        cookie,
        body: { conversations: [incoming('c_new_batch'), incoming('c_orphan')] }
      })
    ).statusCode,
    403
  );
  assert.deepEqual(app.db.data, mixedBefore, 'full batch is validated first');
  const published = await app.request(
    'post',
    '/api/account/conversations/import-local',
    { cookie, body: { conversations: [incoming('c_published')] } }
  );
  assert.equal(published.statusCode, 200);
  assert.equal(app.db.data.conversations.c_published.userId, 'u_A');
  assert.equal(app.db.data.conversations.c_published.isPrivate, false);
  assert.deepEqual(
    app.db.data.conversations.c_published.memoryState,
    incoming('x').memoryState
  );
  const beforeB = structuredClone(app.db.data.conversations.c_B),
    beforeOrphan = structuredClone(app.db.data.messages.m_orphan);
  const overwritten = await app.request(
    'post',
    '/api/account/conversations/import-local',
    {
      cookie,
      body: {
        forceOverwrite: true,
        conversations: [
          {
            ...incoming('c_published'),
            messages: [{ role: 'user', content: 'REPLACEMENT' }]
          }
        ]
      }
    }
  );
  assert.equal(overwritten.statusCode, 200);
  const replacement = Object.values(app.db.data.messages).filter(
    (m) => m.conversationId === 'c_published'
  );
  assert.equal(replacement.length, 1);
  assert.equal(replacement[0].content, 'REPLACEMENT');
  assert.deepEqual(app.db.data.conversations.c_B, beforeB);
  assert.deepEqual(app.db.data.messages.m_orphan, beforeOrphan);
  done = true;
  console.log(
    '[PASS] G02 parent/child ownership for reads/chat recall/seeds, contradictory branches, orphan/collision/path imports and bounded authorized overwrite'
  );
})().catch((error) => {
  done = true;
  console.error(error);
  process.exitCode = 1;
});
