'use strict';
const assert = require('assert/strict');
const { databaseDouble, loadApplication } = require('./runtime.cjs');
const { createDataLifecycle } = require('../../lib/data-lifecycle');
const { createMemoryHelpers } = require('../../lib/memory');
const { JSDOM } = require('jsdom');
const { install, PREFIX } = require('../../public/js/identity-storage');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
let passed = 0,
  done = false;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
async function test(name, run) {
  await run();
  passed++;
  console.log(`PASS ${name}`);
}
const seed = () => ({
  users: {
    u_A: { authVersion: 0, email: 'a@example.test', passwordHash: 'synthetic' },
    u_B: { authVersion: 0 }
  },
  conversations: {
    c_A: { userId: 'u_A', memory: 'A' },
    c_B: { userId: 'u_B', memory: 'B' },
    c_copy: { userId: 'u_A', sourceConversationId: 'c_A' },
    c_feedback: {
      userId: 'u_A',
      sourceConversationId: 'c_A',
      feedbackSnapshot: true
    }
  },
  messages: {
    m_A: { userId: 'u_A', conversationId: 'c_A', role: 'user', content: 'A' },
    m_copy: {
      userId: 'u_A',
      conversationId: 'c_copy',
      role: 'assistant',
      content: 'COPY'
    },
    m_B: { userId: 'u_B', conversationId: 'c_B', role: 'user', content: 'B' }
  },
  branches: {
    branch_A: {
      userId: 'u_A',
      sourceConversationId: 'c_A',
      branchConversationId: 'c_copy'
    }
  },
  branchSeeds: {
    branch_A: {
      userId: 'u_A',
      sourceConversationId: 'c_A',
      messages: [{ content: 'SEED' }]
    }
  },
  contentGrants: {
    u_A: {
      pro_A: {
        active: true,
        scope: 'conversation_specific',
        conversationIds: ['c_A']
      }
    }
  },
  practitionerAssignments: {
    pro_A: { u_A: { active: true }, u_B: { active: true } }
  },
  professionalIdentities: { pro_A: { active: true, roles: ['administrator'] } }
});
const cookie = (app) =>
  'userSessionId=' + app.evaluate("buildUserSessionToken('u_A',0)");
(async () => {
  await test('enabled streaming preserves foreign public ownership refusals', async () => {
    const app = loadApplication({ seed: seed(), env: { ENABLE_CHAT_STREAMING: 'true' } });
    for (const url of ['/chat/stream', '/chat/stream/interrupted']) {
      const before = structuredClone(app.db.data);
      const response = await app.request('POST', url, { cookie: cookie(app), body: { conversationId: 'c_B', message: 'SYNTHETIC', partialReply: 'SYNTHETIC' } });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(app.db.data, before);
    }
  });
  await test('Firebase transaction initial null/retry/conflict/lost acknowledgement', async () => {
    const raw = databaseDouble(seed()),
      l = createDataLifecycle(raw);
    raw.transactionPlans.push({
      path: '',
      initialNull: true,
      conflict(data) {
        data.users.u_A.m2MemoryRevision = 1;
        data.users.u_A.intersessionMemorySource = 'MANUAL';
      }
    });
    await assert.rejects(
      l.commitMemory('u_A', {}, { intersessionMemorySource: 'OLD' }),
      /memory_superseded/
    );
    assert.equal(raw.data.users.u_A.intersessionMemorySource, 'MANUAL');
    raw.transactionPlans.push({ path: '', initialNull: true, ackLost: true });
    await assert.rejects(
      l.removeConversation('u_A', 'c_A'),
      /synthetic_ack_lost/
    );
    assert.equal(raw.data.conversations.c_A, undefined);
    await assert.rejects(
      l.db.ref('conversations/c_A').set({ userId: 'u_A' }),
      /lifecycle_conversation_retired/
    );
    assert.equal(raw.data.messages.m_B.content, 'B');
  });
  await test('query.ref, snapshot.ref and multipath updates cannot bypass fences', async () => {
    const raw = databaseDouble(seed()),
      l = createDataLifecycle(raw);
    const snapshot = await l.db.ref('messages/m_A').once('value');
    await l.removeAccount('u_A');
    await assert.rejects(
      snapshot.ref.update({ content: 'LATE' }),
      /lifecycle_/
    );
    await assert.rejects(
      l.db
        .ref('users')
        .orderByChild('email')
        .equalTo('a@example.test')
        .ref.child('u_A')
        .update({ lastActiveAt: 'LATE' }),
      /lifecycle_/
    );
    await assert.rejects(
      l.db.ref('users').update({ 'u_A/lastActiveAt': 'LATE' }),
      /lifecycle_/
    );
    await assert.rejects(l.db.ref().update({ 'users/u_A': {} }), /unscoped/);
    assert.equal(raw.data.users.u_A, undefined);
  });
  await test('known replay provenance removed only for its owner', async () => {
    const fixtures = seed();
    fixtures.conversations.c_replay = {
      userId: 'u_A',
      adminReplaySourceConversationId: 'c_A'
    };
    fixtures.conversations.c_foreign = {
      userId: 'u_B',
      adminReplaySourceConversationId: 'c_A'
    };
    const raw = databaseDouble(fixtures),
      l = createDataLifecycle(raw);
    await l.removeConversation('u_A', 'c_A');
    assert.equal(raw.data.conversations.c_replay, undefined);
    assert.equal(raw.data.conversations.c_foreign.userId, 'u_B');
  });
  await test('delete removes parent/direct/derived children atomically, retains voluntary feedback and B', async () => {
    const raw = databaseDouble(seed()),
      l = createDataLifecycle(raw);
    await l.removeConversation('u_A', 'c_A');
    assert.equal(raw.data.conversations.c_A, undefined);
    assert.equal(raw.data.conversations.c_copy, undefined);
    assert.equal(raw.data.messages.m_A, undefined);
    assert.equal(raw.data.messages.m_copy, undefined);
    assert.equal(raw.data.branches.branch_A, undefined);
    assert.equal(raw.data.branchSeeds.branch_A, undefined);
    assert(raw.data.conversations.c_feedback);
    assert.equal(raw.data.messages.m_B.content, 'B');
    assert.equal(raw.data.contentGrants.u_A.pro_A.active, false);
    assert.equal(
      raw.operations.filter((op) => op.action === 'transaction').length,
      1
    );
  });
  for (const action of ['delete', 'reset', 'close'])
    await test(`${action}: pre-admitted top-level set/fallback/audit/user writers rejected after restart`, async () => {
      const raw = databaseDouble(seed()),
        l = createDataLifecycle(raw);
      const heldMessage = {
        userId: 'u_A',
        conversationId: 'c_A',
        role: 'assistant',
        content: 'LATE'
      };
      if (action === 'delete') await l.removeConversation('u_A', 'c_A');
      else
        await l.removeAccount(
          'u_A',
          action === 'reset'
            ? { id: 'u_new', record: { authVersion: 0 } }
            : null
        );
      const restarted = createDataLifecycle(raw);
      await assert.rejects(
        restarted.db.ref('messages/m_late').set(heldMessage),
        /lifecycle_/
      );
      await assert.rejects(
        restarted.db
          .ref('messages/m_A/debugMeta')
          .update({ memoryUpdateStatus: 'completed' }),
        /lifecycle_/
      );
      await assert.rejects(
        restarted.db
          .ref('conversations/c_A')
          .transaction(() => ({ userId: 'u_A' })),
        /lifecycle_/
      );
      if (action !== 'delete') {
        for (const patch of [
          { lastActiveAt: 'LATE' },
          { intersessionMemorySource: 'LATE' },
          { intersessionRefreshForced: false }
        ])
          await assert.rejects(
            restarted.db.ref('users/u_A').update(patch),
            /lifecycle_user_retired/
          );
        assert.equal(raw.data.users.u_A, undefined);
        assert.equal(raw.data.contentGrants.u_A, undefined);
        assert.equal(raw.data.practitionerAssignments.pro_A.u_A, undefined);
        assert(raw.data.professionalIdentities.pro_A);
        assert.equal(raw.data.accountArchives, undefined);
        if (action === 'reset') assert(raw.data.users.u_new);
      }
      assert.equal(raw.data.messages.m_late, undefined);
      assert.equal(raw.data.messages.m_B.content, 'B');
    });
  await test('manual priority and reverse turn order checked at commit', async () => {
    const raw = databaseDouble(seed()),
      l = createDataLifecycle(raw);
    const first = await l.beginTurn('u_A', 'c_A'),
      second = await l.beginTurn('u_A', 'c_A');
    await l.commitTurn(
      'u_A',
      'c_A',
      second,
      { memory: 'NEW' },
      { memory: true }
    );
    await assert.rejects(
      l.commitTurn('u_A', 'c_A', first, { memory: 'OLD' }, { memory: true }),
      /memory_superseded/
    );
    const oldUser = structuredClone(raw.data.users.u_A);
    await l.commitMemory('u_A', oldUser, {
      intersessionMemorySource: 'MANUAL',
      intersessionRefreshForced: true
    });
    await assert.rejects(
      l.commitMemory('u_A', oldUser, { intersessionMemorySource: 'OLD' }),
      /memory_superseded/
    );
    await assert.rejects(
      l.commitTurn('u_A', 'c_A', second, { memory: 'OLD' }, { memory: true }),
      /memory_superseded/
    );
    assert.equal(raw.data.users.u_A.intersessionMemorySource, 'MANUAL');
    assert.equal(raw.data.conversations.c_A.memory, 'NEW');
  });
  await test('real Express delete and fresh request cannot reclaim retired ID', async () => {
    const app = loadApplication({ seed: seed() });
    const headers = { cookie: cookie(app) };
    const response = await app.request(
      'DELETE',
      '/api/account/conversations/c_A',
      { headers }
    );
    assert.equal(response.statusCode, 200);
    assert.equal(app.db.data.conversations.c_A, undefined);
    const restarted = loadApplication({ seed: app.db.data });
    const retry = await restarted.request('POST', '/chat', {
      headers: { cookie: cookie(restarted) },
      body: { conversationId: 'c_A', message: 'SYNTHETIC' }
    });
    assert.equal(retry.statusCode, 410);
    assert.equal(restarted.db.data.conversations.c_A, undefined);
    assert(
      !restarted.logs.some((row) =>
        JSON.stringify(row).includes('synthetic_llm_missing_fixture')
      )
    );
  });
  await test('disabled streaming refuses before conversation claim', async () => {
    const app = loadApplication({ seed: seed() });
    const response = await app.request('POST', '/chat/stream', {
      headers: { cookie: cookie(app) },
      body: { conversationId: 'c_new', message: 'SYNTHETIC' }
    });
    assert.equal(response.statusCode, 405);
    assert.equal(app.db.data.conversations.c_new, undefined);
  });
  await test('failed final authority read returns 503 without content or unhandled rejection', async () => {
    const app = loadApplication({ seed: seed() });
    const unhandled = [],
      handler = (error) => unhandled.push(error);
    process.on('unhandledRejection', handler);
    app.db.readFailures.push({ path: 'users/u_A', after: 2 });
    const response = await app.request('POST', '/session/close', {
      cookie: cookie(app),
      body: { conversationId: 'c_A', memory: 'SYNTHETIC_SECRET' }
    });
    await tick();
    process.removeListener('unhandledRejection', handler);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'lifecycle_availability_unknown');
    assert(!response.wire.includes('SYNTHETIC_SECRET'));
    assert.deepEqual(unhandled, []);
  });
  await test('stable rejection handled immediately; parent waits for retained sibling', async () => {
    const ongoing = deferred(),
      unhandled = [];
    const handler = (error) => unhandled.push(error);
    process.on('unhandledRejection', handler);
    let calls = 0,
      ended = false;
    const h = createMemoryHelpers({
      mistralTransport: {
        complete() {
          return ++calls === 1
            ? Promise.reject(new Error('synthetic_rejection'))
            : ongoing.promise;
        }
      },
      MISTRAL_MODEL_IDS: { memory: 'synthetic' },
      normalizeMemory: (x) => x,
      normalizeIntersessionMemory: (x) => x
    });
    const task = h.updateMemory('', []).then(
      () => {
        ended = true;
      },
      () => {
        ended = true;
      }
    );
    await tick();
    await tick();
    assert.equal(ended, false);
    assert.deepEqual(unhandled, []);
    ongoing.resolve({ content: '{"items":[]}', raw: {} });
    await task;
    process.removeListener('unhandledRejection', handler);
    assert.equal(ended, true);
  });
  for (const raw of [
    'invalid',
    '{"items":false}',
    '{"items":[1]}',
    '{"items":[""]}'
  ])
    await test(`invalid structured memory rejected (${raw})`, async () => {
      const h = createMemoryHelpers({
        mistralTransport: { complete: async () => ({ content: raw, raw: {} }) },
        MISTRAL_MODEL_IDS: { memory: 'synthetic' },
        normalizeMemory: (x) => x,
        normalizeIntersessionMemory: (x) => x
      });
      await assert.rejects(
        h.updateMemory('PREVIOUS', []),
        /memory_result_invalid/
      );
    });
  await test('business 409 retains session; identity mismatch invalidates; reset clears captured old space', async () => {
    const dom = new JSDOM('', { url: 'https://synthetic.example.test' }),
      w = dom.window;
    w.Headers = Headers;
    let code = 'memory_superseded';
    w.fetch = async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/auth/session'
            ? { authenticated: true, user: { id: 'u_A' } }
            : { code }
        ),
        { status: url === '/api/auth/session' ? 200 : 409 }
      );
    const identity = install(w);
    await identity.ready;
    const response = await w.fetch('/api/intersession-memory');
    assert.equal(response.status, 409);
    assert.equal(identity.identity, 'u_A');
    identity.local.setItem('conversation', 'A');
    const previous = identity.captureSpace();
    identity.activate('u_new');
    identity.local.setItem('conversation', 'NEW');
    previous.clear();
    assert.equal(w.localStorage.getItem(PREFIX + 'u_A:conversation'), null);
    assert.equal(identity.local.getItem('conversation'), 'NEW');
    code = 'identity_changed';
    await assert.rejects(
      w.fetch('/api/intersession-memory'),
      /Identity changed/
    );
    assert.equal(identity.identity, null);
    w.close();
  });
  done = true;
  console.log(`M2 targeted: ${passed} PASS`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
