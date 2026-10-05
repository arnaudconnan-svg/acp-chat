'use strict';

const crypto = require('crypto');

// The legacy RTDB layout puts parents and children in separate root collections.
// A read followed by a multi-location update is NOT conditional. Until that
// layout is migrated, their common transaction boundary is the database root.
// Callbacks below are pure: no provider, logging, clock or random generation.
const protectedCollections = new Set([
  'users',
  'conversations',
  'messages',
  'branches',
  'branchSeeds',
  'contentGrants',
  'practitionerAssignments',
  'userLabels'
]);
const clone = (value) => (value == null ? null : structuredClone(value));
const digest = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');
const failure = (code) => Object.assign(new Error(code), { code });
const pathParts = (path) => String(path).split('/').filter(Boolean);
function get(root, path) {
  return pathParts(path).reduce((value, key) => value?.[key], root) ?? null;
}
function put(root, path, value) {
  const parts = pathParts(path);
  if (
    !parts.length ||
    parts.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))
  )
    throw failure('lifecycle_invalid_path');
  let node = root;
  for (const key of parts.slice(0, -1)) node = node[key] ||= {};
  if (value == null) delete node[parts.at(-1)];
  else node[parts.at(-1)] = clone(value);
}
function retired(root, kind, id) {
  return !!root.lifecycleFences?.[kind]?.[digest(String(id))];
}
function requireUser(root, id) {
  if (!id || retired(root, 'users', id) || !root.users?.[id])
    throw failure('lifecycle_user_retired');
}
function requireConversation(root, id, userId) {
  requireUser(root, userId);
  const conversation = root.conversations?.[id];
  if (
    !conversation ||
    conversation.userId !== userId ||
    conversation.deletedAt ||
    conversation.isPrivate === true ||
    retired(root, 'conversations', id)
  )
    throw failure('lifecycle_conversation_retired');
  return conversation;
}
function validateRecord(before, after, collection, id) {
  const record = after[collection]?.[id];
  if (record == null) return;
  const previous = before[collection]?.[id];
  if (collection === 'users') {
    if (retired(before, 'users', id)) throw failure('lifecycle_user_retired');
    return;
  }
  if (collection === 'contentGrants' || collection === 'userLabels') {
    requireUser(after, id);
    return;
  }
  if (collection === 'practitionerAssignments') {
    for (const userId of Object.keys(record)) requireUser(after, userId);
    return;
  }
  requireUser(after, record.userId);
  if (previous?.userId && previous.userId !== record.userId)
    throw failure('lifecycle_owner_changed');
  if (collection === 'conversations') {
    if (retired(before, 'conversations', id) || previous?.deletedAt)
      throw failure('lifecycle_conversation_retired');
    if (record.feedbackSnapshot !== true)
      for (const source of [
        record.sourceConversationId,
        record.adminReplaySourceConversationId
      ])
        if (source) requireConversation(after, source, record.userId);
  } else if (collection === 'messages') {
    requireConversation(after, record.conversationId, record.userId);
    if (previous && previous.conversationId !== record.conversationId)
      throw failure('lifecycle_parent_changed');
    if (
      !['user', 'assistant'].includes(record.role) ||
      typeof record.content !== 'string'
    )
      throw failure('lifecycle_message_missing');
  } else if (collection === 'branches' || collection === 'branchSeeds') {
    requireConversation(after, record.sourceConversationId, record.userId);
    if (
      record.branchConversationId &&
      after.conversations?.[record.branchConversationId]
    )
      requireConversation(after, record.branchConversationId, record.userId);
  }
}

function createDataLifecycle(raw) {
  async function atomic(change) {
    let result, rejected;
    // Warm the local SDK cache; callback still handles an empty initial cache.
    await raw.ref().once('value');
    const transaction = await raw.ref().transaction(
      (current) => {
        result = undefined;
        rejected = null;
        const before = current || {};
        const next = clone(before);
        try {
          result = change(next, before);
          // Copy replacement must observe every destination mutation, including
          // legacy guarded writers and late transcript children, not only copies.
          const touched = new Set();
          for (const id of new Set([
            ...Object.keys(before.conversations || {}),
            ...Object.keys(next.conversations || {})
          ]))
            if (
              JSON.stringify(before.conversations?.[id]) !==
              JSON.stringify(next.conversations?.[id])
            )
              touched.add(id);
          for (const id of new Set([
            ...Object.keys(before.messages || {}),
            ...Object.keys(next.messages || {})
          ]))
            if (
              JSON.stringify(before.messages?.[id]) !==
              JSON.stringify(next.messages?.[id])
            ) {
              if (before.messages?.[id]?.conversationId)
                touched.add(before.messages[id].conversationId);
              if (next.messages?.[id]?.conversationId)
                touched.add(next.messages[id].conversationId);
            }
          for (const id of touched)
            if (next.conversations?.[id])
              next.conversations[id].m2CopyVersion =
                revision(before.conversations?.[id], 'm2CopyVersion') + 1;
          if (result?.conversation && result.destinationId)
            result.conversation.m2CopyVersion =
              next.conversations[result.destinationId].m2CopyVersion;
        } catch (error) {
          rejected = error;
          return current ?? null;
        }
        return next;
      },
      undefined,
      false
    );
    if (rejected) throw rejected;
    if (!transaction.committed) throw failure('lifecycle_commit_uncertain');
    return result;
  }

  async function mutate(path, transform) {
    return atomic((next, before) => {
      const old = clone(get(before, path));
      const value = transform(old);
      if (value === undefined) return { committed: false, value: old };
      put(next, path, value);
      const [collection, id] = pathParts(path);
      for (const key of id ? [id] : Object.keys(next[collection] || {}))
        if (
          id ||
          JSON.stringify(before[collection]?.[key]) !==
            JSON.stringify(next[collection]?.[key])
        )
          validateRecord(before, next, collection, key);
      return { committed: true, value: clone(get(next, path)) };
    });
  }

  function ref(path = '', native = raw.ref(path)) {
    if (!pathParts(path).length)
      return new Proxy(native, {
        get(target, name) {
          if (name === 'child') return (key) => ref(key);
          if (['set', 'update', 'remove', 'transaction', 'push'].includes(name))
            return () =>
              Promise.reject(failure('lifecycle_unscoped_write_refused'));
          if (name === 'root' || name === 'ref') return ref();
          const value = Reflect.get(target, name, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    const guarded = protectedCollections.has(pathParts(path)[0]);
    if (!guarded) return native;
    const wrapped = new Proxy(native, {
      get(target, name) {
        if (name === 'then') return undefined;
        if (name === 'ref') return ref(path);
        if (name === 'root') return ref();
        if (name === 'parent')
          return ref(pathParts(path).slice(0, -1).join('/'));
        if (name === 'child') return (key) => ref(`${path}/${key}`);
        if (
          [
            'orderByChild',
            'orderByKey',
            'orderByValue',
            'equalTo',
            'startAt',
            'endAt',
            'limitToFirst',
            'limitToLast'
          ].includes(name)
        )
          return (...args) => ref(path, native[name](...args));
        if (name === 'once' || name === 'get')
          return async (...args) => {
            const snapshot = await native[name](...args);
            function wrapSnapshot(item, at) {
              return new Proxy(item, {
                get(object, property) {
                  if (property === 'ref') return ref(at);
                  if (property === 'child')
                    return (key) =>
                      wrapSnapshot(item.child(key), `${at}/${key}`);
                  if (property === 'forEach')
                    return (callback) =>
                      item.forEach((child) =>
                        callback(wrapSnapshot(child, `${at}/${child.key}`))
                      );
                  const value = Reflect.get(object, property, object);
                  return typeof value === 'function'
                    ? value.bind(object)
                    : value;
                }
              });
            }
            return wrapSnapshot(snapshot, path);
          };
        if (name === 'push')
          return (value) => {
            const child = ref(`${path}/${native.push().key}`);
            if (value === undefined) return child;
            const promise = child.set(value).then(() => child);
            promise.key = child.key;
            return promise;
          };
        if (name === 'set')
          return (value) => mutate(path, () => value).then(() => undefined);
        if (name === 'remove')
          return () => mutate(path, () => null).then(() => undefined);
        if (name === 'update')
          return (patch) =>
            mutate(path, (old) => {
              const value = old || {};
              for (const [key, item] of Object.entries(patch))
                put(value, key, item);
              return value;
            }).then(() => undefined);
        if (name === 'transaction')
          return async (callback) => {
            const outcome = await mutate(path, callback);
            return {
              committed: outcome.committed,
              snapshot: {
                val: () => clone(outcome.value),
                exists: () => outcome.value != null
              }
            };
          };
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    return wrapped;
  }

  function retireConversations(next, userId, initialIds) {
    const ids = new Set(initialIds);
    // Follow only this owner's known derived copies; never adopt an ambiguous
    // historical child. Voluntary feedback snapshots have their own contract.
    let changed;
    do {
      changed = false;
      for (const [id, conversation] of Object.entries(
        next.conversations || {}
      )) {
        if (
          conversation.userId === userId &&
          conversation.feedbackSnapshot !== true &&
          (ids.has(conversation.sourceConversationId) ||
            ids.has(conversation.adminReplaySourceConversationId)) &&
          !ids.has(id)
        ) {
          ids.add(id);
          changed = true;
        }
      }
      for (const branch of Object.values(next.branches || {})) {
        if (
          branch.userId === userId &&
          ids.has(branch.sourceConversationId) &&
          branch.branchConversationId &&
          !ids.has(branch.branchConversationId)
        ) {
          const destination = next.conversations?.[branch.branchConversationId];
          if (!destination || destination.userId === userId) {
            ids.add(branch.branchConversationId);
            changed = true;
          }
        }
      }
    } while (changed);
    for (const id of ids) {
      put(next, `lifecycleFences/conversations/${digest(id)}`, true);
      put(next, `conversations/${id}`, null);
    }
    for (const [id, message] of Object.entries(next.messages || {}))
      if (message.userId === userId && ids.has(message.conversationId))
        put(next, `messages/${id}`, null);
    for (const collection of ['branches', 'branchSeeds'])
      for (const [id, record] of Object.entries(next[collection] || {}))
        if (
          record.userId === userId &&
          (ids.has(record.sourceConversationId) ||
            ids.has(record.branchConversationId))
        )
          put(next, `${collection}/${id}`, null);
    for (const grant of Object.values(next.contentGrants?.[userId] || {}))
      if (Array.isArray(grant.conversationIds)) {
        grant.conversationIds = grant.conversationIds.filter(
          (id) => !ids.has(id)
        );
        if (
          grant.scope === 'conversation_specific' &&
          !grant.conversationIds.length
        )
          grant.active = false;
      }
    for (const [key, receipt] of Object.entries(next.copyReceipts || {}))
      if (
        receipt.userId === userId &&
        (ids.has(receipt.sourceConversationId) ||
          ids.has(receipt.destinationId) ||
          receipt.destinationIds?.some((id) => ids.has(id)))
      )
        put(next, `copyReceipts/${key}`, null);
    return [...ids];
  }

  async function removeConversation(userId, conversationId) {
    return atomic((next) => {
      requireConversation(next, conversationId, userId);
      return retireConversations(next, userId, [conversationId]);
    });
  }
  async function removeAccount(userId, replacement = null) {
    return atomic((next) => {
      requireUser(next, userId);
      const ids = Object.entries(next.conversations || {})
        .filter(([, value]) => value.userId === userId)
        .map(([id]) => id);
      retireConversations(next, userId, ids);
      for (const collection of [
        'messages',
        'branches',
        'branchSeeds',
        'copyReceipts'
      ])
        for (const [id, record] of Object.entries(next[collection] || {}))
          if (record.userId === userId) put(next, `${collection}/${id}`, null);
      for (const collection of ['users', 'userLabels', 'contentGrants'])
        put(next, `${collection}/${userId}`, null);
      for (const id of Object.keys(next.practitionerAssignments || {}))
        put(next, `practitionerAssignments/${id}/${userId}`, null);
      put(next, `lifecycleFences/users/${digest(userId)}`, true);
      if (replacement) {
        if (
          next.users?.[replacement.id] ||
          retired(next, 'users', replacement.id)
        )
          throw failure('lifecycle_identity_collision');
        put(next, `users/${replacement.id}`, replacement.record);
      }
      return ids;
    });
  }
  async function available(userId, conversationId = null) {
    const user = (await raw.ref(`users/${userId}`).once('value')).val();
    if (!user) return false;
    if (!conversationId) return true;
    const c = (
      await raw.ref(`conversations/${conversationId}`).once('value')
    ).val();
    return !!c && c.userId === userId && !c.deletedAt && c.isPrivate !== true;
  }
  function revision(record, key) {
    const value = record?.[key] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0)
      throw failure('lifecycle_revision_invalid');
    return value;
  }
  const requestKey = (userId, conversationId, requestId) =>
    digest(JSON.stringify([userId, conversationId, requestId]));
  function assertTicket(conversation, ticket) {
    if (
      revision(conversation, 'm2ContentGeneration') !== (ticket.generation ?? 0)
    )
      throw failure('conversation_replaced');
    if (
      ticket.request &&
      (!conversation.m2Requests?.[ticket.request] ||
        conversation.m2Requests[ticket.request].canceled)
    )
      throw failure('chat_request_canceled');
  }
  async function assertTurnAvailable(userId, conversationId, ticket) {
    const c = (
      await raw.ref(`conversations/${conversationId}`).once('value')
    ).val();
    if (!c || c.userId !== userId || c.deletedAt || c.isPrivate === true)
      throw failure('lifecycle_conversation_retired');
    assertTicket(c, ticket);
  }
  async function beginTurn(userId, conversationId, requestId = null) {
    return atomic((next) => {
      const c = requireConversation(next, conversationId, userId);
      const request = requestId
        ? requestKey(userId, conversationId, requestId)
        : null;
      if (request && c.m2Requests?.[request])
        throw failure('chat_request_conflict');
      c.m2TurnVersion = revision(c, 'm2TurnVersion') + 1;
      if (request) {
        c.m2Requests ||= {};
        c.m2Requests[request] = {
          generation: revision(c, 'm2ContentGeneration'),
          canceled: false
        };
      }
      return {
        turn: c.m2TurnVersion,
        generation: revision(c, 'm2ContentGeneration'),
        request,
        messageId: request ? 'm_chat_' + request : null,
        memory: revision(next.users[userId], 'm2MemoryRevision')
      };
    });
  }
  async function commitTurn(
    userId,
    conversationId,
    ticket,
    patch,
    { memory = false, message = null } = {}
  ) {
    return atomic((next) => {
      const c = requireConversation(next, conversationId, userId);
      assertTicket(c, ticket);
      const latestTurn = revision(c, 'm2TurnVersion') === ticket.turn;
      if (
        (!latestTurn && !message) ||
        (memory &&
          revision(next.users[userId], 'm2MemoryRevision') !== ticket.memory)
      )
        throw failure('memory_superseded');
      // A response already delivered remains a legitimate transcript child.
      // Only its now-stale effects on current flags/memory are discarded.
      if (latestTurn) Object.assign(c, clone(patch));
      if (message) {
        put(next, `messages/${message.id}`, message.record);
        validateRecord(next, next, 'messages', message.id);
      }
    });
  }
  async function cancelTurn(userId, conversationId, requestId) {
    return atomic((next) => {
      const c = requireConversation(next, conversationId, userId);
      const request =
        c.m2Requests?.[requestKey(userId, conversationId, requestId)];
      if (!request || request.generation !== revision(c, 'm2ContentGeneration'))
        return false;
      request.canceled = true;
      return true;
    });
  }
  async function interruptTurn(userId, conversationId, requestId, record) {
    return atomic((next) => {
      const c = requireConversation(next, conversationId, userId);
      const key = requestKey(userId, conversationId, requestId),
        request = c.m2Requests?.[key];
      if (!request || request.generation !== revision(c, 'm2ContentGeneration'))
        throw failure('chat_request_conflict');
      const id = 'm_chat_' + key,
        previous = next.messages?.[id];
      // A completed response wins over a later partial report. Otherwise the
      // explicit interruption freezes the partial transcript and cancels the old
      // writer/memory commit, including callbacks replayed by Firebase.
      request.canceled = true;
      if (!previous) {
        put(next, `messages/${id}`, {
          ...clone(record),
          userId,
          conversationId,
          streamInterrupted: true
        });
        validateRecord(next, next, 'messages', id);
      }
      return {
        messageId: id,
        streamInterrupted: previous
          ? previous.streamInterrupted === true
          : true,
        responseSaveStatus: 'confirmed'
      };
    });
  }
  async function commitMemory(
    userId,
    expected,
    patch,
    { advance = true, conversationId = null, generation = null } = {}
  ) {
    return atomic((next) => {
      requireUser(next, userId);
      if (conversationId) {
        const c = requireConversation(next, conversationId, userId);
        if (
          generation !== null &&
          revision(c, 'm2ContentGeneration') !== generation
        )
          throw failure('conversation_replaced');
      }
      const user = next.users[userId];
      if (
        revision(user, 'm2MemoryRevision') !==
        revision(expected, 'm2MemoryRevision')
      )
        throw failure('memory_superseded');
      Object.assign(user, clone(patch));
      if (advance)
        user.m2MemoryRevision = revision(user, 'm2MemoryRevision') + 1;
    });
  }
  return {
    db: { ref },
    atomic,
    removeConversation,
    removeAccount,
    available,
    beginTurn,
    cancelTurn,
    interruptTurn,
    assertTurnAvailable,
    commitTurn,
    commitMemory,
    revision
  };
}

module.exports = {
  createDataLifecycle,
  requireUser,
  requireConversation,
  retired,
  put
};
