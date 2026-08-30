'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
const indexSource = fs.readFileSync(
  path.join(rootDir, 'public', 'index.html'),
  'utf8'
);

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`[PASS] ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`[FAIL] ${label}: ${err.message}`);
    failed += 1;
  }
}

function assertIncludes(source, expected, label) {
  if (!source.includes(expected)) {
    throw new Error(`${label} missing`);
  }
}

function assertNotIncludes(source, forbidden, label) {
  if (source.includes(forbidden)) {
    throw new Error(`${label} still present`);
  }
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Missing start marker: ${startMarker}`);
  }

  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`Missing end marker: ${endMarker}`);
  }

  return source.slice(start, end);
}

const branchActorResolver = sliceBetween(
  serverSource,
  'async function resolveBranchActorUserId(req) {',
  'const BRANCH_ROUTE_DEBUG'
);

const parseChatRequest = sliceBetween(
  serverSource,
  'function parseChatRequest(req) {',
  'function validateChatRequestShape'
);

const feedbackSnapshotRoute = sliceBetween(
  serverSource,
  "app.post('/api/branches/feedback-snapshot'",
  "app.post('/api/branches/:id/activate'"
);

check('branch routes require server user auth', () => {
  [
    "app.get('/api/branches', requireUserAuth",
    "app.post('/api/branches/from-message', requireUserAuth",
    "app.post('/api/branches/create-and-activate', requireUserAuth",
    "app.post('/api/branches/:id/activate', requireUserAuth",
    "app.get('/api/branches/:id', requireUserAuth"
  ].forEach((route) => assertIncludes(serverSource, route, route));
});

check('branch actor id comes only from req.userSession', () => {
  assertIncludes(
    branchActorResolver,
    "return String(req.userSession?.userId || '').trim();",
    'session user resolver'
  );
  assertNotIncludes(branchActorResolver, 'req.body', 'branch body user id');
  assertNotIncludes(branchActorResolver, 'req.query', 'branch query user id');
  assertNotIncludes(branchActorResolver, 'getUserSession', 'branch lazy session lookup');
});

check('feedback routes require auth and never create anonymous snapshots', () => {
  assertIncludes(
    serverSource,
    "app.post('/api/messages/:id/feedback', requireUserAuth",
    'message feedback auth'
  );
  assertIncludes(
    serverSource,
    "app.post('/api/branches/feedback-snapshot', requireUserAuth",
    'feedback snapshot auth'
  );
  assertNotIncludes(feedbackSnapshotRoute, "'u_anon'", 'snapshot anonymous fallback');
});

check('conversation title routes require auth and ownership checks', () => {
  assertIncludes(
    serverSource,
    "app.post('/api/conversations/:id/title', requireUserAuth",
    'conversation title write auth'
  );
  assertIncludes(
    serverSource,
    "app.get('/api/conversations/:id/title', requireUserAuth",
    'conversation title read auth'
  );
  assertIncludes(
    serverSource,
    "String(data.userId || '').trim() !== userId",
    'conversation title ownership check'
  );
});

check('chat request identity comes only from server session', () => {
  assertIncludes(parseChatRequest, 'const userId = sessionUserId;', 'chat session user id');
  assertNotIncludes(parseChatRequest, 'req.body?.userId', 'chat body user id');
  assertNotIncludes(parseChatRequest, 'u_anon', 'chat anonymous fallback');
});

check('frontend does not send generic userId for protected conversations', () => {
  assertNotIncludes(indexSource, 'getOrCreateUserId(', 'generic local user id helper');
  assertNotIncludes(indexSource, '/api/branches?userId=', 'branch query user id');
  assertNotIncludes(indexSource, '?userId=', 'protected query user id');
  assertIncludes(
    indexSource,
    'getLegacyLocalUserIdForImportOnly',
    'legacy import helper naming'
  );
});

if (failed > 0) {
  console.error(`\n${failed} authenticated conversation route checks failed.`);
  process.exit(1);
}

console.log(`\n${passed} authenticated conversation route checks passed.`);