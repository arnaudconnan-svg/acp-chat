'use strict';
const assert = require('assert/strict');
const path = require('path');
assert(require.cache[path.join(__dirname, 'guard.cjs')], 'M0 guard required');
const { loadApplication } = require('./runtime.cjs');
const qs = require('qs');
const versions = Object.fromEntries(
  ['express', 'proxy-addr', 'body-parser', 'qs'].map((name) => [
    name,
    require(name + '/package.json').version
  ])
);
let done = false;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
const observations = [];
function fixture(env = {}) {
  const app = loadApplication({ env });
  const describe = app.evaluate(
    '(req) => ({body:req.body ?? null,query:req.query,ip:req.ip,ips:req.ips,manualIp:getClientIpAddress(req),resetIp:getPasswordResetClientIp(req)})'
  );
  for (const verb of ['post', 'get'])
    app.app[verb]('/__synthetic_http', (req, res) => res.json(describe(req)));
  return app;
}
async function main() {
  const app = fixture();
  assert.equal(app.app.get('trust proxy'), false);
  assert.equal(app.app.get('query parser'), 'simple');
  const cases = [
    ['valid', '{"value":"synthetic"}', {}, 200, { value: 'synthetic' }],
    ['malformed', '{"value":', {}, 400, undefined],
    ['empty', '', {}, 200, {}],
    ['primitive', '42', {}, 400, undefined],
    [
      'wrong-content-type',
      '{"value":"synthetic"}',
      { 'content-type': 'text/plain' },
      200,
      null
    ],
    [
      'json-charset',
      '{"value":"é"}',
      { 'content-type': 'application/json; charset=utf-8' },
      200,
      { value: 'é' }
    ],
    [
      'oversize',
      JSON.stringify({ value: 'x'.repeat(103000) }),
      {},
      413,
      undefined
    ]
  ];
  for (const [name, rawBody, headers, status, expected] of cases) {
    const result = await app.request('POST', '/__synthetic_http', {
      rawBody,
      headers
    });
    assert.equal(result.statusCode, status, name);
    if (expected !== undefined)
      assert.deepEqual(result.body.body, expected, name);
    if (status === 400)
      assert.deepEqual(result.body, { error: 'Invalid JSON payload' }, name);
    observations.push({ name, status: result.statusCode, body: result.body });
  }
  const query = await app.request(
    'GET',
    '/__synthetic_http?a=one&a=two&filter[name]=synthetic&__proto__[polluted]=yes'
  );
  assert.deepEqual(query.body.query, {
    a: ['one', 'two'],
    'filter[name]': 'synthetic',
    '__proto__[polluted]': 'yes'
  });
  assert.equal({}.polluted, undefined);
  observations.push({ name: 'existing-simple-query', query: query.body.query });
  // Extended parsing is exercised only in this synthetic fixture, never enabled
  // in server.js. It reaches the qs copy consumed by genuine Express.
  app.app.set('query parser', 'extended');
  const nested = await app.request(
    'GET',
    '/__synthetic_http?filter[name]=synthetic&a=one&a=two&__proto__[polluted]=yes'
  );
  assert.deepEqual(nested.body.query, {
    filter: { name: 'synthetic' },
    a: ['one', 'two']
  });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(qs.parse('a[b]=one'), { a: { b: 'one' } });
  observations.push({
    name: 'fixture-only-extended-query',
    query: nested.body.query
  });
  const header = { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' };
  const ip = await app.request('GET', '/__synthetic_http', { headers: header });
  assert.equal(ip.body.ip, '127.0.0.1');
  assert.deepEqual(ip.body.ips, []);
  assert.equal(ip.body.manualIp, '198.51.100.7');
  assert.equal(ip.body.resetIp, '127.0.0.1');
  observations.push({
    name: 'default-trust-proxy-and-manual-forwarding',
    ...ip.body
  });
  const mapped = await app.request('GET', '/__synthetic_http', {
    headers: header,
    socketAddress: '::ffff:127.0.0.1'
  });
  assert.equal(mapped.body.ip, '::ffff:127.0.0.1');
  assert.equal(mapped.body.resetIp, '::ffff:127.0.0.1');
  observations.push({ name: 'mapped-socket-default', ...mapped.body });
  const hops = fixture({ RESET_TRUST_PROXY_HOPS: '1' });
  const hop = await hops.request('GET', '/__synthetic_http', {
    headers: header
  });
  assert.equal(hop.body.resetIp, '203.0.113.9');
  assert.equal(hop.body.ip, '127.0.0.1');
  observations.push({ name: 'existing-reset-hop-option', ...hop.body });
  const resetMalformed = await app.request(
    'POST',
    '/api/auth/forgot-password',
    { rawBody: '{' }
  );
  assert.equal(resetMalformed.statusCode, 400);
  assert.deepEqual(resetMalformed.body, { error: 'Invalid JSON payload' });
  const relayMalformed = await app.request(
    'POST',
    '/api/human-support/request',
    { rawBody: '{' }
  );
  assert.equal(relayMalformed.statusCode, 400);
  assert.deepEqual(relayMalformed.body, { error: 'Invalid JSON payload' });
  assert.deepEqual(
    app.db.operations,
    [],
    'HTTP characterization must not touch even synthetic persistence'
  );
  assert.throws(
    () => require('net').connect(443, 'synthetic.example.test'),
    /prohibited side effect/
  );
  assert.throws(() => require('firebase-admin'), /prohibited side effect/);
  console.log(JSON.stringify({ versions, observations }, null, 2));
  console.log(
    'PASS real HTTP JSON/query/IP/error characterization; relay/reset malformed; M0 preserved'
  );
  done = true;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
