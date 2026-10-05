'use strict';
const assert = require('assert/strict');
const { loadApplication } = require('./runtime.cjs');
const { hashPassword } = require('../../lib/auth-password');
let done = false,
  passed = 0;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
async function test(name, run) {
  await run();
  passed++;
  console.log('PASS ' + name);
}
const memoryFixture = () => ({
  sessionStableContext: ['SYNTHETIC_STABLE'],
  onGoingMovements: [
    {
      id: 'ongoing_id',
      text: 'SYNTHETIC_CURRENT',
      createdAt: '2026-10-01T10:00:00.000Z',
      archivedAt: null
    }
  ],
  ancientMovements: [
    {
      id: 'ancient_id',
      text: 'SYNTHETIC_ARCHIVE',
      createdAt: '2026-09-01T10:00:00.000Z',
      archivedAt: '2026-10-01T10:00:00.000Z'
    }
  ]
});
const seed = () => ({
  users: {
    u_A: {
      authVersion: 0,
      email: 'consumer@example.test',
      passwordHash: 'SYNTHETIC_HASH'
    },
    u_B: { authVersion: 0 }
  },
  professionalIdentities: {
    p_A: {
      email: 'operator@example.test',
      passwordHash: hashPassword('Synthetic123!Password'),
      active: true,
      roles: ['administrator'],
      authorizationVersion: 1
    }
  },
  conversations: {
    c_A: { userId: 'u_A', memory: 'SOURCE' },
    c_B: { userId: 'u_B', memory: 'FOREIGN' }
  },
  messages: {
    m_A: {
      userId: 'u_A',
      conversationId: 'c_A',
      role: 'user',
      content: 'SYNTHETIC',
      timestamp: 1,
      stateSnapshot: {
        memory: 'SOURCE',
        memoryState: memoryFixture(),
        flags: { important: true }
      }
    }
  }
});
async function make() {
  const app = loadApplication({ seed: seed() });
  const cookie =
    'userSessionId=' + app.evaluate("buildUserSessionToken('u_A',0)");
  const login = await app.request('POST', '/api/pros/login', {
    body: { email: 'operator@example.test', password: 'Synthetic123!Password' }
  });
  assert.equal(login.statusCode, 200);
  const admin = {
    cookie: login.headers['set-cookie'].split(';')[0],
    headers: { 'x-access-reason': 'support_incident' }
  };
  return { app, cookie, admin };
}
const request = (extra = {}) => ({
  sourceConversationId: 'c_A',
  anchorMessageId: 'm_A',
  operationId: 'op_branch',
  ...extra
});
const replay = (extra = {}) => ({
  writeIntent: 'create',
  operationId: 'op_replay',
  conversation: {
    id: 'c_replay',
    sourceConversationId: 'c_A',
    anchorMessageId: 'm_A',
    memory: 'SYNTHETIC',
    messages: [{ role: 'user', content: 'SYNTHETIC', timestamp: 1 }]
  },
  ...extra
});
(async () => {
  for (const endpoint of ['from-message', 'create-and-activate'])
    await test(`${endpoint}: lost ack + cold retry returns one canonical copy`, async () => {
      const { app, cookie } = await make();
      app.db.transactionPlans.push({
        path: '',
        initialNull: true,
        ackLost: true
      });
      const body = request();
      const lost = await app.request('POST', '/api/branches/' + endpoint, {
        cookie,
        body
      });
      assert.equal(lost.statusCode, 503, lost.wire);
      const before = structuredClone(app.db.data);
      const restarted = loadApplication({ seed: before });
      const again = await restarted.request(
        'POST',
        '/api/branches/' + endpoint,
        { cookie, body }
      );
      assert.equal(again.statusCode, 200, again.wire);
      assert.equal(again.body.replayed, true);
      assert.equal(Object.keys(restarted.db.data.branches).length, 1);
      assert.deepEqual(restarted.db.data.messages, before.messages);
      if (endpoint === 'create-and-activate') {
        const child = Object.values(restarted.db.data.messages).find(
          (m) => m.conversationId === again.body.branch.branchConversationId
        );
        assert.deepEqual(
          child.stateSnapshot,
          seed().messages.m_A.stateSnapshot
        );
      }
    });
  await test('prepared activation retry preserves destination work and canonical structured snapshot', async () => {
    const { app, cookie } = await make();
    const created = await app.request('POST', '/api/branches/from-message', {
      cookie,
      body: request()
    });
    assert.equal(created.statusCode, 201, created.wire);
    const id = created.body.branch.id,
      destination = created.body.branch.branchConversationId;
    const first = await app.request('POST', `/api/branches/${id}/activate`, {
      cookie,
      body: { memory: 'INITIAL', flags: {} }
    });
    assert.equal(first.statusCode, 200, first.wire);
    await app.evaluate(
      `db.ref('conversations/${destination}').update({memory:'EDITED'})`
    );
    const retry = await app.request('POST', `/api/branches/${id}/activate`, {
      cookie,
      body: { memory: 'INITIAL', flags: {} }
    });
    assert.equal(retry.statusCode, 200, retry.wire);
    assert.equal(app.db.data.conversations[destination].memory, 'EDITED');
    const children = Object.values(app.db.data.messages).filter(
      (m) => m.conversationId === destination
    );
    assert.equal(children.length, 1);
    assert.deepEqual(
      children[0].stateSnapshot,
      seed().messages.m_A.stateSnapshot
    );
  });
  for (const action of [
    'delete_destination',
    'delete_source',
    'reset',
    'close'
  ])
    await test(`${action} erases receipts, retry cannot recreate after restart`, async () => {
      const { app, cookie } = await make();
      const created = await app.request(
        'POST',
        '/api/branches/create-and-activate',
        { cookie, body: request() }
      );
      assert.equal(created.statusCode, 201, created.wire);
      const destination = created.body.branch.branchConversationId;
      app.db.data.copyReceipts.foreign = {
        userId: 'u_B',
        sourceConversationId: 'c_B',
        destinationId: 'c_B',
        messageIds: []
      };
      const url = action.startsWith('delete')
        ? '/api/account/conversations/' +
          (action === 'delete_source' ? 'c_A' : destination)
        : '/api/account/' + action;
      const removed = await app.request(
        action.startsWith('delete') ? 'DELETE' : 'POST',
        url,
        { cookie, body: {} }
      );
      assert.equal(removed.statusCode, 200, removed.wire);
      assert(
        !Object.values(app.db.data.copyReceipts).some((r) => r.userId === 'u_A')
      );
      assert(app.db.data.copyReceipts.foreign);
      const restarted = loadApplication({ seed: app.db.data });
      const retry = await restarted.request(
        'POST',
        '/api/branches/create-and-activate',
        { cookie, body: request() }
      );
      assert(retry.statusCode >= 400, retry.wire);
      assert.equal(restarted.db.data.conversations[destination], undefined);
      assert.equal(restarted.db.data.conversations.c_B.memory, 'FOREIGN');
    });
  await test('foreign anchor/owner and contradictory seed rejected without copy effects', async () => {
    const { app, cookie } = await make();
    app.db.data.messages.m_B = {
      userId: 'u_B',
      conversationId: 'c_A',
      role: 'user',
      content: 'FOREIGN',
      timestamp: 2
    };
    for (const body of [
      request({ anchorMessageId: 'm_B' }),
      request({ sourceConversationId: 'c_B' }),
      request({
        seedMessages: [
          { id: 'm_A', userId: 'u_B', role: 'user', content: 'SYNTHETIC' }
        ]
      })
    ]) {
      const before = structuredClone(app.db.data);
      const r = await app.request('POST', '/api/branches/create-and-activate', {
        cookie,
        body
      });
      assert(r.statusCode >= 400, r.wire);
      assert.deepEqual(app.db.data.conversations, before.conversations);
      assert.deepEqual(app.db.data.messages, before.messages);
      assert.equal(app.db.data.copyReceipts, undefined);
    }
  });
  for (const mutation of ['new_turn', 'edit_memory', 'late_message'])
    await test(`replace prepared before ${mutation} refuses; current explicit replace succeeds`, async () => {
      const { app, cookie, admin } = await make();
      const initial = await app.request(
        'POST',
        '/api/admin/conversations/import-replay',
        { ...admin, body: replay() }
      );
      assert.equal(initial.statusCode, 200, initial.wire);
      const prepared = (
        await app.request('GET', '/api/account/conversations/c_replay', {
          cookie
        })
      ).body.conversation.copyVersion;
      if (mutation === 'new_turn')
        await app.evaluate("lifecycle.beginTurn('u_A','c_replay')");
      if (mutation === 'edit_memory')
        await app.evaluate(
          "db.ref('conversations/c_replay').update({memory:'MANUAL'})"
        );
      if (mutation === 'late_message')
        await app.evaluate(
          "db.ref('messages/m_late').set({userId:'u_A',conversationId:'c_replay',role:'assistant',content:'LEGITIMATE'})"
        );
      const before = structuredClone(app.db.data);
      const r = await app.request(
        'POST',
        '/api/admin/conversations/import-replay',
        {
          ...admin,
          body: replay({
            writeIntent: 'replace',
            expectedVersion: prepared,
            operationId: 'op_replace'
          })
        }
      );
      assert.equal(r.statusCode, 409, r.wire);
      assert.equal(r.body.code, 'copy_version_conflict');
      assert.deepEqual(app.db.data.conversations, before.conversations);
      assert.deepEqual(app.db.data.messages, before.messages);
      const current = (
        await app.request('GET', '/api/account/conversations/c_replay', {
          cookie
        })
      ).body.conversation.copyVersion;
      assert(current > prepared);
      const valid = await app.request(
        'POST',
        '/api/admin/conversations/import-replay',
        {
          ...admin,
          body: replay({
            writeIntent: 'replace',
            expectedVersion: current,
            operationId: 'op_current'
          })
        }
      );
      assert.equal(valid.statusCode, 200, valid.wire);
      assert.equal(
        Object.values(app.db.data.messages).filter(
          (m) => m.conversationId === 'c_replay'
        ).length,
        1
      );
      assert.equal(app.db.data.conversations.c_B.memory, 'FOREIGN');
    });
  await test('replay transaction conflict reevaluates current destination version', async () => {
    const { app, admin } = await make();
    const first = await app.request(
      'POST',
      '/api/admin/conversations/import-replay',
      { ...admin, body: replay() }
    );
    assert.equal(first.statusCode, 200, first.wire);
    app.db.transactionPlans.push({
      path: '',
      initialNull: true,
      conflict(root) {
        root.conversations.c_replay.memory = 'CONCURRENT';
        root.conversations.c_replay.m2CopyVersion++;
      }
    });
    const r = await app.request(
      'POST',
      '/api/admin/conversations/import-replay',
      {
        ...admin,
        body: replay({
          writeIntent: 'replace',
          expectedVersion: first.body.copyVersion,
          operationId: 'conflict_op'
        })
      }
    );
    assert.equal(r.statusCode, 409, r.wire);
    assert.equal(app.db.data.conversations.c_replay.memory, 'CONCURRENT');
  });
  await test('explicit create cannot replace; replay ack loss retry cannot duplicate', async () => {
    const { app, admin } = await make();
    app.db.transactionPlans.push({ path: '', ackLost: true });
    const lost = await app.request(
      'POST',
      '/api/admin/conversations/import-replay',
      { ...admin, body: replay() }
    );
    assert.equal(lost.statusCode, 503, lost.wire);
    const repeat = await app.request(
      'POST',
      '/api/admin/conversations/import-replay',
      { ...admin, body: replay() }
    );
    assert.equal(repeat.statusCode, 200, repeat.wire);
    assert.equal(repeat.body.replayed, true);
    const second = await app.request(
      'POST',
      '/api/admin/conversations/import-replay',
      { ...admin, body: replay({ operationId: 'other_op' }) }
    );
    assert.equal(second.statusCode, 409, second.wire);
    assert.equal(
      Object.values(app.db.data.messages).filter(
        (m) => m.conversationId === 'c_replay'
      ).length,
      1
    );
  });

  await test('replay preserves real memory movements, control revisions and retirement barriers', async () => {
    const { app, admin } = await make();
    const body = replay();
    body.conversation.memoryState = memoryFixture();
    body.conversation.messages[0].stateSnapshot = {
      memory: 'SYNTHETIC',
      memoryState: memoryFixture(),
      flags: { memoryHold: true }
    };
    const created = await app.request(
      'POST',
      '/api/admin/conversations/import-replay',
      { ...admin, body }
    );
    assert.equal(created.statusCode, 200, created.wire);
    assert.deepEqual(
      app.db.data.conversations.c_replay.memoryState,
      memoryFixture()
    );
    assert.deepEqual(
      app.db.data.messages[created.body.messageIds[0]].stateSnapshot
        .memoryState,
      memoryFixture()
    );
    // Actual runtime controls, not an invented tombstone schema.
    app.db.data.conversations.c_replay.m2TurnVersion = 8;
    app.db.data.conversations.c_replay.intersessionMemoryBaseUpdatedAt =
      '2026-10-01T10:00:00.000Z';
    const beforeVersion = app.db.data.conversations.c_replay.m2CopyVersion;
    const current = await app.request(
      'POST',
      '/api/admin/conversations/import-replay',
      {
        ...admin,
        body: {
          ...body,
          operationId: 'real_memory_replace',
          writeIntent: 'replace',
          expectedVersion: beforeVersion
        }
      }
    );
    assert.equal(current.statusCode, 200, current.wire);
    assert.equal(app.db.data.conversations.c_replay.m2TurnVersion, 9);
    assert.equal(
      app.db.data.conversations.c_replay.intersessionMemoryBaseUpdatedAt,
      '2026-10-01T10:00:00.000Z'
    );
    await app.evaluate("lifecycle.removeConversation('u_A','c_replay')");
    const retry = await app.request(
      'POST',
      '/api/admin/conversations/import-replay',
      { ...admin, body }
    );
    assert.equal(retry.statusCode, 410, retry.wire);
    assert.equal(app.db.data.conversations.c_replay, undefined);
  });
  await test('import-local is atomic, repeatable after lost ack, and replacement loses to intervening message', async () => {
    const { app, cookie } = await make();
    const body = {
      operationId: 'import_op',
      forceOverwrite: true,
      conversations: [
        {
          id: 'c_local',
          isPrivate: true,
          memoryState: memoryFixture(),
          messages: [
            {
              role: 'user',
              content: 'LOCAL_SYNTHETIC',
              stateSnapshot: { memoryState: memoryFixture() }
            }
          ]
        }
      ]
    };
    app.db.transactionPlans.push({
      path: '',
      initialNull: true,
      ackLost: true
    });
    const first = await app.request(
      'POST',
      '/api/account/conversations/import-local',
      { cookie, body }
    );
    assert.equal(first.statusCode, 503, first.wire);
    const children = structuredClone(app.db.data.messages);
    const retry = await app.request(
      'POST',
      '/api/account/conversations/import-local',
      { cookie, body }
    );
    assert.equal(retry.statusCode, 200, retry.wire);
    assert.equal(retry.body.replayed, true);
    assert.deepEqual(app.db.data.messages, children);
    assert.deepEqual(
      app.db.data.conversations.c_local.memoryState,
      memoryFixture()
    );
    const copied =
      app.db.data.messages[retry.body.messageIdsByConversation.c_local[0]];
    assert.deepEqual(copied.stateSnapshot.memoryState, memoryFixture());
    app.db.transactionPlans.push({
      path: '',
      conflict(root) {
        root.conversations.c_local.m2CopyVersion++;
        root.messages.m_concurrent = {
          userId: 'u_A',
          conversationId: 'c_local',
          role: 'assistant',
          content: 'NEW_WORK'
        };
      }
    });
    const replace = await app.request(
      'POST',
      '/api/account/conversations/import-local',
      {
        cookie,
        body: {
          ...body,
          operationId: 'replace_import',
          conversations: [{ ...body.conversations[0], memory: 'NEW_IMPORT' }]
        }
      }
    );
    assert.equal(replace.statusCode, 409, replace.wire);
    assert.equal(app.db.data.messages.m_concurrent.content, 'NEW_WORK');
    const before = structuredClone(app.db.data.conversations);
    const batch = await app.request(
      'POST',
      '/api/account/conversations/import-local',
      {
        cookie,
        body: {
          conversations: [
            { id: 'c_new', messages: [{ role: 'user', content: 'SYNTHETIC' }] },
            { id: 'c_B', messages: [] }
          ]
        }
      }
    );
    assert.equal(batch.statusCode, 403, batch.wire);
    assert.deepEqual(app.db.data.conversations, before);
  });
  await test('voluntary feedback snapshot lost ack yields one pair and survives source-only removal', async () => {
    const { app, cookie } = await make();
    const body = {
      operationId: 'feedback_op',
      localSourceId: 'c_A',
      type: 'thumbUp',
      adminShare: true,
      mailsEnabled: false,
      userContent: 'SYNTHETIC_USER',
      botContent: 'SYNTHETIC_BOT'
    };
    app.db.transactionPlans.push({ path: '', ackLost: true });
    assert.equal(
      (
        await app.request('POST', '/api/branches/feedback-snapshot', {
          cookie,
          body
        })
      ).statusCode,
      503
    );
    const result = await app.request(
      'POST',
      '/api/branches/feedback-snapshot',
      { cookie, body }
    );
    assert.equal(result.statusCode, 200, result.wire);
    assert.equal(result.body.replayed, true);
    await app.evaluate("lifecycle.removeConversation('u_A','c_A')");
    assert(app.db.data.conversations[result.body.snapshotConversationId]);
    assert.equal(
      Object.values(app.db.data.messages).filter(
        (m) => m.conversationId === result.body.snapshotConversationId
      ).length,
      2
    );
  });
  done = true;
  console.log(`M2 copies: ${passed} PASS`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
