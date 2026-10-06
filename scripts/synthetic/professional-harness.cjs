'use strict';
const assert = require('assert/strict');
const { hashPassword } = require('../../lib/auth-password');
const { loadApplication } = require('./runtime.cjs');
const { createProfessionalAccess } = require('../../lib/professional-access');
const crypto = require('crypto');
let done = false;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
(async () => {
  const identity = (email, roles) => ({
    email,
    passwordHash: hashPassword('SyntheticPassword123!'),
    active: true,
    roles,
    authorizationVersion: 1
  });
  const seed = {
    professionalIdentities: {
      p: identity('p@example.test', ['practitioner']),
      s: identity('s@example.test', ['commercial_support']),
      t: identity('t@example.test', ['technical_support']),
      a: identity('a@example.test', ['administrator']),
      both: identity('both@example.test', ['administrator', 'practitioner'])
    },
    practitionerAssignments: {
      p: { u_A: { active: true } },
      both: { u_A: { active: true } }
    },
    contentGrants: {
      u_A: {
        p: {
          id: 'g_A',
          version: 1,
          active: true,
          scope: 'conversation_specific',
          conversationIds: ['c_A'],
          startsAt: 0,
          endsAt: Date.now() + 100000
        },
        both: {
          id: 'g_both',
          version: 1,
          active: true,
          scope: 'accompaniment_period',
          startsAt: 0,
          endsAt: Date.now() + 100000
        }
      }
    },
    conversations: {
      c_A: { id: 'c_B', userId: 'u_A', title: 'A' },
      c_B: { userId: 'u_B', title: 'B' },
      c_private: { userId: 'u_A', isPrivate: true },
      c_removed: { userId: 'u_A', deletedAt: 1 }
    },
    messages: {
      m_A: {
        userId: 'u_A',
        conversationId: 'c_A',
        role: 'user',
        content: 'VISIBLE',
        debugMeta: { secret: 'MARKER_DEBUG' },
        timestamp: 1
      },
      m_foreign: { userId: 'u_B', conversationId: 'c_A', content: 'FOREIGN' }
    }
  };
  const a = loadApplication({ seed });
  async function login(email) {
    const r = await a.request('post', '/api/pros/login', {
      body: { email, password: 'SyntheticPassword123!' }
    });
    assert.equal(r.statusCode, 200);
    return r.headers['set-cookie'].split(';')[0];
  }
  const cookie = await login('p@example.test');
  const directory = await a.request('get', '/api/facilitation/users', {
    cookie
  });
  assert.equal(directory.body.users.length, 1);
  const userRef = directory.body.users[0].userRef;
  const list = await a.request(
    'get',
    `/api/facilitation/users/${userRef}/conversations`,
    { cookie }
  );
  assert.equal(list.body.conversations.length, 1);
  const conversationRef = list.body.conversations[0].conversationRef;
  const messages = await a.request(
    'get',
    `/api/facilitation/conversations/${conversationRef}/messages`,
    { cookie, query: { userRef } }
  );
  assert.equal(messages.statusCode, 200);
  assert.deepEqual(messages.body.messages, [
    { role: 'user', content: 'VISIBLE', timestamp: 1 }
  ]);
  assert(!JSON.stringify(messages.body).includes('MARKER_DEBUG'));
  assert(!JSON.stringify(messages.body).includes('u_A'));
  assert.equal(
    (
      await a.request(
        'get',
        `/api/facilitation/conversations/${conversationRef}/messages`,
        { cookie, query: { userRef: 'other' } }
      )
    ).statusCode,
    404
  );
  assert.equal(
    (
      await a.request(
        'get',
        `/api/facilitation/intersession-memory/${userRef}`,
        { cookie }
      )
    ).statusCode,
    403
  );
  const restarted = loadApplication({ seed: a.db.data });
  assert.equal(
    (await restarted.request('get', '/api/facilitation/users', { cookie })).body
      .users.length,
    1
  );
  // The durable record is untrusted. Both an already-used token and a fresh
  // application must refuse the same malformed record, without cached authority.
  const sessionKey = crypto
    .createHash('sha256')
    .update(cookie.split('=')[1])
    .digest('hex');
  const durable = structuredClone(a.db.data.professionalSessions[sessionKey]);
  const malformed = [
    { expiresAt: undefined },
    { expiresAt: NaN },
    { expiresAt: Infinity },
    { expiresAt: '9999999999999' },
    { expiresAt: Date.now() - 1 },
    { createdAt: undefined },
    { createdAt: NaN },
    { createdAt: -1 },
    { createdAt: Date.now() + 100000 },
    { schemaVersion: undefined },
    { revoked: undefined },
    { authorizationVersion: -1 },
    { identityId: [] },
    { expiresAt: durable.createdAt + 25 * 60 * 60 * 1000 }
  ];
  for (const patch of malformed) {
    a.db.data.professionalSessions[sessionKey] = { ...durable, ...patch };
    assert.equal(
      (await a.request('get', '/api/facilitation/users', { cookie }))
        .statusCode,
      401,
      JSON.stringify(patch)
    );
    const cold = loadApplication({ seed: a.db.data });
    assert.equal(
      (await cold.request('get', '/api/facilitation/users', { cookie }))
        .statusCode,
      401
    );
  }
  a.db.data.professionalSessions[sessionKey] = durable;
  const both = await login('both@example.test');
  const bothList = await a.request(
    'get',
    `/api/facilitation/users/${userRef}/conversations`,
    { cookie: both }
  );
  assert.equal(bothList.statusCode, 200);
  assert.equal(bothList.body.conversations.length, 1);
  assert.equal(
    bothList.body.conversations[0].conversationRef,
    conversationRef,
    'canonical key survives contradictory stored id'
  );
  assert.equal(
    (
      await a.request(
        'get',
        `/api/facilitation/conversations/${conversationRef}/messages`,
        { cookie: both, query: { userRef } }
      )
    ).statusCode,
    200
  );
  assert.equal(
    (await a.request('get', '/api/admin/users', { cookie: both })).statusCode,
    403,
    'cumulative roles do not waive admin reason'
  );
  const access = createProfessionalAccess({
    db: a.db,
    secret: 'synthetic-unit-key-012345678901234567890'
  });
  const actor = { id: 'both', roles: ['administrator', 'practitioner'] };
  assert.equal(
    await access.content(actor, 'u_A', null, 'messages', 'fixture'),
    false
  );
  assert.equal(
    await access.content(
      actor,
      'u_A',
      { id: 'c_B', userId: 'u_B' },
      'messages',
      'fixture'
    ),
    false
  );
  assert.equal(
    await access.content(
      actor,
      'u_A',
      { id: 'c_private', userId: 'u_A', isPrivate: true },
      'messages',
      'fixture'
    ),
    false
  );
  assert.equal(
    await access.content(
      actor,
      'u_A',
      { id: 'c_A', userId: 'u_A' },
      'messages',
      'fixture'
    ),
    true
  );
  assert.equal(
    await access.content(actor, 'u_A', null, 'summary', 'fixture'),
    false
  );
  a.db.data.contentGrants.u_A.both.allowIntersessionSummary = true;
  assert.equal(
    (
      await a.request(
        'get',
        `/api/facilitation/intersession-memory/${userRef}`,
        { cookie: both }
      )
    ).statusCode,
    200,
    'explicit summary grant positive API'
  );
  assert.equal(
    await access.content(actor, 'u_A', null, 'summary', 'fixture'),
    true
  );
  a.db.data.practitionerAssignments.both.u_A.active = false;
  assert.equal(
    await access.content(
      actor,
      'u_A',
      { id: 'c_A', userId: 'u_A' },
      'messages',
      'fixture'
    ),
    false
  );
  a.db.data.contentGrants.u_A.p.active = false;
  assert.equal(
    (
      await a.request(
        'get',
        `/api/facilitation/conversations/${conversationRef}/messages`,
        { cookie }
      )
    ).statusCode,
    404
  );
  a.db.data.professionalIdentities.p.authorizationVersion++;
  assert.equal(
    (await a.request('get', '/api/facilitation/users', { cookie })).statusCode,
    401
  );
  for (const email of ['s@example.test', 't@example.test']) {
    const support = await login(email);
    assert.equal(
      (
        await a.request('get', '/api/admin/conversations', {
          cookie: support,
          headers: { 'x-access-reason': 'support_incident' }
        })
      ).statusCode,
      403
    );
    assert.equal(
      (await a.request('get', '/api/facilitation/users', { cookie: support }))
        .statusCode,
      403
    );
  }
  const admin = await login('a@example.test');
  assert.equal(
    (await a.request('get', '/api/admin/users', { cookie: admin })).statusCode,
    403
  );
  assert.equal(
    (
      await a.request('get', '/api/admin/users', {
        cookie: admin,
        headers: { 'x-access-reason': 'security_review' }
      })
    ).statusCode,
    200
  );
  await a.request(
    'get',
    '/api/admin/conversations/ADVERSARIAL_TRANSCRIPT_MARKER/messages',
    { cookie: admin, headers: { 'x-access-reason': 'security_review' } }
  );
  assert(
    !JSON.stringify(a.db.data.professionalAccessJournal).includes(
      'ADVERSARIAL_TRANSCRIPT_MARKER'
    )
  );
  await a.request('get', '/api/admin/users', {
    cookie: admin,
    headers: {
      'x-access-reason': 'security_review',
      'x-identity-unmask-reason': 'identity_verification'
    }
  });
  assert(
    Object.values(a.db.data.professionalAccessJournal).some(
      (e) => e.action === 'identity_unmask'
    )
  );
  assert.equal(
    (
      await a.request('get', '/api/admin/session', {
        cookie: 'adminSessionId=legacy.full'
      })
    ).body.authenticated,
    false
  );
  assert.equal(
    (
      await a.request('post', '/api/twa/login', {
        body: { password: 'synthetic-unused' }
      })
    ).statusCode,
    403
  );
  assert(
    Object.values(a.db.data.professionalAccessJournal).some(
      (e) => e.result === 'denied'
    )
  );
  assert(
    Object.values(a.db.data.professionalAccessJournal).some(
      (e) => e.result === 'allowed'
    )
  );
  assert(
    !JSON.stringify(a.db.data.professionalAccessJournal).includes('VISIBLE')
  );
  done = true;
  console.log(
    '[PASS] M1 individual roles, cold restart, grants/revocation, minimal API, supports/admin and journal through genuine Express'
  );
})().catch((e) => {
  done = true;
  console.error(e);
  process.exitCode = 1;
});
