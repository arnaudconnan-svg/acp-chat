"use strict";

const { resolveBranchSeedPayload } = require("../lib/branching");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`[FAIL] ${label}: ${err.message}`);
  }
}

const messageEntries = [
  {
    id: "m1",
    item: { role: "user", content: "u1", createdAt: "2026-01-01T00:00:00.000Z" }
  },
  {
    id: "m2",
    item: { role: "assistant", content: "a1", createdAt: "2026-01-01T00:00:01.000Z" }
  },
  {
    id: "m3",
    item: { role: "user", content: "u2", createdAt: "2026-01-01T00:00:02.000Z" }
  }
];

check("anchor found: uses DB slice and no fallback", () => {
  const out = resolveBranchSeedPayload({
    messageEntries,
    anchorMessageId: "m2",
    requestedSeedMessages: []
  });

  assert(out.error === null, `expected null error, got ${out.error}`);
  assert(out.anchorMatched === true, "expected anchorMatched=true");
  assert(out.usedSeedFallback === false, "expected usedSeedFallback=false");
  assert(out.seededMessages.length === 2, `expected 2 seeded messages, got ${out.seededMessages.length}`);
  assert(out.resolvedAnchorMessageId === "m2", `expected m2, got ${out.resolvedAnchorMessageId}`);
});

check("anchor missing + seed provided: uses seed fallback", () => {
  const out = resolveBranchSeedPayload({
    messageEntries,
    anchorMessageId: "m404",
    requestedSeedMessages: [
      { id: "s1", role: "user", content: "hello" },
      { id: "s2", role: "assistant", content: "world" }
    ]
  });

  assert(out.error === null, `expected null error, got ${out.error}`);
  assert(out.anchorMatched === false, "expected anchorMatched=false");
  assert(out.usedSeedFallback === true, "expected usedSeedFallback=true");
  assert(out.seededMessages.length === 2, `expected 2 seeded messages, got ${out.seededMessages.length}`);
  assert(out.resolvedAnchorMessageId === "s2", `expected s2, got ${out.resolvedAnchorMessageId}`);
});

check("anchor missing + empty seed: returns anchor_not_found", () => {
  const out = resolveBranchSeedPayload({
    messageEntries,
    anchorMessageId: "m404",
    requestedSeedMessages: []
  });

  assert(out.error === "anchor_not_found", `expected anchor_not_found, got ${out.error}`);
  assert(out.seededMessages.length === 0, `expected 0 seeded messages, got ${out.seededMessages.length}`);
});

check("no anchor + seed: accepted and anchor inferred from latest seed id", () => {
  const out = resolveBranchSeedPayload({
    messageEntries,
    anchorMessageId: "",
    requestedSeedMessages: [
      { role: "user", content: "hello" },
      { id: "s9", role: "assistant", content: "world" }
    ]
  });

  assert(out.error === null, `expected null error, got ${out.error}`);
  assert(out.usedSeedFallback === false, "expected usedSeedFallback=false");
  assert(out.seededMessages.length === 2, `expected 2 seeded messages, got ${out.seededMessages.length}`);
  assert(out.resolvedAnchorMessageId === "s9", `expected s9, got ${out.resolvedAnchorMessageId}`);
});

check("seed normalization filters invalid entries", () => {
  const out = resolveBranchSeedPayload({
    messageEntries,
    anchorMessageId: "",
    requestedSeedMessages: [
      { role: "user", content: "ok" },
      { role: "", content: "bad" },
      { role: "assistant", content: "" }
    ]
  });

  assert(out.seededMessages.length === 1, `expected 1 seeded message, got ${out.seededMessages.length}`);
});

console.log(`\n[BRANCHING] ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
