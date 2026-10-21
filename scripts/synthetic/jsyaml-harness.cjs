'use strict';
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const console = require('node:console');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const process = require('node:process');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
assert(
  require.cache[path.resolve('scripts/synthetic/guard.cjs')],
  'M0 must be preloaded'
);
const parentEntry = require.resolve('@eslint/eslintrc');
const parentRequire = createRequire(parentEntry);
const yamlEntry = parentRequire.resolve('js-yaml');
const yaml = parentRequire('js-yaml');
const parent = require('@eslint/eslintrc/package.json');
const yamlPackage = parentRequire('js-yaml/package.json');
assert.equal(parent.version, '3.3.5');
assert.equal(parent.dependencies['js-yaml'], '^4.1.1');
assert.equal(
  yamlPackage.version,
  process.argv.includes('--baseline') ? '4.1.1' : '4.3.2'
);
function digest(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}
const plain =
  'defaults: &defaults {node: true, browser: false}\nresult: {<<: *defaults, browser: true}\n';
assert.deepEqual(yaml.load(plain).result, { node: true, browser: true });
assert.deepEqual(yaml.load(yaml.dump({ normal: ['hello', 2, true] })), {
  normal: ['hello', 2, true]
});
assert.deepEqual(yaml.load('!!omap [a: 1, b: 2]'), [{ a: 1 }, { b: 2 }]);
assert.throws(() => yaml.load('!!omap [a: 1, a: 2]'), /cannot resolve/);
assert.throws(() => yaml.load('broken: [1, 2'), /unexpected end/);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-jsyaml-'));
let eslintConfig;
try {
  const file = path.join(tmp, '.eslintrc.yml');
  fs.writeFileSync(
    file,
    'root: true\nenv: &env {node: true}\noverrides:\n  - files: ["*.js"]\n    env: {<<: *env, browser: true}\nrules:\n  no-unused-vars: warn\n'
  );
  const { Legacy } = require('@eslint/eslintrc');
  const loaded = Legacy.loadConfigFile(file);
  assert.equal(loaded.overrides[0].env.browser, true);
  assert.equal(loaded.overrides[0].env.node, true);
  const factory = new Legacy.ConfigArrayFactory({ cwd: tmp });
  const config = factory
    .loadFile(file)
    .extractConfig(path.join(tmp, 'synthetic.js'));
  assert.equal(config.env.node, true);
  assert.equal(config.env.browser, true);
  assert.deepEqual(config.rules['no-unused-vars'], ['warn']);
  assert(
    require.cache[yamlEntry],
    'actual parent-resolved YAML module is loaded'
  );
  eslintConfig = {
    loader: 'Legacy.loadConfigFile + ConfigArrayFactory.loadFile',
    env: config.env,
    rule: config.rules['no-unused-vars']
  };
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
// Small deterministic work budgets discriminate merge shapes without timing benchmarks.
const repeated =
  'source: &source {a: 1, b: 2, c: 3, d: 4}\nresult: {<<: [' +
  Array(12).fill('*source').join(', ') +
  ']}\n';
let chain = 'm0: &m0 {k0: 0}\n';
for (let i = 1; i <= 12; i++)
  chain += `m${i}: &m${i} {<<: *m${i - 1}, k${i}: ${i}}\n`;
const empty =
  'source: &source {}\nresult: {<<: [' +
  Array(20).fill('*source').join(', ') +
  ']}\n';
const defaultEmpty =
  'source: &source {}\nresult: {<<: [' +
  Array(10002).fill('*source').join(', ') +
  ']}\n';
const fixtures = [
  { name: 'repeated-alias-merges', document: repeated, budget: 16 },
  { name: 'expanding-merge-chain', document: chain, budget: 16 },
  { name: 'empty-source-budget-bypass', document: empty, budget: 16 },
  { name: 'empty-source-default-limit', document: defaultEmpty }
];
const observations = fixtures.map((fixture) => {
  assert(
    Buffer.byteLength(fixture.document) < 100000,
    'bounded authored fixture'
  );
  let error;
  try {
    yaml.load(
      fixture.document,
      fixture.budget === undefined ? {} : { maxTotalMergeKeys: fixture.budget }
    );
  } catch (e) {
    error = { name: e.name, reason: e.reason };
  }
  return {
    name: fixture.name,
    bytes: Buffer.byteLength(fixture.document),
    budget: fixture.budget ?? 'default 10000',
    error: error ?? null
  };
});
// The same non-empty shapes remain valid below a larger finite budget.
assert.equal(yaml.load(repeated, { maxTotalMergeKeys: 128 }).result.a, 1);
assert.equal(yaml.load(chain, { maxTotalMergeKeys: 128 }).m12.k12, 12);
assert.deepEqual(yaml.load(empty, { maxTotalMergeKeys: 128 }).result, {});
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
      parent: {
        version: parent.version,
        entry: parentEntry,
        range: parent.dependencies['js-yaml']
      },
      yaml: {
        version: yamlPackage.version,
        entry: yamlEntry,
        entrySha256: digest(yamlEntry),
        loaderSha256: digest(
          path.join(path.dirname(yamlEntry), 'lib/loader.js')
        )
      },
      normalYaml: true,
      eslintConfig,
      observations,
      limitation:
        'Deterministic configured/default merge-work limits on bounded synthetic inputs; no timing/asymptotic benchmark. Legacy ESLint YAML loading tested; application uses flat eslint.config.js, and js-yaml remains a dev dependency.'
    },
    null,
    2
  )
);
for (const item of observations) {
  assert.equal(
    item.error?.name,
    'YAMLException',
    item.name + ': merge work must be bounded'
  );
  assert.match(
    item.error.reason,
    /maxTotalMergeKeys/,
    item.name + ': expected work-budget rejection'
  );
}
