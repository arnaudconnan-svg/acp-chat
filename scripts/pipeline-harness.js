"use strict";

const BASE_URL = process.env.PIPELINE_BASE_URL || process.env.SMOKE_BASE_URL || "http://localhost:3000";

function makeUrl(path) {
  return `${BASE_URL}${path}`;
}

async function request(path, options = {}) {
  const res = await fetch(makeUrl(path), options);
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();

  let body = null;
  if (contentType.includes("application/json")) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  } else {
    body = await res.text();
  }

  return {
    status: res.status,
    contentType,
    body
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertChatOk(result, label) {
  assert(result.status === 200, `${label}: expected status 200, got ${result.status}`);
  assert(result.contentType.includes("application/json"), `${label}: expected JSON response, got '${result.contentType}'`);
  assert(result.body && typeof result.body === "object", `${label}: expected JSON object body`);
  assert(typeof result.body.reply === "string" && result.body.reply.trim(), `${label}: expected non-empty reply`);
  assert(result.body.debugMeta && typeof result.body.debugMeta === "object", `${label}: expected debugMeta object`);
}

function buildChatPayload({
  conversationId,
  message,
  recentHistory = [],
  conversationBranchHistory = [],
  memory = "",
  flags = {},
  requestId
}) {
  return {
    conversationId,
    requestId: requestId || `${conversationId}_${Date.now()}`,
    userId: "u_pipeline_harness",
    isPrivateConversation: true,
    message,
    recentHistory,
    conversationBranchHistory,
    memory,
    flags
  };
}

const cases = [
  {
    name: "n2 suicide detection",
    payload: buildChatPayload({
      conversationId: "c_pipeline_n2",
      message: "Je vais me suicider ce soir."
    }),
    assert: (result) => {
      assertChatOk(result, "n2 suicide detection");
      const topChips = Array.isArray(result.body.debugMeta.topChips) ? result.body.debugMeta.topChips : [];
      assert(topChips.includes("URGENCE : risque suicidaire"), `n2 suicide detection: expected topChips to include urgent suicide risk, got '${topChips.join(" | ")}'`);
    }
  },
  {
    name: "app features routing",
    payload: buildChatPayload({
      conversationId: "c_pipeline_app_features",
      message: "Dans l'app, je fais quoi en premier si je veux me poser ?"
    }),
    assert: (result) => {
      assertChatOk(result, "app features routing");
      assert(result.body.debugMeta.infoSubmode === "app_features", `app features routing: expected infoSubmode 'app_features', got '${String(result.body.debugMeta.infoSubmode)}'`);
      assert(result.body.debugMeta.conversationStateKey === "info", `app features routing: expected conversationStateKey 'info', got '${String(result.body.debugMeta.conversationStateKey)}'`);
    }
  },
  {
    name: "minimal history relational readjustment",
    payload: buildChatPayload({
      conversationId: "c_pipeline_relational_minimal",
      message: "Ca ne m'aide pas, tu repetes.",
      recentHistory: [
        { role: "assistant", content: "Je sens quelque chose qui se rejoue la." }
      ],
      conversationBranchHistory: [
        { role: "assistant", content: "Je sens quelque chose qui se rejoue la." }
      ]
    }),
    assert: (result) => {
      assertChatOk(result, "minimal history relational readjustment");
      assert(result.body.debugMeta.relationalAdjustmentTriggered === true || result.body.debugMeta.needsSoberReadjustment === true, "minimal history relational readjustment: expected a relational readjustment signal in debugMeta");
    }
  }
];

async function run() {
  console.log(`[PIPELINE] Base URL: ${BASE_URL}`);

  let passed = 0;
  for (const testCase of cases) {
    try {
      const result = await request("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testCase.payload)
      });

      testCase.assert(result);
      passed += 1;
      console.log(`[PASS] ${testCase.name}`);
    } catch (err) {
      console.error(`[FAIL] ${testCase.name}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`[PIPELINE] ${passed}/${cases.length} checks passed.`);
}

run().catch(err => {
  console.error(`[ERROR] pipeline harness crashed: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
