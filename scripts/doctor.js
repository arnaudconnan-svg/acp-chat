'use strict';

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { inspectConfig, summarizeConfig } = require('../lib/config');

const rootDir = path.resolve(__dirname, '..');
const deepMode = process.argv.includes('--deep');

function resolveExecutable(command) {
  if (process.platform !== 'win32') {
    return command;
  }

  return command;
}

function quoteForCmd(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '\\"')}"`;
}

function spawnCommand(command, args, options = {}) {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const commandLine = [command, ...args].map(quoteForCmd).join(' ');
    return spawnSync(comspec, ['/d', '/s', '/c', commandLine], options);
  }

  return spawnSync(resolveExecutable(command), args, options);
}

function runStep(label, command, args) {
  console.log(`\n[doctor] ${label}`);
  const result = spawnCommand(command, args, {
    cwd: rootDir,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    console.error(`[doctor] FAILED: ${label}`);
    return false;
  }

  console.log(`[doctor] OK: ${label}`);
  return true;
}

function readVersion(bin, args = ['--version']) {
  const result = spawnCommand(bin, args, {
    cwd: rootDir,
    encoding: 'utf8'
  });
  return result.status === 0
    ? String(result.stdout || '').trim()
    : 'unavailable';
}

console.log('[doctor] Local diagnostics');
console.log(`[doctor] node: ${readVersion('node')}`);
console.log(`[doctor] npm: ${readVersion('npm')}`);
console.log(`[doctor] NODE_ENV: ${String(process.env.NODE_ENV || '<unset>')}`);

const serviceAccountPath = path.join(rootDir, 'serviceAccount.json');
console.log(
  `[doctor] serviceAccount.json present: ${fs.existsSync(serviceAccountPath) ? 'yes' : 'no'}`
);

const inspectedConfig = inspectConfig(process.env);
if (inspectedConfig.ok) {
  const summary = summarizeConfig(inspectedConfig.config);
  console.log('[doctor] config summary:');
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('[doctor] config issues detected:');
  for (const issue of inspectedConfig.issues) {
    console.log(`  - ${issue}`);
  }
}

const steps = [
  ['Syntax check server', 'node', ['--check', 'server.js']],
  ['Core state harness', 'npm', ['run', 'state:harness']],
  ['Branching harness', 'npm', ['run', 'branching:harness']],
  ['Transcript harness', 'npm', ['run', 'transcript:harness']]
];

if (deepMode) {
  steps.push(['Config check', 'npm', ['run', 'config:check']]);
  steps.push(['Lint', 'npm', ['run', 'lint']]);
  steps.push(['Tooling format check', 'npm', ['run', 'format:check:tooling']]);
}

let allPassed = true;
for (const [label, command, args] of steps) {
  const ok = runStep(label, command, args);
  if (!ok) {
    allPassed = false;
  }
}

console.log('');
if (!allPassed) {
  console.error('[doctor] one or more checks failed');
  process.exit(1);
}

console.log('[doctor] all checks passed');
