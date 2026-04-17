"use strict";

const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:3000";
const DATASET_PATH = process.env.EVAL_DATASET_PATH || path.join(__dirname, "..", "data", "chat-evals.json");

function makeUrl(routePath) {
  return `${BASE_URL}${routePath}`;
}

function readDataset() {
  const raw = fs.readFileSync(DATASET_PATH, "utf-8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Evaluation dataset must be a JSON array.");
  }

  return parsed;
}

async function requestChat(payload) {
  const response = await fetch(makeUrl("/chat"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text();
  let body = null;

  if (contentType.includes("application/json")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    contentType,
    body,
    text
  };
}

function normalizeCaseFlags(flags) {
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    return {};
  }

  return flags;
}

function buildPayload(testCase, index) {
  return {
    conversationId: `eval-${testCase.id || `case-${index + 1}`}`,
    userId: "eval_runner",
    message: String(testCase.message || ""),
    recentHistory: Array.isArray(testCase.recentHistory) ? testCase.recentHistory : [],
    memory: typeof testCase.memory === "string" ? testCase.memory : "",
    flags: normalizeCaseFlags(testCase.flags),
    debug: true
  };
}

function replyEndsWithQuestion(reply) {
  return /[?]\s*$/.test(String(reply || "").trim());
}

function countParagraphs(reply) {
  return String(reply || "")
    .split(/\n\s*\n/)
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .length;
}

function evaluateExpectations(testCase, result) {
  const expectations = testCase.expect || {};
  const reply = String(result.body?.reply || "");
  const debugMeta = result.body?.debugMeta || {};
  const failures = [];

  if (expectations.status !== undefined && result.status !== expectations.status) {
    failures.push(`expected status ${expectations.status}, got ${result.status}`);
  }

  if (expectations.maxReplyChars !== undefined && reply.length > expectations.maxReplyChars) {
    failures.push(`expected reply length <= ${expectations.maxReplyChars}, got ${reply.length}`);
  }

  if (expectations.maxParagraphs !== undefined && countParagraphs(reply) > expectations.maxParagraphs) {
    failures.push(`expected paragraph count <= ${expectations.maxParagraphs}, got ${countParagraphs(reply)}`);
  }

  if (expectations.noQuestionEnding === true && replyEndsWithQuestion(reply)) {
    failures.push("expected reply not to end with a question");
  }

  if (expectations.needsSoberReadjustment !== undefined && debugMeta.needsSoberReadjustment !== expectations.needsSoberReadjustment) {
    failures.push(
      `expected debugMeta.needsSoberReadjustment=${expectations.needsSoberReadjustment}, got ${String(debugMeta.needsSoberReadjustment)}`
    );
  }

  if (expectations.rewriteSource !== undefined && debugMeta.rewriteSource !== expectations.rewriteSource) {
    failures.push(`expected debugMeta.rewriteSource='${expectations.rewriteSource}', got '${String(debugMeta.rewriteSource)}'`);
  }

  if (expectations.modeChip !== undefined) {
    const chips = Array.isArray(debugMeta.topChips) ? debugMeta.topChips : [];
    if (!chips.includes(expectations.modeChip)) {
      failures.push(`expected topChips to include '${expectations.modeChip}', got [${chips.join(", ")}]`);
    }
  }

  return failures;
}

async function run() {
  const dataset = readDataset();

  console.log(`[EVAL] Base URL: ${BASE_URL}`);
  console.log(`[EVAL] Dataset: ${DATASET_PATH}`);
  console.log(`[EVAL] Cases: ${dataset.length}`);

  let passed = 0;
  let failed = 0;

  for (let index = 0; index < dataset.length; index += 1) {
    const testCase = dataset[index];
    const label = String(testCase.id || `case-${index + 1}`);
    const payload = buildPayload(testCase, index);
    const result = await requestChat(payload);
    const failures = evaluateExpectations(testCase, result);

    if (failures.length > 0) {
      failed += 1;
      console.error(`[FAIL] ${label}`);
      for (const failure of failures) {
        console.error(`  - ${failure}`);
      }
      console.error(`  reply: ${String(result.body?.reply || result.text || "")}`);
      continue;
    }

    passed += 1;
    console.log(`[PASS] ${label}`);
    console.log(`  reply: ${String(result.body?.reply || "")}`);
    console.log(`  rewriteSource: ${String(result.body?.debugMeta?.rewriteSource || "") || "null"}`);
    console.log(`  needsSoberReadjustment: ${String(result.body?.debugMeta?.needsSoberReadjustment === true)}`);
  }

  if (failed > 0) {
    console.error(`[EVAL] ${passed}/${dataset.length} cases passed, ${failed} failed.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[EVAL] ${passed}/${dataset.length} cases passed.`);
}

run().catch(err => {
  console.error(`[FAIL] eval runtime: ${err.message}`);
  process.exitCode = 1;
});