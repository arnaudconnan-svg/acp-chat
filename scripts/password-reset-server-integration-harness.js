'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  hashPassword,
  isStrongPassword,
  verifyPassword
} = require('../lib/auth-password');
const {
  createUserSessionCodec,
  sessionMatchesUser
} = require('../lib/auth-session');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function slice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`missing route slice ${start}`);
  return source.slice(from, to);
}
function compileRoute(routeSource, dependencies) {
  const routes = new Map();
  const app = {
    post(route, ...handlers) {
      routes.set(route, handlers.at(-1));
    }
  };
  const names = ['app', ...Object.keys(dependencies)];
  const values = [app, ...Object.values(dependencies)];
  new Function(...names, routeSource)(...values);
  return routes;
}
function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}
function request(body = {}, cookie = '') {
  return { body, headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } };
}

async function main() {
  const users = {};
  const usersRef = {
    child(userId) {
      return {
        async set(value) {
          users[userId] = structuredClone(value);
        },
        async update(patch) {
          Object.assign(users[userId], structuredClone(patch));
        },
        async once() {
          return { val: () => structuredClone(users[userId] || null) };
        }
      };
    }
  };
  const userSessions = new Map();
  const USER_SESSION_DURATION = 30 * 24 * 60 * 60 * 1000;
  const codec = createUserSessionCodec({
    secret: 'integration-secret',
    durationMs: USER_SESSION_DURATION
  });
  const buildUserSessionToken = codec.build;
  const common = {
    normalizeEmail: (value) =>
      String(value || '')
        .trim()
        .toLowerCase(),
    enforceAuthRateLimit: () => true,
    isStrongPassword,
    findUserByEmail: async (email) => {
      const entry = Object.entries(users).find(
        ([, user]) => user.email === email
      );
      return entry
        ? { userId: entry[0], user: structuredClone(entry[1]) }
        : null;
    },
    normalizeCountryCode: () => null,
    crypto,
    hashPassword,
    buildSuperId: () => 'synthetic-super-id',
    buildDefaultUsageEnvelope: () => ({}),
    normalizeUsageMeter: () => ({}),
    usersRef,
    buildUserSessionToken,
    userSessions,
    USER_SESSION_DURATION,
    toPublicUser: (id, user) => ({ id, email: user.email }),
    console
  };
  const registerRoutes = compileRoute(
    slice("app.post('/api/auth/register'", "app.post('/api/auth/login'"),
    common
  );
  const registerRes = response();
  await registerRoutes.get('/api/auth/register')(
    request({ email: 'Personne@Example.test', password: 'Inscription1' }),
    registerRes
  );
  assert.strictEqual(registerRes.statusCode, 201);
  const userId = registerRes.body.user.id;
  assert(verifyPassword('Inscription1', users[userId].passwordHash));
  const registrationCookie = registerRes.headers['Set-Cookie'];
  assert(registrationCookie);

  const loginRateLimiter = { reset() {} };
  const loginRoutes = compileRoute(
    slice("app.post('/api/auth/login'", "app.post('/api/auth/logout'"),
    {
      ...common,
      verifyPassword,
      normalizeSuperId: (value) => value,
      authRateLimiters: { login: loginRateLimiter },
      buildAuthRateLimitKey: () => 'key'
    }
  );
  const oldLogin = response();
  await loginRoutes.get('/api/auth/login')(
    request({ email: 'personne@example.test', password: 'Inscription1' }),
    oldLogin
  );
  assert.strictEqual(oldLogin.statusCode, 200);

  const getUserSessionSource = slice(
    'async function getUserSession(req) {',
    'async function requireUserAuth'
  );
  const getUserSession = new Function(
    'parseCookies',
    'userSessions',
    'parseAndValidateUserSessionToken',
    'USER_SESSION_DURATION',
    'usersRef',
    'sessionMatchesUser',
    `return (${getUserSessionSource})`
  )(
    (req) => {
      const raw = String(req.headers.cookie || '').split('=')[1] || '';
      return { userSessionId: raw.split(';')[0] };
    },
    userSessions,
    codec.parse,
    USER_SESSION_DURATION,
    usersRef,
    sessionMatchesUser
  );
  const tokenFromCookie = (cookie) => cookie.match(/userSessionId=([^;]+)/)[1];
  const registrationToken = tokenFromCookie(registrationCookie);
  assert(
    await getUserSession(request({}, `userSessionId=${registrationToken}`)),
    'cached cookie must resolve'
  );
  userSessions.clear();
  assert(
    await getUserSession(request({}, `userSessionId=${registrationToken}`)),
    'signed cookie must reload outside cache'
  );

  let changeOutcome = {
    status: 'success',
    authVersion: 1,
    updatedAt: new Date().toISOString()
  };
  const passwordResetService = {
    async changePassword(args) {
      if (changeOutcome.status !== 'success') return changeOutcome;
      users[args.userId].passwordHash = hashPassword(args.newPassword);
      users[args.userId].authVersion = changeOutcome.authVersion;
      return changeOutcome;
    }
  };
  const changeRoutes = compileRoute(
    slice(
      "app.post('/api/auth/change-password'",
      "app.get('/api/account/content-grants'"
    ),
    {
      requireUserAuth() {},
      isStrongPassword,
      passwordResetService,
      userSessions,
      buildUserSessionToken,
      USER_SESSION_DURATION,
      console
    }
  );
  const session = await getUserSession(
    request({}, `userSessionId=${registrationToken}`)
  );
  const changedRes = response();
  await changeRoutes.get('/api/auth/change-password')(
    {
      ...request({
        currentPassword: 'Inscription1',
        newPassword: 'Modification2'
      }),
      userSession: session
    },
    changedRes
  );
  assert.strictEqual(changedRes.statusCode, 200);
  assert(verifyPassword('Modification2', users[userId].passwordHash));
  assert(!verifyPassword('Inscription1', users[userId].passwordHash));
  assert.strictEqual(
    await getUserSession(request({}, `userSessionId=${registrationToken}`)),
    null,
    'old cached/signed cookie must be revoked'
  );
  const renewedToken = tokenFromCookie(changedRes.headers['Set-Cookie']);
  assert(await getUserSession(request({}, `userSessionId=${renewedToken}`)));

  const sessionsBeforeAbort = userSessions.size;
  changeOutcome = { status: 'invalid_current_password' };
  const abortedRes = response();
  await changeRoutes.get('/api/auth/change-password')(
    {
      ...request({
        currentPassword: 'Modification2',
        newPassword: 'Abandonne33'
      }),
      userSession: await getUserSession(
        request({}, `userSessionId=${renewedToken}`)
      )
    },
    abortedRes
  );
  assert.strictEqual(abortedRes.statusCode, 401);
  assert.strictEqual(abortedRes.headers['Set-Cookie'], undefined);
  assert.strictEqual(
    userSessions.size,
    sessionsBeforeAbort,
    'aborted transaction must not create a session'
  );

  const legacyUserId = 'u_cccccccccccccccccccccccc';
  users[legacyUserId] = {
    email: 'legacy@example.test',
    passwordHash: hashPassword('LegacyMot1')
  };
  const legacyPayload = `${legacyUserId}:${Date.now()}`;
  const legacyToken = `${legacyPayload}.${codec.sign(legacyPayload)}`;
  userSessions.clear();
  assert(
    await getUserSession(request({}, `userSessionId=${legacyToken}`)),
    'legacy session without authVersion remains valid for legacy account'
  );

  console.log(
    '[PASS] real server auth routes and getUserSession with synthetic RTDB'
  );
}
main().catch((error) => {
  console.error('[FAIL] server auth integration harness:', error);
  process.exit(1);
});
