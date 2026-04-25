"use strict";

// ─── debugMeta contract harness — requires a running local server ─────────────
// Verifies that every /chat response includes a well-formed debugMeta object
// with all required fields at the correct types, regardless of the conversational
// path taken (exploration, info, N2 crisis, relational adjustment).
//
// This harness is the living contract for debugMeta. If a field disappears or
// changes type, this harness catches it before it reaches production.

const BASE_URL = process.env.PIPELINE_BASE_URL || process.env.SMOKE_BASE_URL || "http://localhost:3000";

// Unique suffix prevents Firebase state pollution between runs
// (defensive: harness uses isPrivateConversation:true, so no Firebase writes occur)
const RUN_ID = Date.now().toString(36);

function cid(base) {
  return `${base}_${RUN_ID}`;
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  const ct = String(res.headers.get("content-type") || "").toLowerCase();
  let body = null;
  try { body = ct.includes("application/json") ? await res.json() : await res.text(); } catch { body = null; }
  return { status: res.status, contentType: ct, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function buildPayload({ conversationId, message, recentHistory = [], memory = "", flags = {} }) {
  return {
    conversationId,
    requestId: `${conversationId}_${Date.now()}`,
    userId: "u_debugmeta_harness",
    isPrivateConversation: true,
    message,
    recentHistory,
    conversationBranchHistory: [],
    memory,
    flags
  };
}

// ─── Field contract ───────────────────────────────────────────────────────────
// Defines the expected type/shape for each debugMeta field.
// Extend this as the contract evolves.
function assertDebugMetaContract(debugMeta, label) {
  assert(debugMeta && typeof debugMeta === "object", `${label}: debugMeta must be an object`);

  // Required arrays
  assert(Array.isArray(debugMeta.topChips), `${label}: topChips must be an array`);
  assert(Array.isArray(debugMeta.pipelineStages), `${label}: pipelineStages must be an array`);
  assert(Array.isArray(debugMeta.forbidden), `${label}: forbidden must be an array`);

  // Required strings
  assert(typeof debugMeta.memory === "string", `${label}: memory must be a string`);
  assert(typeof debugMeta.conversationStateKey === "string", `${label}: conversationStateKey must be a string`);
  assert(typeof debugMeta.confidenceSignal === "string", `${label}: confidenceSignal must be a string`);

  // conversationStateKey must be a known state
  const VALID_STATES = ["exploration", "post_contact", "contact", "info", "stabilization", "alliance_rupture", "closure"];
  assert(VALID_STATES.includes(debugMeta.conversationStateKey),
    `${label}: conversationStateKey '${debugMeta.conversationStateKey}' is not a valid state`);

  // confidenceSignal must be "high" or "low"
  assert(["high", "low"].includes(debugMeta.confidenceSignal),
    `${label}: confidenceSignal must be 'high' or 'low', got '${debugMeta.confidenceSignal}'`);

  // Required booleans
  assert(typeof debugMeta.interpretationRejection === "boolean", `${label}: interpretationRejection must be boolean`);
  assert(typeof debugMeta.needsSoberReadjustment === "boolean", `${label}: needsSoberReadjustment must be boolean`);
  assert(typeof debugMeta.relationalAdjustmentTriggered === "boolean", `${label}: relationalAdjustmentTriggered must be boolean`);
  assert(typeof debugMeta.criticTriggered === "boolean", `${label}: criticTriggered must be boolean`);
  assert(typeof debugMeta.memoryCompressed === "boolean", `${label}: memoryCompressed must be boolean`);
  assert(typeof debugMeta.closureIntent === "boolean", `${label}: closureIntent must be boolean`);

  // Required numbers
  assert(typeof debugMeta.consecutiveNonExplorationTurns === "number",
    `${label}: consecutiveNonExplorationTurns must be a number`);
  assert(typeof debugMeta.stagnationTurns === "number", `${label}: stagnationTurns must be a number`);
  assert(typeof debugMeta.dependencyRiskScore === "number", `${label}: dependencyRiskScore must be a number`);

  // Nullable strings (must be string or null, not undefined)
  // writerMode and intent are null on deterministic override paths (N2, N1, recall) — non-null in normal generation paths
  const nullableStrings = ["directivityText", "infoSubmode", "contactSubmode", "explorationSubmode",
    "therapeuticAllianceSource", "rewriteSource", "memoryRewriteSource", "soberReadjustmentOriginalReply",
    "dependencyRiskLevel", "externalSupportMode", "processingWindow", "allianceState", "engagementLevel",
    "writerMode", "intent"];
  for (const field of nullableStrings) {
    assert(field in debugMeta,
      `${label}: debugMeta must contain field '${field}' (got undefined)`);
    assert(debugMeta[field] === null || typeof debugMeta[field] === "string",
      `${label}: '${field}' must be string or null, got ${typeof debugMeta[field]}`);
  }

  // pipelineStages entries have expected shape
  for (const entry of debugMeta.pipelineStages) {
    assert(typeof entry.stage === "string", `${label}: pipelineStages[].stage must be a string`);
    assert(typeof entry.deltaMs === "number", `${label}: pipelineStages[].deltaMs must be a number`);
  }

  // traceId must be present (string, non-empty)
  assert(typeof debugMeta.traceId === "string" && debugMeta.traceId.trim().length > 0,
    `${label}: traceId must be a non-empty string`);
}

const cases = [
  {
    name: "debugMeta contract — exploration default",
    payload: buildPayload({
      conversationId: cid("c_dm_exploration"),
      message: "J'ai du mal à avancer sur quelque chose qui me pèse."
    }),
    assert(result) {
      assert(result.status === 200, `exploration: expected 200, got ${result.status}`);
      assertDebugMetaContract(result.body.debugMeta, "exploration");
      const dm = result.body.debugMeta;
      assert(["exploration", "contact", "post_contact"].includes(dm.conversationStateKey),
        `exploration: expected exploration-family state, got '${dm.conversationStateKey}'`);
      assert(typeof dm.writerMode === "string", `exploration: writerMode must be a string in normal generation path`);
      assert(typeof dm.intent === "string", `exploration: intent must be a string in normal generation path`);
    }
  },
  {
    name: "debugMeta contract — info mode",
    payload: buildPayload({
      conversationId: cid("c_dm_info"),
      message: "Dans l'app, je fais quoi en premier si je veux me poser ?"
    }),
    assert(result) {
      assert(result.status === 200, `info: expected 200, got ${result.status}`);
      assertDebugMetaContract(result.body.debugMeta, "info");
      const dm = result.body.debugMeta;
      assert(dm.conversationStateKey === "info", `info: expected 'info', got '${dm.conversationStateKey}'`);
      assert(dm.infoSubmode !== null, `info: infoSubmode should not be null in info mode`);
      assert(typeof dm.writerMode === "string", `info: writerMode must be a string in normal generation path`);
      assert(typeof dm.intent === "string", `info: intent must be a string in normal generation path`);
    }
  },
  {
    name: "debugMeta contract — N2 crisis path",
    payload: buildPayload({
      conversationId: cid("c_dm_n2"),
      message: "Je vais me suicider ce soir."
    }),
    assert(result) {
      assert(result.status === 200, `n2: expected 200, got ${result.status}`);
      assertDebugMetaContract(result.body.debugMeta, "n2");
      const chips = result.body.debugMeta.topChips;
      assert(chips.includes("URGENCE : risque suicidaire"),
        `n2: topChips must include urgence chip, got: ${chips.join(" | ")}`);
    }
  },
  {
    name: "debugMeta contract — relational adjustment",
    payload: buildPayload({
      conversationId: cid("c_dm_relational"),
      message: "Ca ne m'aide pas, tu répètes.",
      recentHistory: [{ role: "assistant", content: "Je sens quelque chose qui se rejoue là." }],
      flags: {}
    }),
    assert(result) {
      assert(result.status === 200, `relational: expected 200, got ${result.status}`);
      assertDebugMetaContract(result.body.debugMeta, "relational");
    }
  }
];

async function run() {
  console.log(`[DEBUGMETA] Base URL: ${BASE_URL}`);
  let passed = 0;

  for (const tc of cases) {
    try {
      const result = await request("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tc.payload)
      });
      tc.assert(result);
      passed++;
      console.log(`[PASS] ${tc.name}`);
    } catch (err) {
      console.error(`[FAIL] ${tc.name}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`[DEBUGMETA] ${passed}/${cases.length} checks passed.`);
}

run().catch(err => {
  console.error(`[ERROR] debugmeta harness crashed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
