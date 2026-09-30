'use strict';

const assert = require('assert');
const {
  RESET_TTL_MS,
  createBoundedJobQueue,
  createBoundedRateLimiter,
  createPasswordResetService,
  createResetEmailSender,
  passwordRevision,
  resolveCanonicalOrigin,
  resolveResetClientIp,
  sha256
} = require('../lib/password-reset');
const {
  hashPassword,
  isStrongPassword,
  verifyPassword
} = require('../lib/auth-password');
const {
  createUserSessionCodec,
  sessionMatchesUser
} = require('../lib/auth-session');

const clone = (value) =>
  value == null ? value : JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFaithfulUsersRef(initial) {
  const users = clone(initial);
  const coldDelivered = new Set();
  const locks = new Map();
  const retries = new Map();
  const aborts = new Set();
  const deletions = new Set();
  return {
    users,
    retryNext(userId, mutate) {
      retries.set(userId, mutate);
    },
    abortNext(userId) {
      aborts.add(userId);
    },
    deleteBeforeNextTransaction(userId) {
      deletions.add(userId);
    },
    child(userId) {
      return {
        async once() {
          return { val: () => clone(users[userId]) };
        },
        async transaction(updater) {
          const previous = locks.get(userId) || Promise.resolve();
          let result;
          const operation = previous.then(() => {
            if (deletions.delete(userId)) delete users[userId];
            if (!coldDelivered.has(userId)) {
              coldDelivered.add(userId);
              const coldResult = updater(null);
              assert.notStrictEqual(
                coldResult,
                undefined,
                'cold null must not abort transaction'
              );
            }
            let next = updater(clone(users[userId]));
            const conflict = retries.get(userId);
            if (conflict) {
              retries.delete(userId);
              conflict(users[userId]);
              next = updater(clone(users[userId]));
            }
            if (aborts.delete(userId)) {
              result = {
                committed: false,
                snapshot: { val: () => clone(users[userId]) }
              };
              return;
            }
            users[userId] = clone(next);
            result = { committed: true, snapshot: { val: () => clone(next) } };
          });
          locks.set(
            userId,
            operation.catch(() => {})
          );
          await operation;
          return result;
        }
      };
    }
  };
}

function makeService({ ref, sent = [], nowRef, findUserByEmail, ...options }) {
  return createPasswordResetService({
    usersRef: ref,
    findUserByEmail:
      findUserByEmail ||
      (async (email) =>
        email === 'personne@example.test'
          ? {
              userId: 'u_aaaaaaaaaaaaaaaaaaaaaaaa',
              user: clone(ref.users.u_aaaaaaaaaaaaaaaaaaaaaaaa)
            }
          : null),
    normalizeEmail: (value) =>
      String(value || '')
        .trim()
        .toLowerCase(),
    hashPassword,
    verifyPassword,
    isStrongPassword,
    sendResetEmail: async (message) => {
      sent.push(message);
      return true;
    },
    canonicalAppUrl: 'https://beta.facilitat.io',
    now: () => nowRef.value,
    randomBytes: () => Buffer.alloc(32, sent.length + 1),
    ...options
  });
}

async function waitFor(predicate) {
  for (let i = 0; i < 30; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('async job did not finish');
}

async function main() {
  const logged = [];
  const adversarial = 'secret-token password personne@example.test';
  const failingSender = createResetEmailSender({
    transporter: {
      async sendMail() {
        throw new Error(adversarial);
      }
    },
    fromAddress: 'no-reply@example.test',
    logger: { error: (entry) => logged.push(entry) }
  });
  assert.strictEqual(
    await failingSender({
      to: { address: 'personne@example.test' },
      link: `https://beta.facilitat.io/auth.html#reset=${adversarial}`
    }),
    false
  );
  assert.deepStrictEqual(logged, [{ event: 'password_reset_email_failed' }]);
  assert(!JSON.stringify(logged).includes(adversarial));
  assert.strictEqual(
    resolveCanonicalOrigin('https://beta.facilitat.io'),
    'https://beta.facilitat.io'
  );
  for (const invalid of [
    'http://beta.facilitat.io',
    'https://u:p@beta.facilitat.io',
    'https://beta.facilitat.io/path',
    'https://beta.facilitat.io/?x=1',
    'not-a-url'
  ])
    assert.strictEqual(resolveCanonicalOrigin(invalid), '');
  assert.strictEqual(
    resolveResetClientIp({
      socketAddress: '10.0.0.5',
      forwardedFor: '198.51.100.7, 203.0.113.8',
      trustedProxyHops: 0
    }),
    '10.0.0.5',
    'spoofed forwarding header is ignored by default'
  );
  assert.strictEqual(
    resolveResetClientIp({
      socketAddress: '10.0.0.5',
      forwardedFor: '198.51.100.7, 203.0.113.8',
      trustedProxyHops: 1
    }),
    '203.0.113.8',
    'explicit trust walks from the proxy side'
  );

  const authAccountId = 'u_bbbbbbbbbbbbbbbbbbbbbbbb';
  const registered = {
    email: 'auth@example.test',
    passwordHash: hashPassword('Inscription1'),
    authVersion: 0,
    firstName: 'Authentification'
  };
  assert(verifyPassword('Inscription1', registered.passwordHash));
  assert(!verifyPassword('Erreur9999', registered.passwordHash));
  const authRef = createFaithfulUsersRef({ [authAccountId]: registered });
  const authNow = { value: 1_800_000_000_000 };
  const authService = makeService({ ref: authRef, sent: [], nowRef: authNow });
  const authCodec = createUserSessionCodec({
    secret: 'auth-route-synthetic-secret',
    durationMs: 10_000,
    now: () => authNow.value
  });
  const initialCookieSession = authCodec.parse(
    authCodec.build(authAccountId, registered.authVersion)
  );
  const changed = await authService.changePassword({
    userId: authAccountId,
    currentPassword: 'Inscription1',
    newPassword: 'Modification2'
  });
  assert.strictEqual(changed.status, 'success');
  assert(
    !verifyPassword('Inscription1', authRef.users[authAccountId].passwordHash)
  );
  assert(
    verifyPassword('Modification2', authRef.users[authAccountId].passwordHash)
  );
  assert(
    !sessionMatchesUser(initialCookieSession, authRef.users[authAccountId])
  );
  const renewedCookieSession = authCodec.parse(
    authCodec.build(authAccountId, changed.authVersion)
  );
  assert(
    sessionMatchesUser(renewedCookieSession, authRef.users[authAccountId])
  );

  let clock = 1000;
  const limiter = createBoundedRateLimiter({
    windowMs: 100,
    max: 2,
    maxEntries: 2,
    now: () => clock
  });
  assert(limiter.take('a') && limiter.take('a') && !limiter.take('a'));
  assert(limiter.take('b'));
  assert.strictEqual(limiter.take('c'), false, 'full limiter must fail closed');
  clock += 101;
  assert(limiter.take('c'), 'expired entries are cleaned');

  const gate = deferred();
  const started = [];
  const queue = createBoundedJobQueue({
    worker: async (job) => {
      started.push(job);
      await gate.promise;
    },
    concurrency: 1,
    maxPending: 1
  });
  assert(queue.enqueue(1));
  await tick();
  assert(queue.enqueue(2));
  assert.strictEqual(queue.enqueue(3), false);
  gate.resolve();

  const nowRef = { value: 1_800_000_000_000 };
  const sent = [];
  const accountId = 'u_aaaaaaaaaaaaaaaaaaaaaaaa';
  const ref = createFaithfulUsersRef({
    [accountId]: {
      email: 'personne@example.test',
      passwordHash: hashPassword('AncienMot1'),
      firstName: 'Profil',
      authVersion: 0
    }
  });

  const deletedRef = createFaithfulUsersRef({
    [accountId]: clone(ref.users[accountId])
  });
  const deletedSent = [];
  const deletedService = makeService({
    ref: deletedRef,
    sent: deletedSent,
    nowRef
  });
  deletedRef.deleteBeforeNextTransaction(accountId);
  deletedService.request({
    email: 'personne@example.test',
    ip: '203.0.113.30'
  });
  await waitFor(
    () =>
      deletedService.queueStats().active === 0 &&
      deletedService.queueStats().pending === 0
  );
  assert(
    [null, undefined].includes(deletedRef.users[accountId]),
    'a deletion between preload and transaction must not resurrect the account'
  );
  assert.strictEqual(
    deletedSent.length,
    0,
    'deleted account must receive no mail'
  );

  function buildResetScenarioRef() {
    const secret = 'C'.repeat(43);
    const user = {
      email: 'personne@example.test',
      passwordHash: hashPassword('AvantReset1'),
      authVersion: 0
    };
    user.passwordReset = {
      secretHash: sha256(secret),
      expiresAt: nowRef.value + RESET_TTL_MS,
      issuedAt: nowRef.value,
      passwordRevision: passwordRevision(user)
    };
    return {
      secret,
      ref: createFaithfulUsersRef({ [accountId]: user })
    };
  }

  const abortedReset = buildResetScenarioRef();
  const abortedResetService = makeService({
    ref: abortedReset.ref,
    sent: [],
    nowRef
  });
  abortedReset.ref.abortNext(accountId);
  assert.strictEqual(
    (
      await abortedResetService.consume({
        token: `${accountId}.${abortedReset.secret}`,
        newPassword: 'ApresReset2',
        ip: '203.0.113.31'
      })
    ).status,
    'invalid',
    'an optimistic success proposal with committed=false must fail'
  );
  assert(
    verifyPassword(
      'AvantReset1',
      abortedReset.ref.users[accountId].passwordHash
    )
  );
  assert(abortedReset.ref.users[accountId].passwordReset);

  const lostReset = buildResetScenarioRef();
  const lostResetService = makeService({
    ref: lostReset.ref,
    sent: [],
    nowRef
  });
  lostReset.ref.retryNext(accountId, (current) => {
    delete current.passwordReset;
    current.authVersion += 1;
  });
  assert.strictEqual(
    (
      await lostResetService.consume({
        token: `${accountId}.${lostReset.secret}`,
        newPassword: 'ApresReset2',
        ip: '203.0.113.32'
      })
    ).status,
    'invalid',
    'a retry after another consumer removed the token must lose'
  );

  for (const retryAfterConflict of [false, true]) {
    const changeRef = createFaithfulUsersRef({
      [accountId]: {
        email: 'personne@example.test',
        passwordHash: hashPassword('AvantChange1'),
        authVersion: 0
      }
    });
    const changeService = makeService({ ref: changeRef, sent: [], nowRef });
    if (retryAfterConflict) {
      changeRef.retryNext(accountId, (current) => {
        current.passwordHash = hashPassword('Concurrent9');
        current.authVersion += 1;
      });
    } else {
      changeRef.abortNext(accountId);
    }
    assert.strictEqual(
      (
        await changeService.changePassword({
          userId: accountId,
          currentPassword: 'AvantChange1',
          newPassword: 'ApresChange2'
        })
      ).status,
      'invalid_current_password',
      retryAfterConflict
        ? 'change-password must lose after conflicting password update'
        : 'change-password must fail when its optimistic proposal is not committed'
    );
    assert(
      !verifyPassword('ApresChange2', changeRef.users[accountId].passwordHash)
    );
  }
  const lookupGate = deferred();
  let lookups = 0;
  const queuedService = makeService({
    ref,
    sent,
    nowRef,
    queueConcurrency: 1,
    queueMaxPending: 0,
    findUserByEmail: async () => {
      lookups += 1;
      await lookupGate.promise;
      return null;
    }
  });
  const knownResponse = queuedService.request({
    email: 'personne@example.test',
    ip: '203.0.113.1'
  });
  const unknownResponse = queuedService.request({
    email: 'absent@example.test',
    ip: '203.0.113.2'
  });
  assert.deepStrictEqual(knownResponse, unknownResponse);
  assert.strictEqual(
    lookups,
    0,
    'HTTP admission must return before suspended lookup starts'
  );
  await tick();
  assert.strictEqual(lookups, 1);
  assert.deepStrictEqual(queuedService.queueStats(), { active: 1, pending: 0 });
  lookupGate.resolve();
  await tick();

  const service = makeService({ ref, sent, nowRef });
  service.request({ email: ' Personne@Example.Test ', ip: '203.0.113.3' });
  await waitFor(() => sent.length === 1);
  assert.deepStrictEqual(sent[0].to, { address: 'personne@example.test' });
  const token = new URL(sent[0].link).hash.slice('#reset='.length);
  assert.strictEqual(token.split('.')[0], accountId);
  assert(!JSON.stringify(ref.users).includes(token.split('.')[1]));
  assert.strictEqual(
    ref.users[accountId].passwordReset.expiresAt - nowRef.value,
    RESET_TTL_MS
  );
  assert.strictEqual(
    (await service.consume({ token, newPassword: 'faible', ip: '203.0.113.4' }))
      .status,
    'weak_password'
  );

  let hashCalls = 0;
  const retryService = createPasswordResetService({
    usersRef: ref,
    findUserByEmail: async () => null,
    normalizeEmail: String,
    hashPassword: (password) => {
      hashCalls += 1;
      return hashPassword(password);
    },
    verifyPassword,
    isStrongPassword,
    sendResetEmail: async () => true,
    canonicalAppUrl: 'https://beta.facilitat.io',
    now: () => nowRef.value
  });
  ref.retryNext(accountId, () => {});
  assert.strictEqual(
    (
      await retryService.consume({
        token,
        newPassword: 'NouveauMot2',
        ip: '203.0.113.5'
      })
    ).status,
    'success'
  );
  assert.strictEqual(
    hashCalls,
    1,
    'scrypt hash must be prepared once across transaction retry'
  );
  assert(verifyPassword('NouveauMot2', ref.users[accountId].passwordHash));
  assert(!verifyPassword('AncienMot1', ref.users[accountId].passwordHash));
  assert.strictEqual(ref.users[accountId].firstName, 'Profil');

  service.request({ email: 'personne@example.test', ip: '203.0.113.6' });
  await waitFor(() => sent.length === 2);
  const raceToken = new URL(sent[1].link).hash.slice('#reset='.length);
  const race = await Promise.all([
    service.consume({
      token: raceToken,
      newPassword: 'ResetWinner3',
      ip: '203.0.113.7'
    }),
    service.changePassword({
      userId: accountId,
      currentPassword: 'NouveauMot2',
      newPassword: 'ChangeWinner4'
    })
  ]);
  assert.strictEqual(
    race.filter((entry) => entry.status === 'success').length,
    1,
    'reset/change race must have one winner'
  );
  assert.strictEqual(ref.users[accountId].passwordReset, undefined);

  const version = ref.users[accountId].authVersion;
  const codec = createUserSessionCodec({
    secret: 'synthetic-secret',
    durationMs: 10000,
    now: () => nowRef.value
  });
  const currentSession = codec.parse(codec.build(accountId, version));
  assert(sessionMatchesUser(currentSession, ref.users[accountId]));
  assert(
    !sessionMatchesUser(
      { ...currentSession, authVersion: version - 1 },
      ref.users[accountId]
    ),
    'cached and reloaded old sessions are revoked'
  );
  const legacyPayload = `${accountId}:${nowRef.value}`;
  const legacySession = codec.parse(
    `${legacyPayload}.${codec.sign(legacyPayload)}`
  );
  assert.strictEqual(legacySession.authVersion, 0);
  assert(sessionMatchesUser(legacySession, { passwordHash: 'legacy' }));

  const ipRef = createFaithfulUsersRef({});
  let ipLookups = 0;
  const ipService = makeService({
    ref: ipRef,
    sent: [],
    nowRef,
    findUserByEmail: async () => {
      ipLookups += 1;
      return null;
    }
  });
  for (let i = 0; i < 11; i += 1)
    ipService.request({ email: `u${i}@example.test`, ip: '198.51.100.9' });
  await waitFor(
    () =>
      ipService.queueStats().active === 0 &&
      ipService.queueStats().pending === 0
  );
  assert.strictEqual(ipLookups, 10, 'IP limit is independent from email keys');
  let emailLookups = 0;
  const emailService = makeService({
    ref: ipRef,
    sent: [],
    nowRef,
    findUserByEmail: async () => {
      emailLookups += 1;
      return null;
    }
  });
  for (let i = 0; i < 4; i += 1)
    emailService.request({
      email: 'same@example.test',
      ip: `198.51.100.${20 + i}`
    });
  await waitFor(
    () =>
      emailService.queueStats().active === 0 &&
      emailService.queueStats().pending === 0
  );
  assert.strictEqual(
    emailLookups,
    3,
    'email limit is independent from IP keys'
  );
  for (let i = 0; i < 31; i += 1)
    await ipService.consume({
      token: 'invalid',
      newPassword: 'NouveauMot9',
      ip: '192.0.2.9'
    });
  assert.strictEqual(
    (
      await ipService.consume({
        token: 'invalid',
        newPassword: 'NouveauMot9',
        ip: '192.0.2.9'
      })
    ).status,
    'rate_limited'
  );

  console.log(
    '[PASS] password reset queue, limits, real scrypt, RTDB retry/races and sessions'
  );
}
main().catch((error) => {
  console.error('[FAIL] password reset harness:', error);
  process.exit(1);
});
