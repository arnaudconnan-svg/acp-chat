'use strict';
const crypto = require('crypto');
const { verifyPassword } = require('./auth-password');
const ROLES = new Set([
  'practitioner',
  'commercial_support',
  'technical_support',
  'administrator'
]);
const REASONS = new Set([
  'support_incident',
  'security_review',
  'user_request',
  'identity_verification'
]);
const idValid = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
function createProfessionalAccess({ db, secret, now = Date.now }) {
  if (typeof secret !== 'string' || secret.length < 32)
    throw new Error('professional_signing_secret_required');
  const refs = {
    identities: db.ref('professionalIdentities'),
    sessions: db.ref('professionalSessions'),
    assignments: db.ref('practitionerAssignments'),
    grants: db.ref('contentGrants'),
    journal: db.ref('professionalAccessJournal')
  };
  const hash = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const reference = (kind, id) =>
    `fac_${kind}_${crypto.createHmac('sha256', secret).update(`${kind}:${id}`).digest('hex').slice(0, 24)}`;
  function roles(record) {
    return Array.isArray(record?.roles) &&
      record.roles.length &&
      record.roles.every((r) => ROLES.has(r))
      ? [...new Set(record.roles)]
      : [];
  }
  async function journal({
    actor = null,
    action,
    object = null,
    grant = null,
    reason = 'denied',
    result = 'denied',
    requestId = null,
    role = null
  }) {
    await refs.journal.push({
      actor: actor?.id || null,
      role: role || actor?.roles || [],
      object:
        typeof object === 'string' && /^fac_[a-z]+_[a-f0-9]{24}$/.test(object)
          ? object
          : null,
      action,
      grant,
      reason: REASONS.has(reason)
        ? reason
        : /^[a-z_]{1,64}$/.test(reason)
          ? reason
          : 'invalid_reason',
      result,
      timestamp: new Date(now()).toISOString(),
      requestId: idValid(requestId) ? requestId : null
    });
  }
  async function login(email, password) {
    const rows =
      (
        await refs.identities
          .orderByChild('email')
          .equalTo(
            String(email || '')
              .trim()
              .toLowerCase()
          )
          .once('value')
      ).val() || {};
    const entries = Object.entries(rows);
    if (entries.length !== 1) return null;
    const [id, record] = entries[0];
    if (
      !idValid(id) ||
      record.active !== true ||
      !roles(record).length ||
      !Number.isSafeInteger(record.authorizationVersion) ||
      record.authorizationVersion < 0 ||
      !verifyPassword(password, record.passwordHash)
    )
      return null;
    const token = crypto.randomBytes(32).toString('hex');
    await refs.sessions
      .child(hash(token))
      .set({
        identityId: id,
        authorizationVersion: record.authorizationVersion,
        schemaVersion: 1,
        createdAt: now(),
        expiresAt: now() + 24 * 60 * 60 * 1000,
        revoked: false
      });
    return token;
  }
  async function session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const s = (await refs.sessions.child(hash(token)).once('value')).val();
    if (
      !s ||
      s.schemaVersion !== 1 ||
      s.revoked !== false ||
      !Number.isFinite(s.createdAt) ||
      s.createdAt < 0 ||
      s.createdAt > now() ||
      !Number.isFinite(s.expiresAt) ||
      s.expiresAt <= now() ||
      s.expiresAt - s.createdAt > 24 * 60 * 60 * 1000 ||
      !Number.isSafeInteger(s.authorizationVersion) ||
      s.authorizationVersion < 0 ||
      !idValid(s.identityId)
    )
      return null;
    const i = (await refs.identities.child(s.identityId).once('value')).val();
    if (
      i?.active !== true ||
      !roles(i).length ||
      !Number.isSafeInteger(i.authorizationVersion) ||
      i.authorizationVersion !== s.authorizationVersion
    )
      return null;
    return {
      id: s.identityId,
      roles: roles(i),
      authorizationVersion: i.authorizationVersion,
      canUseAdminUi: true,
      canBypassTwaGate: false,
      canAccessAdminConversations: roles(i).includes('administrator'),
      canAccessSupportCases: roles(i).includes('administrator'),
      canAccessFacilitationAdmin: roles(i).includes('practitioner')
    };
  }
  async function revoke(token) {
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token))
      await refs.sessions.child(hash(token)).update({ revoked: true });
  }
  async function assignmentAndGrant(actor, userId) {
    if (!actor?.roles.includes('practitioner') || !idValid(userId)) return null;
    const [a, g] = await Promise.all([
      refs.assignments.child(actor.id).child(userId).once('value'),
      refs.grants.child(userId).child(actor.id).once('value')
    ]);
    const assignment = a.val(),
      grant = g.val();
    if (
      assignment?.active !== true ||
      grant?.active !== true ||
      !idValid(grant.id) ||
      !Number.isSafeInteger(grant.version) ||
      !Number.isFinite(grant.startsAt) ||
      !Number.isFinite(grant.endsAt) ||
      grant.startsAt > now() ||
      grant.endsAt <= now() ||
      !['conversation_specific', 'accompaniment_period'].includes(grant.scope)
    )
      return null;
    return grant;
  }
  async function content(
    actor,
    userId,
    conversation,
    action,
    requestId,
    reason,
    exercisedRole = 'practitioner'
  ) {
    let grant = null,
      ok = false,
      code = 'content_denied',
      role = null;
    if (
      action !== 'summary' &&
      (!conversation ||
        !idValid(conversation.id) ||
        conversation.userId !== userId)
    )
      code = 'object_owner_mismatch';
    else if (conversation?.isPrivate === true || conversation?.deletedAt)
      code = 'private_or_removed';
    else if (
      exercisedRole === 'administrator' &&
      actor?.roles.includes('administrator')
    ) {
      role = 'administrator';
      ok = REASONS.has(reason);
      code = ok ? reason : 'administrator_reason_required';
    } else {
      role = actor?.roles.includes('practitioner') ? 'practitioner' : null;
      grant = await assignmentAndGrant(actor, userId);
      ok =
        !!grant &&
        (action === 'summary'
          ? grant.allowIntersessionSummary === true
          : grant.scope === 'accompaniment_period' ||
            (Array.isArray(grant.conversationIds) &&
              grant.conversationIds.includes(conversation?.id)));
      code = ok ? 'active_grant' : 'grant_required';
    }
    await journal({
      actor,
      role,
      action,
      object: conversation?.id
        ? reference('conversation', conversation.id)
        : reference('user', userId),
      grant: grant ? { id: grant.id, version: grant.version } : null,
      reason: code,
      result: ok ? 'allowed' : 'denied',
      requestId
    });
    return ok;
  }
  async function directory(actor) {
    if (!actor?.roles.includes('practitioner')) return [];
    const assignments =
      (await refs.assignments.child(actor.id).once('value')).val() || {};
    const out = [];
    for (const [userId, a] of Object.entries(assignments)) {
      if (
        a.active !== true ||
        !idValid(userId) ||
        !(await assignmentAndGrant(actor, userId))
      )
        continue;
      out.push({ userId, userRef: reference('user', userId) });
    }
    return out;
  }
  async function resolveUser(actor, userRef) {
    return (await directory(actor)).find((x) => x.userRef === userRef) || null;
  }
  async function conversations(actor, userId) {
    const rows =
      (
        await db
          .ref('conversations')
          .orderByChild('userId')
          .equalTo(userId)
          .once('value')
      ).val() || {};
    const g = await assignmentAndGrant(actor, userId);
    if (!g) return [];
    return Object.entries(rows)
      .filter(
        ([id, c]) =>
          c?.userId === userId &&
          c.isPrivate !== true &&
          !c.deletedAt &&
          (g.scope === 'accompaniment_period' ||
            g.conversationIds?.includes(id))
      )
      .map(([id, c]) => ({ ...c, id }));
  }
  const projectMessage = (m) => ({
    role: ['user', 'assistant'].includes(m.role) ? m.role : 'unknown',
    content: typeof m.content === 'string' ? m.content : '',
    timestamp: m.timestamp || null
  });
  return {
    login,
    session,
    revoke,
    journal,
    reference,
    content,
    directory,
    resolveUser,
    conversations,
    projectMessage,
    assignmentAndGrant
  };
}
module.exports = { createProfessionalAccess, ROLES, REASONS, idValid };
