const assert = require('assert');
const {
  buildHealthPayload,
  DEPLOYED_GIT_COMMIT_UNAVAILABLE
} = require('../lib/health');

const deployedSha = '0123456789abcdef0123456789abcdef01234567';
const payload = buildHealthPayload({
  RENDER_GIT_COMMIT: deployedSha,
  DATABASE_SECRET: 'must-not-leak',
  API_KEY: 'must-not-leak-either'
});

assert.deepStrictEqual(payload, {
  status: 'ok',
  gitCommit: deployedSha
});
assert.strictEqual(JSON.stringify(payload).includes('must-not-leak'), false);

assert.deepStrictEqual(buildHealthPayload({}), {
  status: 'ok',
  gitCommit: DEPLOYED_GIT_COMMIT_UNAVAILABLE
});
assert.deepStrictEqual(buildHealthPayload({ RENDER_GIT_COMMIT: '' }), {
  status: 'ok',
  gitCommit: DEPLOYED_GIT_COMMIT_UNAVAILABLE
});

console.log('health harness: ok');
