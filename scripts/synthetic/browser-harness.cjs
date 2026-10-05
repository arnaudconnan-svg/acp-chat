'use strict';
const assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const {
  create,
  install,
  PREFIX,
  MARKER
} = require('../../public/js/identity-storage');
const { resolve } = require('../../public/js/local-destination');
let done = false;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
(async () => {
  const dom = new JSDOM('', { url: 'https://synthetic.example.test' }),
    w = dom.window;
  const raw = w.localStorage;
  raw.setItem(
    'facilitatio_conversation_data_legacy',
    JSON.stringify({ content: 'LEGACY_UNOWNED' })
  );
  const s = create(raw, w.sessionStorage);
  assert.equal(s.local.getItem('facilitatio_conversation_data_legacy'), null);
  s.activate('u_A');
  s.local.setItem(
    'conversation',
    JSON.stringify({
      memoryState: { onGoingMovements: [{ id: 'x', since: '2026-10-05' }] },
      owner: 'u_A'
    })
  );
  const stamp = s.capture();
  s.activate('u_B');
  assert.equal(s.local.getItem('conversation'), null);
  assert.equal(s.current(stamp), false);
  s.local.setItem('conversation', 'B');
  s.activate(null);
  assert.equal(s.local.getItem('conversation'), null);
  s.activate('u_A');
  assert.equal(JSON.parse(s.local.getItem('conversation')).owner, 'u_A');
  assert.equal(s.storageEvent({ key: MARKER, newValue: 'u_B' }), true);
  assert.equal(s.identity, null);
  assert(raw.getItem(PREFIX + 'u_A:conversation'));
  assert(raw.getItem('facilitatio_conversation_data_legacy'));
  const dom2 = new JSDOM('', { url: 'https://synthetic.example.test' }),
    v = dom2.window;
  v.Headers = Headers;
  v.Response = Response;
  let release, requestHeaders;
  v.fetch = async (input, options) => {
    if (input === '/api/auth/session')
      return new Response(
        JSON.stringify({ authenticated: true, user: { id: 'u_A' } }),
        { headers: { 'content-type': 'application/json' } }
      );
    requestHeaders = options.headers;
    return new Promise((resolve) => {
      release = () =>
        resolve(
          new Response('{"memory":"LATE_A"}', {
            headers: { 'content-type': 'application/json' }
          })
        );
    });
  };
  const bound = install(v);
  await bound.ready;
  assert.equal(bound.identity, 'u_A');
  const pending = v.fetch('/api/account/conversations');
  assert.equal(requestHeaders.get('x-client-identity'), 'u_A');
  bound.activate('u_B');
  release();
  await assert.rejects(pending, /Identity changed/);
  const offline = new JSDOM('', { url: 'https://synthetic.example.test' })
    .window;
  offline.Headers = Headers;
  offline.fetch = async () => {
    throw new Error('offline');
  };
  const offlineApi = install(offline);
  await offlineApi.ready;
  assert.equal(offlineApi.identity, null);
  await assert.rejects(
    offline.fetch('/api/account/conversations'),
    /unavailable/
  );
  for (const valid of [
    '/pros.html',
    '/?screen=conversationsScreen',
    '/?launch=new-private&launchAuthDone=1',
    '/account.html'
  ])
    assert.equal(resolve(valid), valid);
  for (const bad of [
    'https://outside.example.test',
    '//outside.example.test',
    '/\\outside',
    '/%2f%2foutside',
    '/%252foutside',
    'javascript:alert(1)',
    ' /pros.html',
    '/pros.html\n',
    '/../pros.html',
    '/pros.html?next=https://outside',
    '/admin.html#x'
  ])
    assert.equal(resolve(bad, '/safe'), '/safe', bad);
  dom.window.close();
  dom2.window.close();
  offline.close();
  done = true;
  console.log(
    '[PASS] G03 identity namespaces/legacy/logout/tabs/offline/late responses and G12 local destination positives/refusals'
  );
})().catch((e) => {
  done = true;
  console.error(e);
  process.exitCode = 1;
});
