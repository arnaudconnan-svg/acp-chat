'use strict';
const assert = require('node:assert/strict');
const console = require('node:console');
const process = require('node:process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const { createRequire } = require('node:module');
const { IncomingMessage } = require('node:http');
const { Duplex } = require('node:stream');
const zlib = require('node:zlib');
assert(
  require.cache[path.resolve('scripts/synthetic/guard.cjs')],
  'M0 required'
);
const expressRequire = createRequire(require.resolve('express'));
const body = expressRequire('body-parser');
const { z } = require('zod');
const schemas = require('../../lib/runtime-schemas');
const { inspectConfig } = require('../../lib/config');
assert.equal(expressRequire('body-parser/package.json').version, '2.4.0');
assert.equal(require('zod/package.json').version, '4.6.6');
const history = {
  role: 'user',
  content: 'synthetic',
  signals: { synthetic: true }
};
assert(
  schemas.chatRequestSchema.safeParse({
    message: 'synthetic',
    conversationId: 'synthetic-1',
    recentHistory: [history]
  }).success
);
assert(
  schemas.postureDecisionSchema.safeParse({
    conversationState: 'exploration',
    forbidden: [],
    flagUpdates: { synthetic: false }
  }).success
);
assert.equal(
  schemas.validateShape(schemas.chatRequestSchema, {
    message: 'synthetic',
    conversationId: 'synthetic-1',
    recentHistory: Array(64).fill(null)
  }).length,
  1
);
let visited = 0;
const item = z.preprocess(
  (value) => {
    visited++;
    return value;
  },
  z.object({ required: z.string() })
);
const rejected = z
  .array(item)
  .safeParse(Array(64).fill(null), { abortEarly: true });
assert.equal(rejected.success, false);
assert.equal(rejected.error.issues.length, 1);
assert.equal(visited, 1, 'abort during parsing, not after accumulating errors');
let constrainedVisits = 0;
const constrained = z
  .array(
    z.preprocess((value) => {
      constrainedVisits++;
      return value;
    }, z.string())
  )
  .max(4);
assert(constrained.safeParse(['synthetic']).success);
constrainedVisits = 0;
const oversized = constrained.safeParse(Array(64).fill(0));
assert.equal(oversized.success, false);
assert.equal(oversized.error.issues.length, 1);
assert.equal(
  constrainedVisits,
  0,
  'reject oversized constrained collections before element parsing'
);
const syntheticConfig = {
  NODE_ENV: 'production',
  FIREBASE_DATABASE_URL: 'https://synthetic.example.test',
  FIREBASE_SERVICE_ACCOUNT: 'synthetic-not-a-credential',
  MISTRAL_API_KEY: 'synthetic-not-a-key',
  LOG_PERSIST: 'false'
};
const config = inspectConfig(syntheticConfig);
assert.equal(config.ok, true);
assert.equal(config.config.logPretty, false);
assert.equal(config.config.logPersist, false);
assert.equal(inspectConfig({ ...syntheticConfig, PORT: 'invalid' }).ok, false);
const observations = [];
async function compressed(kind, zip) {
  const descriptor = Object.getOwnPropertyDescriptor(zlib, kind);
  let decoder;
  Object.defineProperty(zlib, kind, {
    ...descriptor,
    value: (...args) => (decoder = descriptor.value(...args))
  });
  try {
    const bytes = zip(Buffer.from('{"synthetic":true}'));
    const socket = new Duplex({
      read() {},
      write(chunk, encoding, done) {
        done();
      }
    });
    const req = new IncomingMessage(socket);
    req.method = 'POST';
    const encoding = {
      createGunzip: 'gzip',
      createInflate: 'deflate',
      createBrotliDecompress: 'br'
    }[kind];
    req.headers = {
      'content-type': 'application/json',
      'content-encoding': encoding,
      'content-length': String(bytes.length)
    };
    let callbacks = 0;
    await new Promise((resolve, reject) => {
      body.json()(req, {}, (error) => {
        callbacks++;
        if (error) return reject(error);
        try {
          assert.deepEqual(req.body, { synthetic: true });
          assert(
            decoder.destroyed,
            'decoder destroyed before application continues'
          );
          assert(
            decoder.listenerCount('error') > 0,
            'finished decoder retains late-error sink'
          );
          // Explicit lifecycle fault injection on the REAL decoder, not a wire
          // exploit: the advisory's post-read error must be handled, not fatal.
          decoder.emit(
            'error',
            new Error('synthetic late decompression error')
          );
          assert.equal(callbacks, 1);
          observations.push({
            encoding,
            bytes: bytes.length,
            destroyed: decoder.destroyed,
            errorListeners: decoder.listenerCount('error'),
            callbacks
          });
          resolve();
        } catch (failure) {
          reject(failure);
        }
      });
      req.push(bytes);
      req.push(null);
      req.complete = true;
    });
  } finally {
    Object.defineProperty(zlib, kind, descriptor);
  }
}
(async () => {
  await compressed('createGunzip', zlib.gzipSync);
  await compressed('createInflate', zlib.deflateSync);
  await compressed('createBrotliDecompress', zlib.brotliCompressSync);
  const files = [
    expressRequire.resolve('body-parser'),
    expressRequire.resolve('body-parser/lib/read'),
    require.resolve('zod')
  ];
  console.log(
    JSON.stringify(
      {
        node: process.version,
        execPath: process.execPath,
        bodyParser: '2.4.0',
        zod: '4.6.6',
        invalidArray: {
          elements: 64,
          visited,
          issues: rejected.error.issues.length
        },
        constrainedArray: {
          elements: 64,
          limit: 4,
          visited: constrainedVisits,
          issues: oversized.error.issues.length
        },
        normalSchemasAndConfig: 'passed',
        observations,
        physical: files.map((file) => ({
          file,
          sha256: crypto
            .createHash('sha256')
            .update(fs.readFileSync(file))
            .digest('hex')
        }))
      },
      null,
      2
    )
  );
  assert.throws(
    () => require('net').connect(443, 'synthetic.example.test'),
    /prohibited side effect/
  );
  console.log(
    'PASS bounded validation and real decompression lifecycle; M0 preserved'
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
