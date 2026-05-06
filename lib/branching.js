"use strict";

const { normalizeSessionFlags } = require("./flags");

function mapStoredMessageEntry(entry) {
  const item = entry && typeof entry.item === "object" ? entry.item : {};
  return {
    id: String(entry?.id || "").trim(),
    role: String(item.role || ""),
    content: String(item.content || ""),
    debug: Array.isArray(item.debug) ? item.debug : [],
    debugMeta: item.debugMeta && typeof item.debugMeta === "object" ? item.debugMeta : null,
    stateSnapshot: item.stateSnapshot && typeof item.stateSnapshot === "object" ? {
      memory: typeof item.stateSnapshot.memory === "string" ? item.stateSnapshot.memory : "",
      flags: normalizeSessionFlags(item.stateSnapshot.flags || {})
    } : null,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : null
  };
}

function mapRequestedSeedMessage(item) {
  return {
    id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : null,
    role: String(item?.role || ""),
    content: String(item?.content || ""),
    debug: Array.isArray(item?.debug) ? item.debug : [],
    debugMeta: item?.debugMeta && typeof item.debugMeta === "object" ? item.debugMeta : null,
    stateSnapshot: item?.stateSnapshot && typeof item.stateSnapshot === "object" ? {
      memory: typeof item.stateSnapshot.memory === "string" ? item.stateSnapshot.memory : "",
      flags: normalizeSessionFlags(item.stateSnapshot.flags || {})
    } : null,
    createdAt: typeof item?.createdAt === "string" ? item.createdAt : null
  };
}

function normalizeRequestedSeedMessages(requestedSeedMessages = []) {
  return (Array.isArray(requestedSeedMessages) ? requestedSeedMessages : [])
    .map(mapRequestedSeedMessage)
    .filter((item) => item.role && item.content);
}

function resolveBranchSeedPayload({
  messageEntries = [],
  anchorMessageId = "",
  requestedSeedMessages = []
}) {
  const resolvedAnchorInput = String(anchorMessageId || "").trim();
  const normalizedRequestedSeed = normalizeRequestedSeedMessages(requestedSeedMessages);

  if (resolvedAnchorInput) {
    const anchorIndex = messageEntries.findIndex((entry) => String(entry?.id || "") === resolvedAnchorInput);

    if (anchorIndex >= 0) {
      const seededMessages = messageEntries.slice(0, anchorIndex + 1).map(mapStoredMessageEntry);
      return {
        seededMessages,
        resolvedAnchorMessageId: resolvedAnchorInput,
        anchorMatched: true,
        usedSeedFallback: false,
        error: null
      };
    }

    if (normalizedRequestedSeed.length === 0) {
      return {
        seededMessages: [],
        resolvedAnchorMessageId: resolvedAnchorInput,
        anchorMatched: false,
        usedSeedFallback: false,
        error: "anchor_not_found"
      };
    }

    const fallbackAnchor = String(
      [...normalizedRequestedSeed]
        .reverse()
        .find((item) => typeof item?.id === "string" && item.id.trim())?.id || resolvedAnchorInput
    ).trim();

    return {
      seededMessages: normalizedRequestedSeed,
      resolvedAnchorMessageId: fallbackAnchor,
      anchorMatched: false,
      usedSeedFallback: true,
      error: null
    };
  }

  const fallbackAnchor = String(
    [...normalizedRequestedSeed]
      .reverse()
      .find((item) => typeof item?.id === "string" && item.id.trim())?.id || ""
  ).trim();

  return {
    seededMessages: normalizedRequestedSeed,
    resolvedAnchorMessageId: fallbackAnchor,
    anchorMatched: false,
    usedSeedFallback: false,
    error: null
  };
}

module.exports = {
  resolveBranchSeedPayload
};
