'use strict';
const assert = require('node:assert/strict');
const console = require('node:console');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
assert(
  require.cache[path.resolve('scripts/synthetic/guard.cjs')],
  'M0 must be preloaded'
);
const eslintRequire = createRequire(require.resolve('@eslint/eslintrc'));
const minimatchEntry = eslintRequire.resolve('minimatch');
const parentRequire = createRequire(minimatchEntry);
const entry = parentRequire.resolve('brace-expansion');
const expand = parentRequire('brace-expansion');
const minimatch = eslintRequire('minimatch');
const parent = eslintRequire('minimatch/package.json');
const pkg = parentRequire('brace-expansion/package.json');
assert.equal(parent.version, '3.1.5');
assert.equal(parent.dependencies['brace-expansion'], '^1.1.7');
assert.equal(
  pkg.version,
  process.argv.includes('--baseline') ? '1.1.14' : '1.1.21'
);
const source = fs.readFileSync(entry, 'utf8');
const sha256 = crypto.createHash('sha256').update(source).digest('hex');
assert.deepEqual(expand('file{01..03}.txt'), [
  'file01.txt',
  'file02.txt',
  'file03.txt'
]);
assert.deepEqual(expand('{a,{b,c}}'), ['a', 'b', 'c']);
assert.deepEqual(expand('x{a,b}{1,2}'), ['xa1', 'xa2', 'xb1', 'xb2']);
assert.deepEqual(expand('\\{literal\\}'), ['{literal}']);
assert.deepEqual(expand('${a,b}'), ['${a,b}']);
assert.deepEqual(expand(''), []);
assert.deepEqual(expand('{a},b}'), ['a}', 'b']);
assert.deepEqual(minimatch.braceExpand('src/{a,b}.js'), [
  'src/a.js',
  'src/b.js'
]);
assert(minimatch('src/a.js', 'src/{a,b}.js'));
assert(!minimatch('src/c.js', 'src/{a,b}.js'));
assert(require.cache[entry], 'parent resolved physical module is loaded');
// Supplement actual-package checks with deterministic operation/stack counts.
// Execute the exact installed source; only add a parser-entry probe and wrap
// the REAL balanced-match function. No expansion algorithm or dependency mock.
function probe(input, options) {
  const stats = { balancedCalls: 0, commaDepth: 0 };
  assert(source.includes('function parseCommaParts(str) {'));
  const observed = source.replace(
    'function parseCommaParts(str) {',
    'function parseCommaParts(str) { __probe();'
  );
  const sandbox = {
    module: { exports: {} },
    require(name) {
      const real = parentRequire(name);
      if (name !== 'balanced-match') return real;
      return (...args) => {
        if (++stats.balancedCalls > 2000)
          throw new Error('synthetic operation safety cap');
        return real(...args);
      };
    },
    __probe() {
      const previous = Error.stackTraceLimit;
      try {
        Error.stackTraceLimit = 100;
        stats.commaDepth = Math.max(
          stats.commaDepth,
          (new Error().stack.match(/at parseCommaParts/g) || []).length
        );
      } finally {
        Error.stackTraceLimit = previous;
      }
    }
  };
  vm.runInNewContext(observed, sandbox, { filename: entry });
  const result = sandbox.module.exports(input, options);
  // Cross-check every instrumented output against the actual loaded module.
  assert.deepEqual(Array.from(result), expand(input, options));
  return {
    ...stats,
    results: result.length,
    characters: result.reduce((n, s) => n + s.length, 0)
  };
}
const observations = [];
function check(advisory, name, input, options, predicate) {
  const observed = probe(input, options);
  const passed = predicate(observed);
  observations.push({
    advisory,
    name,
    inputBytes: input.length,
    options,
    observed,
    passed
  });
}
check(
  'GHSA-3jxr-9vmj-r5cp',
  'consecutive non-expanding groups',
  'x' + '{}'.repeat(24),
  {},
  (x) => x.balancedCalls <= 2 && x.results === 1
);
check(
  'GHSA-mh99-v99m-4gvg',
  'total output character budget',
  '{aaaa,bbbb}'.repeat(5),
  { maxLength: 32 },
  (x) => x.characters <= 32 && x.results > 0
);
check(
  'GHSA-rgw5-rvv9-x895',
  'intermediate comma alternatives budget',
  '{' + Array(80).fill('abcd').join(',') + '}',
  { max: 100, maxLength: 16 },
  (x) => x.balancedCalls <= 8 && x.characters <= 16 && x.results === 4
);
check(
  'GHSA-6j4f-fj2g-mc7p',
  'iterative comma parser',
  '{' + '{a},'.repeat(24) + 'z}',
  {},
  (x) => x.commaDepth === 1 && x.results === 25
);
check(
  'GHSA-qhr7-859c-m2p7',
  'nested group depth budget',
  '{'.repeat(12) + 'a,b' + '}'.repeat(12),
  { maxDepth: 2 },
  (x) => x.balancedCalls <= 8 && x.results === 1
);
check(
  'GHSA-q2hr-2g5m-vwhr',
  'rewrite restart budget',
  '{a}' + '}'.repeat(12) + ',z}',
  { maxRewrites: 2 },
  (x) => x.balancedCalls <= 4 && x.results === 1
);
console.log(
  JSON.stringify(
    {
      node: process.version,
      eslint: eslintRequire('@eslint/eslintrc/package.json').version,
      parent: {
        entry: minimatchEntry,
        version: parent.version,
        range: parent.dependencies['brace-expansion']
      },
      physical: { entry, version: pkg.version, sha256 },
      normalCases: 'passed',
      observations
    },
    null,
    2
  )
);
assert(
  observations.every((x) => x.passed),
  'all bounded advisory checks must pass (see observations)'
);
console.log('brace harness: PASS');
