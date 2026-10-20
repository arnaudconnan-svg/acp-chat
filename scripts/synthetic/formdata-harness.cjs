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
function packageAt(entry) {
  let dir = path.dirname(entry);
  while (true) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (metadata.name && metadata.version) return { dir, file, ...metadata };
    }
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, 'named package metadata required');
    dir = parent;
  }
}

function digest(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}
// Resolve installed parents without initializing Admin/Storage or discovering credentials.
const adminEntry = require.resolve('firebase-admin');
const adminRequire = createRequire(adminEntry);
const storageEntry = adminRequire.resolve('@google-cloud/storage');
const storageRequire = createRequire(storageEntry);
const retryEntry = storageRequire.resolve('retry-request');
const retryRequire = createRequire(retryEntry);
const typesFile = retryRequire.resolve('@types/request/package.json');
const typesRequire = createRequire(typesFile);
const formEntry = typesRequire.resolve('form-data');
const FormData = typesRequire('form-data');
const chain = [adminEntry, storageEntry, retryEntry, typesFile, formEntry].map(
  packageAt
);
assert.deepEqual(
  chain.map((p) => p.version),
  [
    '13.10.0',
    '7.19.0',
    '7.0.2',
    '2.48.13',
    process.argv.includes('--baseline') ? '2.5.5' : '2.5.6'
  ]
);
assert.equal(chain[0].optionalDependencies['@google-cloud/storage'], '^7.19.0');
assert.equal(chain[1].dependencies['retry-request'], '^7.0.0');
assert.equal(chain[2].dependencies['@types/request'], '^2.48.8');
assert.equal(chain[3].dependencies['form-data'], '^2.5.5');
assert.equal(chain[3].types, 'index.d.ts');
assert(
  fs
    .readFileSync(path.join(chain[3].dir, 'index.d.ts'), 'utf8')
    .includes('import FormData = require("form-data")')
);
assert.equal(typeof storageRequire('retry-request'), 'function'); // load only, no transport invoked
const boundary = 'synthetic-formdata';
function form() {
  const value = new FormData();
  value.setBoundary(boundary);
  return value;
}
const normal = form();
normal.append('field', 'hello');
normal.append('file', Buffer.from('world'), {
  filename: 'normal.txt',
  contentType: 'text/plain'
});
const normalBody = normal.getBuffer();
assert.equal(normal.getLengthSync(), normalBody.length);
assert.equal(
  normal.getHeaders()['content-type'],
  'multipart/form-data; boundary=' + boundary
);
assert(normalBody.includes(Buffer.from('name="field"\r\n\r\nhello\r\n')));
assert(
  normalBody.includes(
    Buffer.from(
      'name="file"; filename="normal.txt"\r\nContent-Type: text/plain\r\n\r\nworld\r\n'
    )
  )
);
assert(normalBody.toString().endsWith('--' + boundary + '--\r\n'));
const fixtures = [
  {
    kind: 'field',
    input: 'field"\r\nX-Synthetic: injected',
    escaped: 'name="field%22%0D%0AX-Synthetic: injected"'
  },
  {
    kind: 'filename',
    input: 'file"\r\nX-Synthetic: injected',
    escaped: 'filename="file%22%0D%0AX-Synthetic: injected"'
  }
];
const observed = fixtures.map((fixture) => {
  const value = form();
  if (fixture.kind === 'field') value.append(fixture.input, 'hello');
  else
    value.append('file', Buffer.from('hello'), {
      filename: fixture.input,
      contentType: 'text/plain'
    });
  const body = value.getBuffer().toString();
  assert(body.length < 512, 'fixture stays bounded');
  return {
    ...fixture,
    injectedHeader: body.includes('\r\nX-Synthetic: injected'),
    escapedParameter: body.includes(fixture.escaped),
    body
  };
});
assert.throws(() => require('https').get('https://synthetic.example.test'));
assert.throws(() => require('net').connect(443, 'synthetic.example.test'));
assert.throws(() => require('tls').connect(443, 'synthetic.example.test'));
assert.throws(() => require('firebase-admin'));
assert.throws(() => fs.readFileSync(path.resolve('.env')));
assert.throws(() =>
  fs.readFileSync(path.resolve('data/synthetic-not-read.json'))
);
console.log(
  JSON.stringify(
    {
      node: { version: process.version, execPath: process.execPath },
      chain: chain.map((p, i) => ({
        name: p.name,
        version: p.version,
        metadata: p.file,
        metadataSha256: digest(p.file),
        entry: [adminEntry, storageEntry, retryEntry, typesFile, formEntry][i]
      })),
      formEntrySha256: digest(formEntry),
      normal: {
        serialized: true,
        length: normalBody.length,
        lengthMatches: true
      },
      fixtures: observed,
      limitation:
        'Installed metadata/type-resolution chain, not an Admin runtime form-data invocation. Admin and Storage are not initialized; no transport/provider request.'
    },
    null,
    2
  )
);
for (const fixture of observed) {
  assert.equal(
    fixture.injectedHeader,
    false,
    fixture.kind + ': CRLF must not create a header'
  );
  assert.equal(
    fixture.escapedParameter,
    true,
    fixture.kind + ': quote/CR/LF must be encoded'
  );
}
