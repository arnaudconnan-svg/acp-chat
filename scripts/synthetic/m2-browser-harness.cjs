'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const espree = require('espree');
const { JSDOM } = require('jsdom');
const { install, PREFIX } = require('../../public/js/identity-storage');
const conversation = require('../../public/js/conversation-data');
const sources = new Map();
function functionsFrom(file) {
  if (sources.has(file)) return sources.get(file);
  const doc = new JSDOM(fs.readFileSync(file, 'utf8'));
  const found = new Map();
  for (const script of doc.window.document.scripts) {
    if (script.src || !script.textContent.trim()) continue;
    const source = script.textContent;
    const ast = espree.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      range: true
    });
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'FunctionDeclaration')
        found.set(node.id.name, source.slice(...node.range));
      for (const [key, value] of Object.entries(node)) {
        if (key === 'range') continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(ast);
  }
  doc.window.close();
  sources.set(file, found);
  return found;
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
const latch = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let count = 0,
  done = false;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
async function test(name, callback) {
  await callback();
  count++;
  console.log('PASS ' + name);
}
async function fixture(fetcher) {
  const dom = new JSDOM('<div id="chat"></div>', {
      url: 'https://synthetic.example.test'
    }),
    w = dom.window;
  w.Headers = Headers;
  w.fetch = async (url, options) =>
    url === '/api/auth/session'
      ? json({ authenticated: true, user: { id: 'u_A' } })
      : fetcher(url, options);
  const api = install(w);
  await api.ready;
  w.FacilitatIdentityStorage = api;
  const cache = new Map();
  const context = vm.createContext({
    window: w,
    document: w.document,
    console,
    fetch: (...args) => w.fetch(...args),
    setTimeout: () => 0,
    ...conversation,
    createEmptyConversationData: () =>
      conversation.buildSafeConversationData({}),
    currentConversation: 'c_A',
    userSessionState: { authenticated: true },
    getConversationId: () => context.currentConversation,
    getConversationStorageKey: (id) => 'conversation:' + id,
    conversationDataMemoryCache: cache,
    rememberConversationDataMemoryCache: (id, data) => cache.set(id, data),
    isConversationPrivateById: (id, data) => data.isPrivate === true,
    markConversationPrivate() {},
    upsertConversationIndexItem() {},
    safeSetLocalStorage(key, value) {
      api.local.setItem(key, value);
      return true;
    },
    loadPrivateConversationIds: () => [],
    loadHiddenTrunkConversationIds: () => [],
    loadConversationsIndex: () => [],
    saveHiddenTrunkConversationIds() {},
    saveConversationsIndex() {},
    PRIVATE_CONVERSATION_IDS_KEY: 'private-ids',
    navigateAway() {},
    setServiceAvailabilityBlocked() {},
    readServiceUnavailableMessage() {}
  });
  function load(file, names) {
    const found = functionsFrom(file);
    for (const name of names) {
      assert(found.has(name), name);
      vm.runInContext(found.get(name), context);
    }
  }
  load('public/index.html', [
    'loadConversationData',
    'saveConversationData',
    'deleteConversationData',
    'parseAppJsonResponseSafely',
    'persistIntersessionMemoryIfApplicable',
    'closeSessionBackend'
  ]);
  for (const id of ['c_A', 'c_B'])
    context.saveConversationData(id, {
      memory: id,
      messages: [{ role: 'user', content: 'SYNTHETIC' }]
    });
  return { dom, w, api, context, load };
}
(async () => {
  for (const transition of ['conversation', 'identity', 'delete', 'manual'])
    await test(`real close frontend destination after ${transition}`, async () => {
      const entered = latch(),
        release = latch(),
        calls = [];
      const f = await fixture(async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url === '/session/close') {
          entered.resolve();
          await release.promise;
          return json({ memory: 'CLOSED_A' });
        }
        return json({ success: true });
      });
      const pending = f.context.closeSessionBackend();
      await entered.promise;
      if (transition === 'conversation') f.context.currentConversation = 'c_B';
      if (transition === 'identity') f.api.activate('u_B');
      if (transition === 'delete') f.context.deleteConversationData('c_A');
      if (transition === 'manual')
        f.context.saveConversationData('c_A', {
          ...f.context.loadConversationData('c_A'),
          memory: 'MANUAL'
        });
      release.resolve();
      await pending;
      const saves = calls.filter(
        (call) => call.url === '/api/intersession-memory'
      );
      if (['identity', 'delete'].includes(transition))
        assert.equal(saves.length, 0);
      else {
        assert.equal(saves.length, 1);
        assert.equal(saves[0].body.conversationId, 'c_A');
        assert.equal(
          f.context.loadConversationData('c_A').memory,
          transition === 'manual' ? 'MANUAL' : 'CLOSED_A'
        );
        assert.equal(f.context.loadConversationData('c_B').memory, 'c_B');
      }
      if (transition === 'delete') {
        assert.equal(
          f.context.saveConversationData('c_A', { memory: 'LATE' }),
          false
        );
        assert.equal(f.api.local.getItem('conversation:c_A'), null);
      }
      f.dom.window.close();
    });
  await test('real reset handler clears the old identity despite wrapper activation of new identity', async () => {
    const f = await fixture(async () =>
      json({ success: true, user: { id: 'u_new' } })
    );
    f.api.session.setItem('SYNTHETIC', 'OLD_SESSION');
    f.w.localStorage.setItem(PREFIX + 'u_new:preserved', 'NEW');
    f.load('public/account.html', ['handleSensitiveAccountReset']);
    await f.context.handleSensitiveAccountReset({});
    assert.equal(f.api.identity, 'u_new');
    assert.equal(
      f.w.localStorage.getItem(PREFIX + 'u_A:conversation:c_A'),
      null
    );
    assert.equal(f.w.sessionStorage.getItem(PREFIX + 'u_A:SYNTHETIC'), null);
    assert.equal(f.api.local.getItem('preserved'), 'NEW');
    f.dom.window.close();
  });
  await test('real closure handler removes this device content and invalidates identity', async () => {
    const f = await fixture(async () => json({ success: true }));
    f.load('public/account.html', ['handleSensitiveAccountClosure']);
    await f.context.handleSensitiveAccountClosure({});
    assert.equal(f.api.identity, null);
    assert.equal(
      f.w.localStorage.getItem(PREFIX + 'u_A:conversation:c_A'),
      null
    );
    f.dom.window.close();
  });

  await test('real copy frontend resumes exact request after lost acknowledgement and hydrates canonical destination', async () => {
    const calls = [],
      notices = [];
    let fail = true;
    const f = await fixture(async (url, options) => {
      if (url.includes('/api/branches/')) {
        calls.push(JSON.parse(options.body));
        if (fail) {
          fail = false;
          throw new Error('synthetic_ack_lost');
        }
        return json({
          branch: { branchConversationId: 'c_copy' },
          replayed: true
        });
      }
      return json({
        conversation: {
          id: 'c_copy',
          memory: 'CURRENT_REMOTE',
          flags: {},
          memoryState: {
            sessionStableContext: ['SYNTHETIC'],
            onGoingMovements: [],
            ancientMovements: []
          }
        },
        messages: [{ id: 'canonical_id', role: 'user', content: 'CANONICAL' }]
      });
    });
    Object.assign(f.context, {
      deriveBranchConversationState: () => ({ memory: 'SEED', flags: {} }),
      CONVERSATION_ID_KEY: 'active',
      isBranchConversationId: () => false,
      markTrunkConversationHidden() {},
      setSessionStatus() {},
      closeEditMode() {},
      showScreen() {},
      renderHistory() {},
      scrollChatToBottom() {},
      showTemporaryNotice: (n) => notices.push(n)
    });
    f.load('public/index.html', ['copyFetch', 'openBranchFromMessage']);
    const history = [{ id: 'anchor', role: 'user', content: 'SYNTHETIC' }];
    await f.context.openBranchFromMessage('c_A', 'anchor', history);
    assert.equal(f.api.local.getItem('active'), null);
    assert(notices.at(-1).includes('non confirm'));
    await f.context.openBranchFromMessage('c_A', 'anchor', history);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(f.api.local.getItem('active'), 'c_copy');
    assert.equal(
      f.context.loadConversationData('c_copy').memory,
      'CURRENT_REMOTE'
    );
    assert.equal(
      f.context.loadConversationData('c_copy').messages[0].id,
      'canonical_id'
    );
    assert(
      !Array.from({ length: f.api.local.length }, (_, i) =>
        f.api.local.key(i)
      ).some((k) => k.startsWith('copy-pending:'))
    );
    f.dom.window.close();
  });
  for (const change of ['identity', 'retirement'])
    await test(`real copy body delayed through ${change} cannot activate/store old destination`, async () => {
      const body = latch(),
        entered = latch();
      const f = await fixture(async (url) => {
        if (url.includes('/api/branches/')) {
          entered.resolve();
          return {
            ok: true,
            status: 200,
            json: async () => {
              await body.promise;
              return { branch: { branchConversationId: 'c_copy' } };
            }
          };
        }
        throw new Error('must_not_hydrate_after_boundary');
      });
      Object.assign(f.context, {
        deriveBranchConversationState: () => ({ memory: 'SEED' }),
        showTemporaryNotice() {}
      });
      f.load('public/index.html', ['copyFetch', 'openBranchFromMessage']);
      const pending = f.context.openBranchFromMessage('c_A', 'anchor', []);
      await entered.promise;
      if (change === 'identity') f.api.activate('u_B');
      else f.context.deleteConversationData('c_A');
      body.resolve();
      await pending;
      assert.equal(f.api.local.getItem('conversation:c_copy'), null);
      assert.equal(f.api.local.getItem('active'), null);
      f.dom.window.close();
    });
  await test('real make-public retries frozen import then maps acknowledged IDs; failed import stays private', async () => {
    let calls = [],
      fail = true;
    const f = await fixture(async (url, options) => {
      calls.push(JSON.parse(options.body));
      if (fail) {
        fail = false;
        return json({ code: 'copy_commit_uncertain' }, 503);
      }
      return json({
        success: true,
        messageIdsByConversation: { c_A: ['canonical_import_id'] }
      });
    });
    f.context.updateMakePublicBtnVisibility = () => {};
    f.context.saveConversationData('c_A', {
      memory: 'SYNTHETIC',
      isPrivate: true,
      messages: [{ role: 'user', content: 'PRIVATE_SYNTHETIC' }]
    });
    f.load('public/index.html', ['copyFetch', 'executeMakePublic']);
    await assert.rejects(f.context.executeMakePublic());
    assert.equal(f.context.loadConversationData('c_A').isPrivate, true);
    await f.context.executeMakePublic();
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(f.context.loadConversationData('c_A').isPrivate, false);
    assert.equal(
      f.context.loadConversationData('c_A').messages[0].id,
      'canonical_import_id'
    );
    f.dom.window.close();
  });
  done = true;
  console.log(`M2 browser: ${count} PASS`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
