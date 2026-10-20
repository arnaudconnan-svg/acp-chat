'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');
assert(
  require.cache[path.join(__dirname, 'guard.cjs')],
  'M0 must be preloaded'
);
const admin = require('firebase-admin');
const { createDataLifecycle } = require('../../lib/data-lifecycle');
function packageAt(entry) {
  let dir = path.dirname(entry);
  while (!fs.existsSync(path.join(dir, 'package.json')))
    dir = path.dirname(dir);
  const file = path.join(dir, 'package.json');
  return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const adminEntry = require.resolve('firebase-admin');
const adminRequire = createRequire(adminEntry);
const compatEntry = adminRequire.resolve(
  '@firebase/database-compat/standalone'
);
const compatRequire = createRequire(compatEntry);
const databaseEntry = compatRequire.resolve('@firebase/database');
const databaseRequire = createRequire(databaseEntry);
const fayeEntry = databaseRequire.resolve('faye-websocket');
const fayeRequire = createRequire(fayeEntry);
const driverEntry = fayeRequire.resolve('websocket-driver');
const driverPackage = packageAt(driverEntry);
const compatPackage = packageAt(compatEntry);
const fixedDriver = driverPackage.version !== '0.7.4';
const fixedBundle = compatPackage.version !== '2.1.4';
let complete = false;
process.on('beforeExit', () => {
  if (!complete) process.exitCode = 1;
});
function server(options = {}) {
  const Driver = fayeRequire('websocket-driver');
  const d = Driver.http(
    {
      method: 'GET',
      url: '/',
      headers: {
        host: 'synthetic.example.test',
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='
      }
    },
    { maxLength: 64, requireMasking: true, ...options }
  );
  const messages = [],
    errors = [];
  d.on('error', (e) => errors.push(e.message));
  d.on('message', (e) => messages.push(e.data));
  d.io.on('data', () => {});
  d.start();
  return { d, messages, errors };
}
function frame(opcode, payload, final = true) {
  const b = Buffer.from(payload),
    mask = Buffer.from([1, 2, 3, 4]);
  assert(b.length < 126);
  return Buffer.concat([
    Buffer.from([(final ? 128 : 0) | opcode, 128 | b.length]),
    mask,
    Buffer.from(b.map((n, i) => n ^ mask[i % 4]))
  ]);
}
async function main() {
  if (process.argv.includes('--candidate')) {
    assert.equal(
      driverPackage.version,
      '0.7.5',
      'candidate must be physically loaded, not just locked'
    );
    assert.equal(compatPackage.version, '2.1.7');
  }
  let tokenCalls = 0;
  const app = admin.initializeApp(
    {
      databaseURL: 'https://synthetic.example.test',
      credential: {
        getAccessToken() {
          tokenCalls++;
          return Promise.reject(new Error('synthetic_credentials_refused'));
        }
      }
    },
    'synthetic-wscrit'
  );
  try {
    const db = app.database();
    db.goOffline();
    const lifecycle = createDataLifecycle(db);
    const users = lifecycle.db.ref('users');
    assert.equal(users.child('u_synthetic').key, 'u_synthetic');
    const query = users
      .orderByChild('email')
      .equalTo('synthetic@example.test')
      .limitToFirst(1);
    assert.match(query.toString(), /\/users$/);
    const invalid = () => db.ref('invalid.#');
    assert.throws(invalid);
    assert(
      require.cache[compatEntry],
      'Admin must really load standalone RTDB'
    );
    const bundle = fs.readFileSync(compatEntry, 'utf8');
    const match = bundle.match(
      /processIncomingMessage\(message, function\(error, message\)[\s\S]*?var payload = message.data;([\s\S]*?)if \(payload === null\)/
    );
    assert(match, 'bundled driver emission path found');
    assert.equal(
      match[1].includes('payload.length > this._maxLength'),
      fixedBundle
    );
    const externalLoadedByAdmin = !!require.cache[driverEntry];
    assert.equal(
      externalLoadedByAdmin,
      false,
      'standalone embeds driver; do not claim external file is used by Admin'
    );
    // Load Faye from the real declared database dependency path. The modular
    // database entry additionally requires @firebase/app, absent from Admin's
    // installation and not used by its standalone entry. Do not mock/install it.
    const faye = databaseRequire('faye-websocket');
    assert.equal(typeof faye.Client, 'function');
    assert(require.cache[fayeEntry]);
    assert(require.cache[driverEntry]);
    const s = server();
    s.d.parse(frame(1, 'synthetic text'));
    s.d.parse(frame(2, Buffer.from([1, 2, 3])));
    s.d.parse(frame(1, 'frag', false));
    s.d.parse(frame(0, 'ment', true));
    assert.deepEqual(s.messages, [
      'synthetic text',
      Buffer.from([1, 2, 3]),
      'fragment'
    ]);
    const bad = server();
    bad.d.parse(Buffer.from([0x81, 0x01, 0x61]));
    assert.equal(bad.errors.length, 1);
    const expanded = server();
    // Synthetic extension callback exercises the real driver's post-extension
    // validation, with a bounded 65-byte expansion rather than a compression bomb.
    expanded.d._extensions.processIncomingMessage = (
      message,
      callback,
      context
    ) =>
      callback.call(context, null, {
        ...message,
        data: Buffer.alloc(65, 0x61)
      });
    expanded.d.parse(frame(1, 'x'));
    assert.equal(expanded.errors.length, fixedDriver ? 1 : 0);
    assert.equal(expanded.messages.length, fixedDriver ? 0 : 1);
    const Draft75 = createRequire(driverEntry)('./driver/draft75');
    const legacy = new Draft75(
      {
        method: 'GET',
        headers: {
          origin: 'http://synthetic.example.test',
          connection: 'Upgrade',
          upgrade: 'websocket'
        }
      },
      'ws://synthetic.example.test/',
      { maxLength: 64 }
    );
    let closed = false;
    legacy.on('close', () => {
      closed = true;
    });
    assert.equal(legacy.start(), true);
    assert.equal(
      closed,
      false,
      'legacy handshake must succeed before length test'
    );
    legacy.parse(Buffer.from([0x80, 0x41]));
    assert.equal(closed, fixedDriver);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tokenCalls, 0, 'no credential acquisition');
    assert.throws(
      () => require('net').connect(443, 'synthetic.example.test'),
      /prohibited side effect/
    );
    assert.throws(
      () => require('https').get('https://synthetic.example.test'),
      /prohibited side effect/
    );
    assert.throws(
      () => require('tls').connect(443, 'synthetic.example.test'),
      /prohibited side effect/
    );
    console.log(
      JSON.stringify(
        {
          chain: [
            adminEntry,
            compatEntry,
            databaseEntry,
            fayeEntry,
            driverEntry
          ].map((entry) => ({
            entry,
            version: packageAt(entry).version,
            sha256: crypto
              .createHash('sha256')
              .update(fs.readFileSync(entry))
              .digest('hex')
          })),
          adminUsesBundledDriver: true,
          externalLoadedByAdmin,
          tokenCalls,
          postExtensionOversizeRejected: expanded.errors.length === 1,
          legacyOversizeClosed: closed,
          bundledPostExtensionBound: fixedBundle
        },
        null,
        2
      )
    );
    console.log(
      'PASS real Admin/RTDB offline application refs/query/error API; real declared faye/driver; text/binary/fragment/error/length checks; M0 intact'
    );
  } finally {
    await app.delete();
  }
  complete = true;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
