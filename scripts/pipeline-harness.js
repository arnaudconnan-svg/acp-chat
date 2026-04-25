"use strict";

const BASE_URL = process.env.PIPELINE_BASE_URL || process.env.SMOKE_BASE_URL || "http://localhost:3000";

// Unique suffix prevents Firebase state pollution between runs
// (defensive: harness uses isPrivateConversation:true, so no Firebase writes occur)
const RUN_ID = Date.now().toString(36);

function cid(base) {
  return `${base}_${RUN_ID}`;
}

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
    name: "missing conversationId → 400",
    payload: buildChatPayload({
      conversationId: "",
      message: "test"
    }),
    assert: (result) => {
      assert(result.status === 400, `expected status 400, got ${result.status}`);
      assert(result.body && typeof result.body === "object", "expected JSON error body");
      assert(typeof result.body.error === "string" && result.body.error.length > 0,
        `expected non-empty error field, got '${result.body.error}'`);
    }
  },
  {
    name: "n2 suicide detection",
    payload: buildChatPayload({
      conversationId: cid("c_pipeline_n2"),
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
      conversationId: cid("c_pipeline_app_features"),
      message: "Dans l'app, je fais quoi en premier si je veux me poser ?"
    }),
    assert: (result) => {
      assertChatOk(result, "app features routing");
      assert(result.body.debugMeta.infoSubmode === "app_features", `app features routing: expected infoSubmode 'app_features', got '${String(result.body.debugMeta.infoSubmode)}'`);
      assert(result.body.debugMeta.conversationStateKey === "info", `app features routing: expected conversationStateKey 'info', got '${String(result.body.debugMeta.conversationStateKey)}'`);
    }
  },
  {
    name: "generic discovery routes app_features with operational intent",
    payload: buildChatPayload({
      conversationId: cid("c_pipeline_app_features_discovery"),
      message: "Comment tu fonctionnes ?"
    }),
    assert: (result) => {
      assertChatOk(result, "generic discovery routes app_features with operational intent");
      const meta = result.body.debugMeta;
      assert(meta.infoSubmode === "app_features", `generic discovery: expected infoSubmode 'app_features', got '${String(meta.infoSubmode)}'`);
      assert(meta.writerMode === "info_app_features", `generic discovery: expected writerMode 'info_app_features', got '${String(meta.writerMode)}'`);
      assert(
        meta.intent === "decrire uniquement les usages et fonctionnalites reellement disponibles",
        `generic discovery: expected operational app_features intent, got '${String(meta.intent)}'`
      );
    }
  },
  {
    name: "psychoeducation intent is mode-specific",
    payload: buildChatPayload({
      conversationId: cid("c_pipeline_intent_psychoeducation"),
      message: "Comment fonctionne ton approche ?"
    }),
    assert: (result) => {
      assertChatOk(result, "psychoeducation intent is mode-specific");
      const meta = result.body.debugMeta;
      assert(meta.infoSubmode === "psychoeducation", `psychoeducation intent: expected infoSubmode 'psychoeducation', got '${String(meta.infoSubmode)}'`);
      assert(meta.writerMode === "info_psychoeducation", `psychoeducation intent: expected writerMode 'info_psychoeducation', got '${String(meta.writerMode)}'`);
      assert(
        meta.intent === "expliquer le positionnement et les mecanismes de l'approche au bon niveau de detail",
        `psychoeducation intent: expected operational psychoeducation intent, got '${String(meta.intent)}'`
      );
    }
  },
  {
    name: "pure info intent is mode-specific",
    payload: buildChatPayload({
      conversationId: cid("c_pipeline_intent_pure"),
      message: "Que se passe-t-il dans le cerveau quand on pleure ?"
    }),
    assert: (result) => {
      assertChatOk(result, "pure info intent is mode-specific");
      const meta = result.body.debugMeta;
      assert(meta.infoSubmode === "pure", `pure info intent: expected infoSubmode 'pure', got '${String(meta.infoSubmode)}'`);
      assert(meta.writerMode === "info_pure", `pure info intent: expected writerMode 'info_pure', got '${String(meta.writerMode)}'`);
      assert(
        meta.intent === "donner une explication descriptive directe sans recentrer sur l'app",
        `pure info intent: expected operational pure intent, got '${String(meta.intent)}'`
      );
    }
  },
  {
    name: "minimal history relational readjustment",
    payload: buildChatPayload({
      conversationId: cid("c_pipeline_relational_minimal"),
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
  },
  {
    name: "debugMeta transition fields present on standard turn",
    payload: buildChatPayload({
      conversationId: cid("c_pipeline_transition_fields"),
      message: "Comment tu vas ?",
      flags: { conversationStateKey: "exploration" }
    }),
    assert: (result) => {
      assertChatOk(result, "debugMeta transition fields present on standard turn");
      const meta = result.body.debugMeta;
      assert(typeof meta.conversationStateKey === "string" && meta.conversationStateKey.length > 0,
        `expected non-empty conversationStateKey, got '${meta.conversationStateKey}'`);
      assert(typeof meta.stateTransitionValid === "boolean",
        `expected stateTransitionValid to be boolean, got '${typeof meta.stateTransitionValid}'`);
      assert(meta.stateTransitionFrom === null || typeof meta.stateTransitionFrom === "string",
        `expected stateTransitionFrom to be null or string, got '${typeof meta.stateTransitionFrom}'`);
    }
  },
  {
    name: "debugMeta transition valid for known good path",
    payload: buildChatPayload({
      conversationId: cid("c_pipeline_transition_valid"),
      message: "Quelque chose me pese la.",
      flags: { conversationStateKey: "exploration" }
    }),
    assert: (result) => {
      assertChatOk(result, "debugMeta transition valid for known good path");
      const meta = result.body.debugMeta;
      assert(meta.stateTransitionValid === true,
        `expected stateTransitionValid=true for exploration->exploration, got '${meta.stateTransitionValid}'`);
    }
  },
  {
    name: "post_contact state after prior contact turn",
    payload: buildChatPayload({
      conversationId: cid("c_pipeline_post_contact"),
      message: "Oui c'est ca, ca me pesait depuis un moment.",
      flags: {
        conversationStateKey: "contact",
        contactState: { wasContact: true }
      }
    }),
    assert: (result) => {
      assertChatOk(result, "post_contact state after prior contact turn");
      const meta = result.body.debugMeta;
      // Non-contact follow-up after a contact turn should land in post_contact or exploration
      assert(
        meta.conversationStateKey === "post_contact" || meta.conversationStateKey === "exploration" || meta.conversationStateKey === "contact",
        `expected post_contact / exploration / contact, got '${meta.conversationStateKey}'`
      );
      assert(meta.stateTransitionValid === true,
        `expected stateTransitionValid=true, got '${meta.stateTransitionValid}'`);
    }
  },
  {
    name: "stabilization — forced by overloaded+withdrawn flags",
    payload: buildChatPayload({
      conversationId: cid("c_pipeline_stabilization"),
      message: "Ca va, ca va.",
      flags: {
        conversationStateKey: "exploration",
        allianceState: "good",
        engagementLevel: "withdrawn",
        stagnationTurns: 0,
        processingWindow: "overloaded"
      }
    }),
    assert: (result) => {
      assertChatOk(result, "stabilization forced by overloaded+withdrawn");
      const meta = result.body.debugMeta;
      assert(meta.conversationStateKey === "stabilization",
        `expected conversationStateKey 'stabilization', got '${meta.conversationStateKey}'`);
      assert(meta.writerMode === "stabilization",
        `expected writerMode 'stabilization', got '${meta.writerMode}'`);
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
