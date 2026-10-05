'use strict';
const assert = require('assert/strict');
const { loadApplication } = require('./runtime.cjs');
const { createAnalyzers } = require('../../lib/analyzers');
const { createMemoryHelpers } = require('../../lib/memory');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function latch() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let count = 0,
  done = false;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
async function test(name, callback) {
  await callback();
  console.log('PASS ' + name);
  count++;
}
function make({ writer, memory, consolidate } = {}) {
  const app = loadApplication({
    seed: {
      users: {
        u_A: {
          authVersion: 0,
          email: 'a@example.test',
          passwordHash: 'SYNTHETIC_HASH',
          intersessionMemorySource: 'BEFORE'
        },
        u_B: { authVersion: 0 }
      },
      conversations: {
        c_A: {
          userId: 'u_A',
          memory: 'Contexte stable:\n- BEFORE',
          intersessionMemoryBaseUpdatedAt: '2026-10-05T00:00:00.000Z',
          titleLocked: true
        },
        c_B: { userId: 'u_B', memory: 'B' }
      }
    },
    overrides: {
      './lib/analyzers': {
        createAnalyzers: (options) => ({
          ...createAnalyzers(options),
          analyzeImminentMajorHarmRisk: async () => ({ harmRiskLevel: 'H0' }),
          analyzeSuicideRisk: async () => ({ suicideLevel: 'N2' })
        })
      },
      './lib/writer': {
        createWriter: () => ({
          generateReply: writer || (async () => ({ reply: 'SYNTHETIC_REPLY' }))
        })
      },
      './lib/memory': {
        ...require('../../lib/memory'),
        createMemoryHelpers: (options) => ({
          ...createMemoryHelpers(options),
          updateMemory:
            memory ||
            (async () => ({
              memoryText: 'Contexte stable:\n- AFTER',
              source: 'synthetic'
            })),
          updateIntersessionMemory: consolidate || (async () => 'CONSOLIDATED')
        })
      }
    }
  });
  const cookie =
    'userSessionId=' + app.evaluate("buildUserSessionToken('u_A',0)");
  return { app, cookie };
}
async function drain(app) {
  for (let n = 0; n < 100 && app.evaluate('activeChatRequests.size'); n++)
    await tick();
  assert.equal(
    app.evaluate('activeChatRequests.size'),
    0,
    'children finish before request lease disappears'
  );
}
(async () => {
  await test('delivered N remains saveable after N+1 while stale current-state effects are discarded', async () => {
    const { app, cookie } = make();
    const entered = latch(),
      release = latch();
    let held = false,
      heldId;
    app.db.hooks.beforeCommit = async ({ value }) => {
      const assistant = Object.entries(value?.messages || {}).find(
        ([, m]) => m.role === 'assistant'
      );
      if (!held && assistant) {
        held = true;
        heldId = assistant[0];
        entered.resolve();
        await release.promise;
      }
    };
    const first = await app.request('POST', '/chat', {
      cookie,
      body: { message: 'TURN_N', conversationId: 'c_A', requestId: 'turn_N' }
    });
    await entered.promise;
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.debugMeta.responseSaveStatus, 'pending');
    assert.equal(first.body.botMessageId, heldId);
    const second = await app.request('POST', '/chat', {
      cookie,
      body: {
        message: 'TURN_NEXT',
        conversationId: 'c_A',
        requestId: 'turn_next'
      }
    });
    assert.equal(second.statusCode, 200);
    const latest = structuredClone(app.db.data.conversations.c_A);
    release.resolve();
    await drain(app);
    assert.equal(app.db.data.messages[heldId].content, 'SYNTHETIC_REPLY');
    assert.equal(app.db.data.messages[heldId].conversationId, 'c_A');
    assert.equal(app.db.data.messages[heldId].userId, 'u_A');
    assert.equal(
      app.db.data.conversations.c_A.m2TurnVersion,
      latest.m2TurnVersion
    );
    assert.deepEqual(app.db.data.conversations.c_A.flags, latest.flags);
  });
  for (const action of ['delete', 'reset', 'close']) {
    for (const child of ['writer', 'memory'])
      await test(`real chat ${child} retained during ${action}`, async () => {
        const entered = latch(),
          release = latch();
        const held = async () => {
          entered.resolve();
          await release.promise;
          return child === 'writer'
            ? { reply: 'LATE_SYNTHETIC_REPLY' }
            : {
                memoryText: 'Contexte stable:\n- LATE_SYNTHETIC_MEMORY',
                source: 'synthetic'
              };
        };
        const { app, cookie } = make({ [child]: held });
        const pending = app.request('POST', '/chat', {
          cookie,
          body: {
            message: 'SYNTHETIC',
            conversationId: 'c_A',
            requestId: 'held_operation'
          }
        });
        await entered.promise;
        if (child === 'memory') {
          const response = await pending;
          assert.equal(response.statusCode, 200);
          assert.equal(response.body.reply, 'SYNTHETIC_REPLY');
          assert.equal(response.body.debugMeta.memoryUpdateStatus, 'pending');
          assert.equal(app.evaluate('activeChatRequests.size'), 1);
        }
        const removed = await app.request(
          action === 'delete' ? 'DELETE' : 'POST',
          action === 'delete'
            ? '/api/account/conversations/c_A'
            : '/api/account/' + action,
          { cookie, body: {} }
        );
        assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
        release.resolve();
        if (child === 'writer') {
          const response = await pending;
          assert.equal(response.statusCode, 410);
          assert(!response.wire.includes('LATE_SYNTHETIC'));
        }
        await drain(app);
        assert.equal(app.db.data.conversations.c_A, undefined);
        assert(
          !Object.values(app.db.data.messages || {}).some(
            (m) => m.conversationId === 'c_A'
          )
        );
        assert.equal(app.db.data.conversations.c_B.memory, 'B');
        if (action !== 'delete') assert.equal(app.db.data.users.u_A, undefined);
        assert.equal(app.db.data.accountArchives, undefined);
      });
  }
  await test('real consolidation loses to manual edit without invalidating session', async () => {
    const entered = latch(),
      release = latch();
    const { app, cookie } = make({
      consolidate: async () => {
        entered.resolve();
        await release.promise;
        return 'OLD_AUTOMATIC';
      }
    });
    const pending = app.request('PUT', '/api/intersession-memory', {
      cookie,
      body: { conversationId: 'c_A' }
    });
    await entered.promise;
    const manual = await app.request(
      'PATCH',
      '/api/intersession-memory/direct',
      { cookie, body: { memory: 'MANUAL' } }
    );
    assert.equal(manual.statusCode, 200);
    release.resolve();
    const response = await pending;
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'memory_superseded');
    assert.equal(app.db.data.users.u_A.intersessionMemorySource, 'MANUAL');
    assert.equal(
      app.db.data.users.u_A.intersessionMemoryHistory[0].memorySource,
      'BEFORE'
    );
    assert.equal(
      (await app.request('GET', '/api/auth/session', { cookie })).body
        .authenticated,
      true
    );
  });
  await test('real held chat memory cannot overwrite a newer manual revision', async () => {
    const entered = latch(),
      release = latch();
    const { app, cookie } = make({
      memory: async () => {
        entered.resolve();
        await release.promise;
        return {
          memoryText: 'Contexte stable:\n- OLD_AUTOMATIC',
          source: 'synthetic'
        };
      }
    });
    const response = await app.request('POST', '/chat', {
      cookie,
      body: { message: 'SYNTHETIC', conversationId: 'c_A' }
    });
    await entered.promise;
    assert.equal(response.statusCode, 200);
    await app.request('PATCH', '/api/intersession-memory/direct', {
      cookie,
      body: { memory: 'MANUAL' }
    });
    release.resolve();
    await drain(app);
    assert(!app.db.data.conversations.c_A.memory.includes('OLD_AUTOMATIC'));
    assert.equal(
      app.db.data.messages[response.body.botMessageId].debugMeta
        .memoryUpdateStatus,
      'superseded'
    );
  });
  done = true;
  console.log(`M2 chat: ${count} PASS`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
