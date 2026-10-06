'use strict';
const assert = require('assert/strict');
const { loadApplication } = require('./runtime.cjs');
const { JSDOM } = require('jsdom');
const { create } = require('../../public/js/identity-storage');
const {
  buildSafeConversationData
} = require('../../public/js/conversation-data');
const { createAnalyzers } = require('../../lib/analyzers');
const { createMemoryHelpers } = require('../../lib/memory');
const { Writable } = require('stream');
const pino = require('pino');
const {
  createProjectedLogger,
  projectLog
} = require('../../lib/log-projection');
let done = false;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const oldState = {
  sessionStableContext: ['PRIVATE_STABLE'],
  onGoingMovements: [
    {
      id: 'movement_old',
      text: 'PRIVATE_OLD',
      createdAt: '2026-10-01T12:00:00.000Z',
      archivedAt: null
    }
  ],
  ancientMovements: []
};
const memory =
  'Contexte stable:\n- PRIVATE_STABLE\n\nMouvements en cours:\n- PRIVATE_NEXT\n\nAnciens mouvements:\n-';
function fixtures(
  writer = async () => ({ reply: 'SYNTHETIC_REPLY' }),
  suicideLevel = 'N2'
) {
  return {
    './lib/analyzers': {
      createAnalyzers: (options) => ({
        ...createAnalyzers(options),
        analyzeImminentMajorHarmRisk: async () => ({ harmRiskLevel: 'H0' }),
        analyzeSuicideRisk: async () => ({ suicideLevel })
      })
    },
    './lib/writer': { createWriter: () => ({ generateReply: writer }) },
    './lib/memory': {
      createMemoryHelpers: (options) => ({
        ...createMemoryHelpers(options),
        updateMemory: async () => ({
          memoryText: memory,
          source: 'synthetic_fixture'
        }),
        updateIntersessionMemory: async () => {
          throw new Error('private_intersession_forbidden');
        }
      })
    }
  };
}
function cookie(app, id) {
  return 'userSessionId=' + app.evaluate(`buildUserSessionToken('${id}',0)`);
}
(async () => {
  let logWire = '';
  const sink = new Writable({
    write(chunk, encoding, callback) {
      logWire += chunk;
      callback();
    }
  });
  const productionLogger = createProjectedLogger(pino, sink);
  const app = loadApplication({
    seed: {
      users: { u_A: { authVersion: 0 }, u_B: { authVersion: 0 } },
      conversations: {
        c_A: { userId: 'u_A' },
        c_B: { userId: 'u_B', memory: 'FOREIGN_MEMORY' },
        c_removed: { userId: 'u_A', deletedAt: '2026-10-01' }
      },
      messages: {
        m_B: { userId: 'u_B', conversationId: 'c_B', content: 'FOREIGN' }
      }
    },
    overrides: {
      ...fixtures(),
      './lib/logger': {
        logger: productionLogger,
        childLogger: (bindings) => productionLogger.child(projectLog(bindings))
      }
    }
  });
  const a = cookie(app, 'u_A'),
    b = cookie(app, 'u_B');
  const body = {
    message: 'PRIVATE_TRANSCRIPT',
    conversationId: 'c_B',
    isPrivateConversation: true,
    requestId: 'request_same',
    memory: 'Contexte stable:\n- PRIVATE_STABLE',
    memoryState: oldState,
    flags: {},
    recentHistory: []
  };
  const before = structuredClone(app.db.data);
  const first = await app.request('post', '/chat', { cookie: a, body });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.reply, 'SYNTHETIC_REPLY');
  assert.equal(first.body.memoryState.ancientMovements[0].id, 'movement_old');
  assert.equal(
    first.body.memoryState.ancientMovements[0].createdAt,
    oldState.onGoingMovements[0].createdAt
  );
  assert(first.body.memoryState.ancientMovements[0].archivedAt);
  assert.equal(first.body.memoryState.onGoingMovements[0].text, 'PRIVATE_NEXT');
  assert.equal(
    first.body.debugMeta.memoryState.onGoingMovements[0].id,
    'movement_old',
    'debug remains N-1'
  );
  assert.deepEqual(app.db.data, before, 'private turn has no durable effect');
  assert.equal(
    app.evaluate(
      'conversationMemorySyncLocks.size+conversationTurnCounters.size+conversationRelanceAsyncState.size'
    ),
    0,
    'private turn leaves no inter-request conversational state'
  );
  assert(
    ![
      'PRIVATE_TRANSCRIPT',
      'PRIVATE_STABLE',
      'PRIVATE_OLD',
      'PRIVATE_NEXT',
      'FOREIGN_MEMORY'
    ].some((marker) => logWire.includes(marker)),
    'actual server outputs pass production minimization'
  );
  assert(
    !app.db.operations.some(
      (op) =>
        op.path.startsWith('conversations/') ||
        op.path.startsWith('messages') ||
        op.path.startsWith('privateConversation')
    ),
    'private transit never reads foreign object'
  );
  const dom = new JSDOM('', { url: 'https://synthetic.example.test' }),
    storage = create(dom.window.localStorage, dom.window.sessionStorage);
  storage.activate('u_A');
  storage.local.setItem(
    'private',
    JSON.stringify(
      buildSafeConversationData({
        ...first.body,
        messages: [{ role: 'user', content: body.message }]
      })
    )
  );
  const reloaded = create(dom.window.localStorage, dom.window.sessionStorage);
  reloaded.activate('u_A');
  const local = JSON.parse(reloaded.local.getItem('private'));
  assert.deepEqual(local.memoryState, first.body.memoryState);
  const cold = loadApplication({ seed: app.db.data, overrides: fixtures() });
  const second = await cold.request('post', '/chat', {
    cookie: a,
    body: {
      ...body,
      memory: local.memory,
      memoryState: local.memoryState,
      recentHistory: local.messages
    }
  });
  assert.equal(second.body.reply, 'SYNTHETIC_REPLY');
  assert(
    second.body.memoryState.ancientMovements.some(
      (m) => m.id === 'movement_old'
    )
  );
  const other = await cold.request('post', '/chat', {
    cookie: b,
    body: {
      ...body,
      memory: '',
      memoryState: {
        sessionStableContext: [],
        onGoingMovements: [],
        ancientMovements: []
      }
    }
  });
  assert(!JSON.stringify(other.body).includes('PRIVATE_OLD'));
  assert(!JSON.stringify(other.body).includes('movement_old'));
  assert.deepEqual(cold.db.data, before);
  const normal = loadApplication({
    seed: before,
    overrides: fixtures(undefined, 'N0')
  });
  const normalReply = await normal.request('post', '/chat', {
    cookie: a,
    body: { ...body, flags: {} }
  });
  assert.equal(
    normalReply.body.reply,
    'SYNTHETIC_REPLY',
    'full normal pipeline witness'
  );
  assert(normalReply.body.memoryState);
  assert.deepEqual(normal.db.data, before);
  // Tokens continue before the private final memory consolidation completes.
  let releaseMemory, enterMemory;
  const memoryEntered = new Promise((resolve) => (enterMemory = resolve));
  const streamingFixtures = fixtures(async ({ onTokenCallback }) => {
    onTokenCallback?.('STREAM_TOKEN');
    return { reply: 'STREAM_TOKEN' };
  });
  const baseMemory = streamingFixtures['./lib/memory'];
  streamingFixtures['./lib/memory'] = {
    createMemoryHelpers: (options) => ({
      ...baseMemory.createMemoryHelpers(options),
      updateMemory: async () => {
        enterMemory();
        await new Promise((resolve) => (releaseMemory = resolve));
        return { memoryText: memory };
      }
    })
  };
  const streaming = loadApplication({
    seed: before,
    overrides: streamingFixtures,
    env: { ENABLE_CHAT_STREAMING: 'true' }
  });
  let streamWire = '';
  let completed = false;
  const stream = streaming
    .request('post', '/chat/stream', {
      cookie: a,
      body,
      onWire: (chunk) => (streamWire += chunk)
    })
    .then((result) => {
      completed = true;
      return result;
    });
  await memoryEntered;
  for (let i = 0; i < 20 && !streamWire.includes('STREAM_TOKEN'); i++)
    await tick();
  assert(streamWire.includes('STREAM_TOKEN'));
  assert.equal(
    completed,
    false,
    'only the final result waits for local durable state'
  );
  releaseMemory();
  assert((await stream).wire.includes('PRIVATE_NEXT'));
  assert.deepEqual(streaming.db.data, before);
  for (const [method, url, payload] of [
    ['post', '/chat', { message: 'x', conversationId: 'c_B' }],
    ['post', '/chat/stream', { message: 'x', conversationId: 'c_B' }],
    ['get', '/api/account/conversations/c_B', {}],
    ['patch', '/api/account/conversations/c_B', { title: 'x' }],
    ['post', '/api/conversations/c_B/title', { title: 'x' }],
    [
      'post',
      '/api/messages/m_B/feedback',
      { type: 'thumbUp', adminShare: true }
    ],
    ['post', '/session/close', { conversationId: 'c_B' }],
    ['post', '/api/branches/from-message', { sourceConversationId: 'c_B' }],
    [
      'post',
      '/api/branches/create-and-activate',
      { sourceConversationId: 'c_B' }
    ],
    ['post', '/api/account/conversations/claim', { conversationIds: ['c_B'] }],
    [
      'post',
      '/chat/stream/interrupted',
      { conversationId: 'c_B', partialReply: 'x' }
    ]
  ]) {
    const snapshot = structuredClone(app.db.data),
      response = await app.request(method, url, { cookie: a, body: payload });
    assert([400, 403, 404].includes(response.statusCode), url);
    assert.deepEqual(app.db.data, snapshot, url + ' refused before effect');
  }
  assert.equal(
    (
      await app.request('get', '/api/account/conversations/c_removed', {
        cookie: a
      })
    ).statusCode,
    403
  );
  assert.equal(
    (
      await app.request('get', '/api/account/conversations/missing', {
        cookie: a
      })
    ).statusCode,
    404
  );
  assert.equal(
    (
      await app.request('get', '/api/account/conversations/c_A', {
        cookie: a,
        headers: { 'x-client-identity': 'u_B' }
      })
    ).statusCode,
    409
  );
  const own = await app.request('post', '/api/conversations/c_A/title', {
    cookie: a,
    body: { title: 'OWNED' }
  });
  assert.equal(own.statusCode, 200);
  assert.equal(app.db.data.conversations.c_A.title, 'OWNED');
  // Real operation registry and real HTTP routes: same client id in A and B,
  // owner cancel, duplicate lease, then reversed finalization.
  app.evaluate(
    "registerActiveChatRequest(operationKey('u_A','same'),'u_A','old');registerActiveChatRequest(operationKey('u_B','same'),'u_B','b')"
  );
  const collision = await app.request('post', '/chat', {
    cookie: a,
    body: { ...body, requestId: 'same' }
  });
  assert.equal(collision.statusCode, 409);
  assert.equal(
    app.evaluate("activeChatRequests.get(operationKey('u_A','same')).lease"),
    'old'
  );
  assert.equal(
    (
      await app.request('post', '/chat/cancel', {
        cookie: a,
        body: { requestId: 'same' }
      })
    ).body.canceled,
    true
  );
  assert.equal(
    app.evaluate("isActiveChatRequestCanceled(operationKey('u_B','same'))"),
    false
  );
  assert.equal(
    (
      await app.request('get', '/chat/progress', {
        cookie: a,
        query: { requestId: 'unknown' }
      })
    ).statusCode,
    404
  );
  const progress = app.request('get', '/chat/progress', {
    cookie: b,
    query: { requestId: 'same' }
  });
  for (
    let i = 0;
    i < 20 &&
    !app.evaluate("activeChatProgressStreams.has(operationKey('u_B','same'))");
    i++
  )
    await tick();
  assert(
    app.evaluate("activeChatProgressStreams.has(operationKey('u_B','same'))"),
    'authorized stream is attached before finalization'
  );
  app.evaluate("finalizeActiveChatRequest(operationKey('u_B','same'),'b')");
  const progressResult = await progress;
  assert.equal(progressResult.statusCode, 200, JSON.stringify(progressResult));
  assert(progressResult.wire.includes('event: ready'), progressResult.wire);
  app.evaluate(
    "registerActiveChatRequest(operationKey('u_A','same'),'u_A','new');finalizeActiveChatRequest(operationKey('u_A','same'),'old')"
  );
  assert.equal(
    app.evaluate("activeChatRequests.get(operationKey('u_A','same')).lease"),
    'new'
  );
  app.evaluate("finalizeActiveChatRequest(operationKey('u_A','same'),'new')");
  // Voluntary private feedback is exactly the bounded public pair, distinct from
  // private chat state. Refusal without explicit share, positive with share.
  const feedback = {
    type: 'thumbDown',
    userContent: 'x'.repeat(9000),
    botContent: 'y'.repeat(9000),
    adminShare: true,
    mailsEnabled: false
  };
  assert.equal(
    (
      await app.request('post', '/api/branches/feedback-snapshot', {
        cookie: a,
        body: { ...feedback, adminShare: false }
      })
    ).statusCode,
    400
  );
  const shared = await app.request('post', '/api/branches/feedback-snapshot', {
    cookie: a,
    body: feedback
  });
  assert.equal(shared.statusCode, 201);
  const copied = Object.values(app.db.data.messages).filter(
    (m) => m.conversationId === shared.body.snapshotConversationId
  );
  assert.equal(copied.length, 2);
  assert(copied.every((m) => m.content.length === 8000 && m.userId === 'u_A'));
  // Ownership removed while generation is pending: no assistant or memory effect.
  let release, entered;
  const inWriter = new Promise((resolve) => (entered = resolve));
  const race = loadApplication({
    seed: {
      users: { u_A: { authVersion: 0 } },
      conversations: {
        c_A: { userId: 'u_A', title: 'fixed', titleLocked: true }
      }
    },
    overrides: fixtures(async () => {
      entered();
      await new Promise((resolve) => (release = resolve));
      return { reply: 'RACE_REPLY' };
    })
  });
  const pending = race.request('post', '/chat', {
    cookie: cookie(race, 'u_A'),
    body: {
      message: 'start',
      conversationId: 'c_A',
      requestId: 'race',
      recentHistory: [],
      flags: {}
    }
  });
  await inWriter;
  race.db.data.conversations.c_A.userId = 'u_B';
  release();
  await pending;
  await tick();
  await tick();
  assert(
    !Object.values(race.db.data.messages || {}).some(
      (m) => m.role === 'assistant'
    )
  );
  assert.equal(race.db.data.conversations.c_A.memory, undefined);
  dom.window.close();
  done = true;
  console.log(
    '[PASS] G02 actual routes/effects, scopes/cancel/progress/leases; G04 private multi-turn/device reload/cold restart and bounded feedback'
  );
})().catch((error) => {
  done = true;
  console.error(error);
  process.exitCode = 1;
});
