const assert = require('assert');
const {
  buildHealthPayload,
  createHealthHandler,
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

function captureResponse(handler) {
  const captured = {
    headers: {},
    statusCode: null,
    payload: null
  };
  const response = {
    set(name, value) {
      captured.headers[name] = value;
      return response;
    },
    status(statusCode) {
      captured.statusCode = statusCode;
      return response;
    },
    json(responsePayload) {
      captured.payload = responsePayload;
      return response;
    }
  };

  handler({}, response);
  return captured;
}

const sharedHandler = createHealthHandler({ RENDER_GIT_COMMIT: deployedSha });
const healthResponse = captureResponse(sharedHandler);
const versionResponse = captureResponse(sharedHandler);

assert.deepStrictEqual(versionResponse, healthResponse);
assert.deepStrictEqual(versionResponse, {
  headers: { 'Cache-Control': 'no-store' },
  statusCode: 200,
  payload: { status: 'ok', gitCommit: deployedSha }
});

const serverSource = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'server.js'),
  'utf8'
);
assert.match(
  serverSource,
  /app\.get\('\/health', healthHandler\);\s*app\.get\('\/version', healthHandler\);/,
  '/health and /version must use the same handler'
);

console.log('health harness: ok');
