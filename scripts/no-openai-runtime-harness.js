'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectConfig, summarizeConfig } = require('../lib/config');

const root = path.join(__dirname, '..');
const runtimeFiles = [
  path.join(root, 'server.js'),
  ...fs
    .readdirSync(path.join(root, 'lib'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(root, 'lib', entry.name))
];

const forbiddenRuntimePatterns = [
  /client\.chat\.completions\.create/,
  /new\s+OpenAI\b/,
  /require\(['"]openai['"]\)/,
  /from\s+['"]openai['"]/,
  /OPENAI_API_KEY/,
  /OPENAI_MODEL_[A-Z_]+/,
  /isRetryableOpenAI/,
  /withOpenAIRetry/
];

for (const filePath of runtimeFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const pattern of forbiddenRuntimePatterns) {
    assert.doesNotMatch(
      source,
      pattern,
      `${path.relative(root, filePath)} still contains ${pattern}`
    );
  }
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
);
assert.strictEqual(packageJson.dependencies?.openai, undefined);
assert.strictEqual(
  typeof packageJson.dependencies?.['@mistralai/mistralai'],
  'string'
);

const validConfig = inspectConfig({
  NODE_ENV: 'test',
  FIREBASE_DATABASE_URL: 'https://example.invalid',
  FIREBASE_SERVICE_ACCOUNT: '{}',
  MISTRAL_API_KEY: 'fake_mistral_key'
});
assert.strictEqual(validConfig.ok, true);
assert.strictEqual(validConfig.config.mistralApiKey, 'fake_mistral_key');
assert.strictEqual(summarizeConfig(validConfig.config).mistralConfigured, true);

const missingMistralConfig = inspectConfig({
  NODE_ENV: 'test',
  FIREBASE_DATABASE_URL: 'https://example.invalid',
  FIREBASE_SERVICE_ACCOUNT: '{}'
});
assert.strictEqual(missingMistralConfig.ok, false);
assert(
  missingMistralConfig.issues.some((issue) => issue.includes('MISTRAL_API_KEY'))
);

console.log('no OpenAI runtime harness: ok');
