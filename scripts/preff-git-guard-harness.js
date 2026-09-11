'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const guard = path.resolve(__dirname, 'preff-git-guard.js');

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result;
}

function git(cwd, ...args) {
  return run('git', args, cwd).stdout.trim();
}

function commit(cwd, label) {
  fs.writeFileSync(path.join(cwd, `${label}.txt`), `${label}\n`);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', label);
  return git(cwd, 'rev-parse', 'HEAD');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preff-guard-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const working = path.join(root, 'working');
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main', seed);
  git(seed, 'config', 'user.email', 'harness@example.test');
  git(seed, 'config', 'user.name', 'Pre-FF harness');
  commit(seed, 'base');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', 'origin', 'main');
  git(seed, 'branch', 'beta');
  git(seed, 'push', 'origin', 'beta');
  git(root, 'clone', remote, working);
  git(working, 'config', 'user.email', 'harness@example.test');
  git(working, 'config', 'user.name', 'Pre-FF harness');
  git(working, 'checkout', 'beta');
  return { root, remote, seed, working };
}

function verifyFastForwardSuccess() {
  const test = fixture();
  git(test.seed, 'checkout', 'main');
  const promotedSha = commit(test.seed, 'promoted');
  git(test.seed, 'push', 'origin', 'main');
  const result = run('node', [guard, 'post-promotion-sync'], test.working);
  assert.match(result.stdout, /mandatory post-promotion sync successful/);
  assert.strictEqual(git(test.remote, 'rev-parse', 'main'), promotedSha);
  assert.strictEqual(git(test.remote, 'rev-parse', 'beta'), promotedSha);
  fs.rmSync(test.root, { recursive: true, force: true });
}

function verifyDivergenceStopsWithoutMutation() {
  const test = fixture();
  git(test.seed, 'checkout', 'main');
  commit(test.seed, 'main-only');
  git(test.seed, 'push', 'origin', 'main');
  git(test.seed, 'checkout', 'beta');
  const betaBefore = commit(test.seed, 'beta-only');
  git(test.seed, 'push', 'origin', 'beta');
  const result = run(
    'node',
    [guard, 'post-promotion-sync'],
    test.working,
    true
  );
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /beta-only=1, main-only=1/);
  assert.match(
    result.stderr,
    /no merge, rebase, reset, or force-push was attempted/
  );
  assert.strictEqual(git(test.remote, 'rev-parse', 'beta'), betaBefore);
  fs.rmSync(test.root, { recursive: true, force: true });
}

verifyFastForwardSuccess();
verifyDivergenceStopsWithoutMutation();
console.log('preff-git-guard harness: OK');
