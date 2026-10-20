'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
assert(
  require.cache[path.join(__dirname, 'guard.cjs')],
  'M0 must be preloaded'
);
const admin = require('firebase-admin');
assert.equal(typeof admin.initializeApp, 'function'); // load only; no app/credential discovery
const adminEntry = require.resolve('firebase-admin');
const fromAdmin = createRequire(adminEntry);
const Busboy = fromAdmin('@fastify/busboy');
const busboyEntry = fromAdmin.resolve('@fastify/busboy');
function packageAt(entry) {
  let dir = path.dirname(entry);
  while (!fs.existsSync(path.join(dir, 'package.json')))
    dir = path.dirname(dir);
  const file = path.join(dir, 'package.json');
  return { dir, file, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const adminPackage = packageAt(adminEntry);
const busboyPackage = packageAt(busboyEntry);
assert.equal(adminPackage.version, '13.10.0');
assert.equal(adminPackage.dependencies['@fastify/busboy'], '^3.0.0');
assert.equal(busboyPackage.version, '3.2.3', 'physical candidate required');
const sourceFile = path.join(adminPackage.dir, 'lib/utils/api-request.js');
const source = fs.readFileSync(sourceFile, 'utf8');
assert(source.includes("const busboy = require('@fastify/busboy')"));
assert(source.includes('new busboy.Dicer({ boundary })'));
assert(
  source.includes('handleMultipartResponse(response, respStream, boundary)')
);
function digest(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}
let complete = false;
process.on('beforeExit', () => {
  if (!complete) process.exitCode = 1;
});
function parse(parser, body, dicer) {
  return new Promise((resolve, reject) => {
    const parts = [],
      fields = [],
      files = [],
      headers = [],
      pending = [];
    const timer = setTimeout(
      () => reject(new Error('bounded parser timeout')),
      1000
    );
    parser.on('error', reject);
    parser.on('field', (name, value) => fields.push({ name, value }));
    parser.on('file', (name, stream, filename) => {
      files.push({ name, filename });
      stream.resume();
    });
    if (dicer)
      parser.on('part', (part) => {
        const chunks = [];
        pending.push(new Promise((done) => part.on('end', done)));
        part.on('error', reject);
        part.on('header', (h) => headers.push(h));
        part.on('data', (chunk) => chunks.push(chunk));
        part.on('end', () => parts.push(Buffer.concat(chunks).toString()));
      });
    parser.on('finish', async () => {
      await Promise.all(pending);
      clearTimeout(timer);
      resolve({ parts, fields, files, headers });
    });
    // Exercise chunked parsing including the closing-delimiter trailer.
    const bytes = Buffer.from(body);
    for (let i = 0; i < bytes.length; i += 7)
      parser.write(bytes.subarray(i, i + 7));
    parser.end();
  });
}
function form(header) {
  return `--synthetic\r\n${header}\r\n\r\nhello\r\n--synthetic--\r\n`;
}
function publicParser() {
  return new Busboy({
    headers: { 'content-type': 'multipart/form-data; boundary=synthetic' },
    limits: { parts: 4, fileSize: 128, fieldSize: 128 }
  });
}
(async () => {
  const regular = form('Content-Disposition: form-data; name="field"');
  assert.deepEqual((await parse(publicParser(), regular)).fields, [
    { name: 'field', value: 'hello' }
  ]);
  assert.deepEqual(
    (await parse(new Busboy.Dicer({ boundary: 'synthetic' }), regular, true))
      .parts,
    ['hello']
  );
  for (const header of ['__proto__', 'constructor', 'toString']) {
    const result = await parse(
      new Busboy.Dicer({ boundary: 'synthetic' }),
      form(
        `${header}: harmless\r\nContent-Disposition: form-data; name="field"`
      ),
      true
    );
    assert.deepEqual(result.parts, ['hello']);
    assert.equal(Object.getPrototypeOf(result.headers[0]), null);
    assert.deepEqual(result.headers[0][header.toLowerCase()], ['harmless']);
  }
  // 253-byte boundary exceeds streamsearch's 256-byte needle limit after CRLF--.
  assert.throws(
    () => new Busboy.Dicer({ boundary: 'x'.repeat(253) }),
    /length bigger than 256/
  );
  assert.throws(
    () =>
      new Busboy({
        headers: {
          'content-type': `multipart/form-data; boundary=${'x'.repeat(253)}`
        }
      }),
    /length bigger than 256/
  );
  for (const disposition of [
    'name="bad\rname"',
    'name="field"; filename="bad\nfile"'
  ]) {
    const result = await parse(
      publicParser(),
      form(`Content-Disposition: form-data; ${disposition}`)
    );
    assert.deepEqual(result.fields, []);
    assert.deepEqual(result.files, []);
  }
  assert.throws(() => require('https').get('https://synthetic.example.test'));
  assert.throws(() => require('net').connect(443, 'synthetic.example.test'));
  assert.throws(() => require('firebase-admin/auth'));
  assert.throws(() => fs.readFileSync(path.resolve('.env')));
  console.log(
    JSON.stringify(
      {
        admin: { version: adminPackage.version, entry: adminEntry },
        busboy: {
          version: busboyPackage.version,
          entry: busboyEntry,
          sha256: digest(busboyEntry)
        },
        adminSource: {
          file: sourceFile,
          sha256: digest(sourceFile),
          function: 'AsyncRequestCall.handleMultipartResponse',
          limitation:
            'private class not exported: exact source checked, real Dicer exercised; no Firebase E2E'
        },
        cases: [
          'normal field',
          'Admin Dicer normal multipart',
          'three prototype-named headers',
          'oversized boundary rejected',
          'bare CR/LF names and filenames suppressed',
          'M0 isolation'
        ]
      },
      null,
      2
    )
  );
  complete = true;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
