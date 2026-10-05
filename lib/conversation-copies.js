'use strict';

const crypto = require('crypto');
const { idValid } = require('./professional-access');
const {
  requireUser,
  requireConversation,
  retired,
  put
} = require('./data-lifecycle');
const clone = (x) => (x == null ? null : structuredClone(x));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])])
    );
  return value;
}
const hash = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
function fail(code, status = 409) {
  throw Object.assign(new Error(code), { code, status });
}
function validId(id) {
  if (!idValid(id)) fail('copy_invalid_reference', 400);
  return id;
}
function assertDestination(root, userId, id) {
  validId(id);
  if (retired(root, 'conversations', id)) fail('copy_destination_retired', 410);
  if (
    root.conversations?.[id] ||
    Object.values(root.messages || {}).some((m) => m.conversationId === id)
  )
    fail('copy_destination_exists');
  requireUser(root, userId);
}
function messageOwned(m, userId, sourceId) {
  return (
    m &&
    m.userId === userId &&
    m.conversationId === sourceId &&
    !m.deletedAt &&
    m.isPrivate !== true
  );
}
function seedFromSource(root, userId, sourceId, anchorId, requested = null) {
  const entries = Object.entries(root.messages || {})
    .filter(([, m]) => messageOwned(m, userId, sourceId))
    .sort(
      ([a, x], [b, y]) =>
        (Number(x.timestamp) || Date.parse(x.createdAt) || 0) -
          (Number(y.timestamp) || Date.parse(y.createdAt) || 0) ||
        a.localeCompare(b)
    );
  if (
    requested?.some(
      (m) =>
        (m.userId && m.userId !== userId) ||
        (m.conversationId && m.conversationId !== sourceId)
    )
  )
    fail('copy_seed_owner_mismatch', 403);
  let index = entries.findIndex(([id]) => id === anchorId);
  // Local technical IDs can be reconciled only with one canonical owned child.
  // A client transcript is never accepted as proof of historical provenance.
  if (index < 0 && Array.isArray(requested)) {
    const anchor = requested.find((m) => m.id === anchorId);
    const matches = anchor
      ? entries
          .map(([id, m], i) => ({ id, m, i }))
          .filter(
            ({ m }) => m.role === anchor.role && m.content === anchor.content
          )
      : [];
    if (matches.length === 1) index = matches[0].i;
  }
  if (index < 0) fail('copy_anchor_unavailable', 404);
  return entries
    .slice(0, index + 1)
    .map(([id, m]) => ({
      id,
      userId,
      conversationId: sourceId,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || null,
      debug: clone(m.debug || []),
      debugMeta: clone(m.debugMeta),
      stateSnapshot: clone(m.stateSnapshot)
    }));
}
function putMessages(root, destinationId, userId, rows, namespace, now) {
  return rows.map((row, index) => {
    const id = 'm_copy_' + hash([namespace, index]).slice(0, 40);
    if (root.messages?.[id]) fail('copy_message_collision');
    put(root, `messages/${id}`, {
      ...clone(row),
      id: undefined,
      userId,
      conversationId: destinationId,
      sourceMessageId: row.id || row.sourceMessageId || null,
      timestamp: Number(row.timestamp || row.t) || now + index
    });
    // RTDB does not accept undefined; the canonical key is never copied as data.
    delete root.messages[id].id;
    return id;
  });
}
function createConversationCopies({ lifecycle, now = Date.now }) {
  async function operation(
    { kind, userId, sourceId = null, operationId, payload },
    build
  ) {
    validId(userId);
    if (sourceId) validId(sourceId);
    const requestHash = hash(payload);
    const token = operationId || requestHash; // deterministic compatibility for older clients
    validId(token);
    const key = hash([kind, userId, token]);
    const timestamp = now();
    return lifecycle.atomic((root) => {
      requireUser(root, userId);
      if (sourceId) requireConversation(root, sourceId, userId);
      const receipt = root.copyReceipts?.[key];
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          fail('copy_operation_conflict');
        const c = requireConversation(root, receipt.destinationId, userId);
        return {
          ...clone(receipt),
          replayed: true,
          conversation: clone(c),
          branch: clone(root.branches?.[receipt.branchId])
        };
      }
      const output = build(root, key, timestamp);
      const record = {
        kind,
        userId,
        sourceConversationId: sourceId,
        requestHash,
        destinationId: output.destinationId,
        branchId: output.branchId || null,
        messageIds: output.messageIds || [],
        createdAt: new Date(timestamp).toISOString()
      };
      put(root, `copyReceipts/${key}`, record);
      return {
        ...record,
        replayed: false,
        conversation: clone(root.conversations?.[output.destinationId]),
        branch: clone(root.branches?.[output.branchId])
      };
    });
  }
  async function branch({
    userId,
    sourceId,
    anchorId,
    requested,
    memory = '',
    flags = {},
    memoryState = null,
    operationId,
    activate = false
  }) {
    validId(anchorId);
    return operation(
      {
        kind: activate ? 'branch_create_activate' : 'branch_create',
        userId,
        sourceId,
        operationId,
        payload: { sourceId, anchorId, requested, memory, flags, memoryState }
      },
      (root, key, timestamp) => {
        const source = requireConversation(root, sourceId, userId);
        const messages = seedFromSource(
          root,
          userId,
          sourceId,
          anchorId,
          requested
        );
        const branchId = 'b_' + key.slice(0, 40),
          destinationId = 'c_branch_' + key.slice(0, 40);
        assertDestination(root, userId, destinationId);
        if (root.branches?.[branchId] || root.branchSeeds?.[branchId])
          fail('copy_branch_collision');
        const date = new Date(timestamp).toISOString(),
          canonicalAnchor = messages.at(-1).id;
        const record = {
          userId,
          sourceConversationId: sourceId,
          sourceAnchorMessageId: canonicalAnchor,
          branchConversationId: destinationId,
          seedMessageCount: messages.length,
          status: activate ? 'active' : 'prepared',
          createdAt: date,
          updatedAt: date
        };
        if (activate) record.activatedAt = date;
        put(root, `branches/${branchId}`, record);
        put(root, `branchSeeds/${branchId}`, {
          userId,
          sourceConversationId: sourceId,
          sourceAnchorMessageId: canonicalAnchor,
          seededAt: date,
          messages
        });
        // A prepared branch has a real destination, so removal and retries share
        // the same authority boundary even before its first activation.
        put(root, `conversations/${destinationId}`, {
          userId,
          isBranch: true,
          sourceConversationId: sourceId,
          title: source.title || 'Branche',
          titleLocked: false,
          memory,
          memoryState,
          flags,
          messageCount: activate
            ? messages.filter((m) => m.role === 'user').length
            : 0,
          lastUserMessage: activate
            ? messages.filter((m) => m.role === 'user').at(-1)?.content || ''
            : '',
          createdAt: date,
          updatedAt: date,
          m2CopyVersion: 1,
          m2TurnVersion: 0,
          copyProvenance: 'owned_source_prefix'
        });
        const messageIds = activate
          ? putMessages(root, destinationId, userId, messages, key, timestamp)
          : [];
        return { destinationId, branchId, messageIds };
      }
    );
  }
  async function activate({ userId, branchId, memory, flags, memoryState }) {
    validId(branchId);
    const timestamp = now();
    return lifecycle.atomic((root) => {
      requireUser(root, userId);
      const b = root.branches?.[branchId],
        seed = root.branchSeeds?.[branchId];
      if (!b || b.userId !== userId) fail('copy_branch_owner_mismatch', 403);
      const source = requireConversation(root, b.sourceConversationId, userId);
      if (
        !seed ||
        seed.userId !== userId ||
        seed.sourceConversationId !== b.sourceConversationId ||
        !Array.isArray(seed.messages)
      )
        fail('copy_seed_unavailable', 409);
      // Validate the historical anchor and each child before any effect.
      const canonical = seedFromSource(
        root,
        userId,
        b.sourceConversationId,
        b.sourceAnchorMessageId
      );
      if (
        seed.messages.some(
          (m) =>
            !canonical.some(
              (x) =>
                x.id === m.id && x.role === m.role && x.content === m.content
            )
        )
      )
        fail('copy_seed_changed');
      let c = root.conversations?.[b.branchConversationId];
      if (c) requireConversation(root, b.branchConversationId, userId);
      else {
        assertDestination(root, userId, b.branchConversationId);
        c = {
          userId,
          sourceConversationId: b.sourceConversationId,
          isBranch: true,
          title: source.title || 'Branche',
          createdAt: b.createdAt,
          m2TurnVersion: 0
        };
        put(root, `conversations/${b.branchConversationId}`, c);
        c = root.conversations[b.branchConversationId];
      }
      if (b.activatedAt)
        return { branch: clone(b), conversation: clone(c), replayed: true };
      if (
        Object.values(root.messages || {}).some(
          (m) => m.conversationId === b.branchConversationId
        )
      )
        fail('copy_partial_destination');
      putMessages(
        root,
        b.branchConversationId,
        userId,
        canonical,
        ['activate', branchId],
        timestamp
      );
      Object.assign(c, {
        memory: memory ?? c.memory ?? '',
        flags: flags ?? c.flags ?? {},
        memoryState: memoryState ?? c.memoryState ?? null,
        messageCount: canonical.filter((m) => m.role === 'user').length,
        lastUserMessage:
          canonical.filter((m) => m.role === 'user').at(-1)?.content || '',
        updatedAt: new Date(timestamp).toISOString()
      });
      c.m2TurnVersion = lifecycle.revision(c, 'm2TurnVersion') + 1;
      b.status = 'active';
      b.activatedAt = c.updatedAt;
      b.updatedAt = c.updatedAt;
      return { branch: clone(b), conversation: clone(c), replayed: false };
    });
  }
  async function replay({
    userId,
    sourceId,
    destinationId,
    anchorId,
    operationId,
    intent,
    expectedVersion,
    record,
    messages
  }) {
    validId(destinationId);
    validId(anchorId);
    if (!['create', 'replace'].includes(intent))
      fail('copy_intent_required', 400);
    if (sourceId === destinationId) fail('copy_source_destination_same', 400);
    return operation(
      {
        kind: 'admin_replay',
        userId,
        sourceId,
        operationId,
        payload: {
          sourceId,
          destinationId,
          anchorId,
          intent,
          expectedVersion,
          record,
          messages
        }
      },
      (root, key, timestamp) => {
        seedFromSource(root, userId, sourceId, anchorId);
        const existing = root.conversations?.[destinationId];
        if (intent === 'create') assertDestination(root, userId, destinationId);
        else {
          requireConversation(root, destinationId, userId);
          if (
            !Number.isSafeInteger(expectedVersion) ||
            expectedVersion < 0 ||
            lifecycle.revision(existing, 'm2CopyVersion') !== expectedVersion
          )
            fail('copy_version_conflict');
          for (const m of Object.values(root.messages || {}))
            if (
              m.conversationId === destinationId &&
              !messageOwned(m, userId, destinationId)
            )
              fail('copy_ambiguous_child', 403);
        }
        for (const [id, m] of Object.entries(root.messages || {}))
          if (m.conversationId === destinationId)
            put(root, `messages/${id}`, null);
        const date = new Date(timestamp).toISOString();
        put(root, `conversations/${destinationId}`, {
          ...clone(existing || {}),
          ...clone(record),
          userId,
          adminReplaySourceConversationId: sourceId,
          adminReplayAnchorMessageId: anchorId,
          copyProvenance: 'admin_supplied_reconstruction',
          createdAt: existing?.createdAt || date,
          updatedAt: date,
          m2CopyVersion: lifecycle.revision(existing, 'm2CopyVersion') + 1,
          m2TurnVersion: lifecycle.revision(existing, 'm2TurnVersion') + 1
        });
        const messageIds = putMessages(
          root,
          destinationId,
          userId,
          messages,
          key,
          timestamp
        );
        return { destinationId, messageIds };
      }
    );
  }
  async function feedback({ userId, operationId, record, messages, payload }) {
    return operation(
      { kind: 'feedback_snapshot', userId, operationId, payload },
      (root, key, timestamp) => {
        const destinationId = 'c_fbsnap_' + key.slice(0, 40);
        assertDestination(root, userId, destinationId);
        const date = new Date(timestamp).toISOString();
        put(root, `conversations/${destinationId}`, {
          ...clone(record),
          userId,
          feedbackSnapshot: true,
          isPrivate: false,
          createdAt: date,
          updatedAt: date
        });
        const messageIds = putMessages(
          root,
          destinationId,
          userId,
          messages,
          key,
          timestamp
        );
        return { destinationId, messageIds };
      }
    );
  }
  async function importLocal({
    userId,
    jobs,
    forceOverwrite,
    operationId,
    payload
  }) {
    const requestHash = hash(payload),
      key = hash(['import_local', userId, operationId || requestHash]);
    if (operationId !== undefined) validId(operationId);
    const timestamp = now();
    return lifecycle.atomic((root) => {
      requireUser(root, userId);
      const previous = root.copyReceipts?.[key];
      if (previous) {
        if (previous.requestHash !== requestHash)
          fail('copy_operation_conflict');
        for (const id of previous.destinationIds)
          requireConversation(root, id, userId);
        return { ...clone(previous.result), replayed: true };
      }
      const result = {
        importedConversationIds: [],
        importedCount: 0,
        alreadyOwnedCount: 0,
        skippedCount: 0,
        messageIdsByConversation: {}
      };
      // Complete validation and all writes share one root commit. An exception
      // discards every staged mutation, including earlier jobs in this batch.
      for (const job of jobs) {
        validId(job.id);
        const existing = root.conversations?.[job.id];
        const children = Object.entries(root.messages || {}).filter(
          ([, m]) => m.conversationId === job.id
        );
        if (existing) requireConversation(root, job.id, userId);
        else assertDestination(root, userId, job.id);
        if (children.some(([, m]) => !messageOwned(m, userId, job.id)))
          fail('copy_ambiguous_child', 403);
        if (existing && !forceOverwrite) {
          result.alreadyOwnedCount++;
          continue;
        }
        if (
          existing &&
          (job.expectedVersion === null ||
            lifecycle.revision(existing, 'm2CopyVersion') !==
              job.expectedVersion)
        )
          fail('copy_version_conflict');
        for (const [id] of children) put(root, `messages/${id}`, null);
        put(root, `conversations/${job.id}`, {
          ...clone(existing || {}),
          ...clone(job.record),
          userId,
          copyProvenance: 'explicit_local_import'
        });
        result.messageIdsByConversation[job.id] = putMessages(
          root,
          job.id,
          userId,
          job.messages,
          [key, job.id],
          timestamp
        );
        result.importedConversationIds.push(job.id);
      }
      result.importedCount = result.importedConversationIds.length;
      put(root, `copyReceipts/${key}`, {
        kind: 'import_local',
        userId,
        requestHash,
        destinationIds: jobs.map((j) => j.id),
        result
      });
      return result;
    });
  }
  return { branch, activate, replay, feedback, importLocal };
}
module.exports = { createConversationCopies, hash };
