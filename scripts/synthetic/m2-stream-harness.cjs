'use strict';
const assert = require('assert/strict');
const { loadApplication } = require('./runtime.cjs');
const { createAnalyzers } = require('../../lib/analyzers');
const { createMemoryHelpers } = require('../../lib/memory');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const latch = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let done = false,
  count = 0;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
async function test(name, run) {
  await run();
  count++;
  console.log('PASS ' + name);
}
function make(writer) {
  const app = loadApplication({
    env: { ENABLE_CHAT_STREAMING: 'true' },
    seed: {
      users: {
        u_A: {
          authVersion: 0,
          email: 'synthetic@example.test',
          passwordHash: 'SYNTHETIC_HASH'
        }
      },
      conversations: {
        c_A: { userId: 'u_A', titleLocked: true, memory: 'BEFORE' }
      }
    },
    overrides: {
      './lib/analyzers': {
        createAnalyzers: (o) => ({
          ...createAnalyzers(o),
          analyzeImminentMajorHarmRisk: async () => ({ harmRiskLevel: 'H0' }),
          analyzeSuicideRisk: async () => ({ suicideLevel: 'N2' })
        })
      },
      './lib/writer': { createWriter: () => ({ generateReply: writer }) },
      './lib/memory': {
        ...require('../../lib/memory'),
        createMemoryHelpers: (o) => ({
          ...createMemoryHelpers(o),
          updateMemory: async () => ({
            memoryText: 'SYNTHETIC_MEMORY',
            source: 'synthetic'
          })
        })
      }
    }
  });
  return {
    app,
    cookie: 'userSessionId=' + app.evaluate("buildUserSessionToken('u_A',0)")
  };
}
async function drain(app) {
  for (let i = 0; i < 200 && app.evaluate('activeChatRequests.size'); i++)
    await tick();
  assert.equal(app.evaluate('activeChatRequests.size'), 0);
}
function events(response) {
  return response.wire
    .split('\n\n')
    .map((frame) => {
      const event = /event: ([^\r\n]+)/.exec(frame)?.[1],
        raw = /data: ([^\r\n]+)/.exec(frame)?.[1];
      return event && raw ? { event, data: JSON.parse(raw) } : null;
    })
    .filter(Boolean);
}
(async () => {
  for (const privateChat of [false, true])
    await test(`enabled streaming ${privateChat ? 'private' : 'public'} legitimate tokens/result and persistence contract`, async () => {
      let emitted = 0;
      const { app, cookie } = make(async ({ onTokenCallback }) => {
        assert.equal(typeof onTokenCallback, 'function');
        await onTokenCallback('SYNTHETIC_TOKEN');
        emitted++;
        return { reply: 'SYNTHETIC_REPLY' };
      });
      const id = privateChat ? 'c_private' : 'c_A';
      const response = await app.request('POST', '/chat/stream', {
        cookie,
        body: {
          conversationId: id,
          isPrivateConversation: privateChat,
          message: 'SYNTHETIC',
          requestId: 'stream_positive'
        }
      });
      await drain(app);
      const rows = events(response);
      assert.equal(emitted, 1);
      assert(
        rows.some(
          (r) => r.event === 'token' && r.data.token === 'SYNTHETIC_TOKEN'
        ),
        response.wire
      );
      assert(
        rows.some(
          (r) => r.event === 'result' && r.data.reply === 'SYNTHETIC_REPLY'
        ),
        response.wire
      );
      if (privateChat) {
        assert.equal(app.db.data.conversations.c_private, undefined);
        assert.equal(app.db.data.messages, undefined);
        assert.equal(app.db.data.privateConversationMemory, undefined);
      } else
        assert(
          Object.values(app.db.data.messages).some(
            (m) => m.content === 'SYNTHETIC_REPLY'
          )
        );
    });
  for (const action of ['delete', 'reset', 'close', 'cancel'])
    await test(`enabled stream token retained during ${action}: no late token/result`, async () => {
      const entered = latch(),
        release = latch();
      const { app, cookie } = make(async ({ onTokenCallback }) => {
        await onTokenCallback('EARLY_TOKEN');
        entered.resolve();
        await release.promise;
        await onTokenCallback('LATE_FORBIDDEN');
        return { reply: 'LATE_FORBIDDEN' };
      });
      const pending = app.request('POST', '/chat/stream', {
        cookie,
        body: {
          conversationId: 'c_A',
          message: 'SYNTHETIC',
          requestId: 'held_stream'
        }
      });
      await entered.promise;
      const url =
        action === 'delete'
          ? '/api/account/conversations/c_A'
          : action === 'cancel'
            ? '/chat/cancel'
            : '/api/account/' + action;
      const change = await app.request(
        action === 'delete' ? 'DELETE' : 'POST',
        url,
        {
          cookie,
          body:
            action === 'cancel'
              ? { requestId: 'held_stream', conversationId: 'c_A' }
              : {}
        }
      );
      assert.equal(change.statusCode, 200, change.wire);
      release.resolve();
      const response = await pending;
      await drain(app);
      assert(!response.wire.includes('LATE_FORBIDDEN'), response.wire);
      assert(
        !events(response).some((r) => r.event === 'result'),
        response.wire
      );
      assert(
        events(response).some(
          (r) =>
            r.event === 'error' &&
            r.data.status === (action === 'cancel' ? 499 : 410)
        ),
        response.wire
      );
    });
  await test('interrupted public stream retained writer, lost acknowledgement and cold repeat preserve one partial child', async () => {
    const entered = latch(),
      release = latch();
    const { app, cookie } = make(async ({ onTokenCallback }) => {
      await onTokenCallback('PARTIAL');
      entered.resolve();
      await release.promise;
      return { reply: 'OLD_COMPLETE' };
    });
    const pending = app.request('POST', '/chat/stream', {
      cookie,
      body: {
        conversationId: 'c_A',
        message: 'SYNTHETIC',
        requestId: 'interrupted_stream'
      }
    });
    await entered.promise;
    const body = {
      conversationId: 'c_A',
      requestId: 'interrupted_stream',
      partialReply: 'PARTIAL'
    };
    app.db.transactionPlans.push({ path: '', ackLost: true });
    const lost = await app.request('POST', '/chat/stream/interrupted', {
      cookie,
      body
    });
    assert.equal(lost.statusCode, 503, lost.wire);
    const cold = loadApplication({
      seed: app.db.data,
      env: { ENABLE_CHAT_STREAMING: 'true' }
    });
    const repeated = await cold.request('POST', '/chat/stream/interrupted', {
      cookie,
      body
    });
    assert.equal(repeated.statusCode, 200, repeated.wire);
    release.resolve();
    await pending;
    await drain(app);
    for (const a of [app, cold]) {
      const assistants = Object.values(a.db.data.messages).filter(
        (m) => m.role === 'assistant'
      );
      assert.equal(assistants.length, 1);
      assert.equal(assistants[0].content, 'PARTIAL');
      assert.equal(assistants[0].streamInterrupted, true);
    }
  });
  await test('completed stream wins over late partial report, fabricated operation refused', async () => {
    const { app, cookie } = make(async ({ onTokenCallback }) => {
      await onTokenCallback('FULL');
      return { reply: 'FULL' };
    });
    await app.request('POST', '/chat/stream', {
      cookie,
      body: {
        conversationId: 'c_A',
        message: 'SYNTHETIC',
        requestId: 'complete_stream'
      }
    });
    await drain(app);
    const body = {
      conversationId: 'c_A',
      requestId: 'complete_stream',
      partialReply: 'PARTIAL'
    };
    const late = await app.request('POST', '/chat/stream/interrupted', {
      cookie,
      body
    });
    assert.equal(late.statusCode, 200, late.wire);
    assert.equal(late.body.streamInterrupted, false);
    const fabricated = await app.request('POST', '/chat/stream/interrupted', {
      cookie,
      body: { ...body, requestId: 'unknown_stream' }
    });
    assert.equal(fabricated.statusCode, 409, fabricated.wire);
    const assistants = Object.values(app.db.data.messages).filter(
      (m) => m.role === 'assistant'
    );
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].content, 'FULL');
  });
  done = true;
  console.log(`M2 stream: ${count} PASS`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
