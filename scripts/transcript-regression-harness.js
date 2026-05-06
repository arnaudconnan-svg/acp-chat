"use strict";

const fs = require("fs");
const path = require("path");
const { buildLLMUserTurns } = require("../lib/llm-messages");

const casesPath = path.join(__dirname, "fixtures", "transcript-regression-cases.json");
const regressionCases = JSON.parse(fs.readFileSync(casesPath, "utf8"));

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed += 1;
    return;
  }

  console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
  failed += 1;
}

function countConsecutiveUserTurns(turns) {
  let count = 0;
  for (let i = 1; i < turns.length; i += 1) {
    if (turns[i].role === "user" && turns[i - 1].role === "user") {
      count += 1;
    }
  }
  return count;
}

console.log("[TRANSCRIPT] Running transcript regression harness...");

for (const testCase of regressionCases) {
  const turns = buildLLMUserTurns(testCase.message, testCase.history);
  const labelPrefix = `[${testCase.label}]`;

  assert(`${labelPrefix} expected length`, turns.length === testCase.expectedLength, `got ${turns.length}`);
  assert(
    `${labelPrefix} expected last role`,
    turns.length > 0 && turns[turns.length - 1].role === testCase.expectedLastRole,
    `got ${turns.length > 0 ? turns[turns.length - 1].role : "<none>"}`
  );

  if (testCase.expectNoConsecutiveUser) {
    assert(
      `${labelPrefix} no consecutive user turns`,
      countConsecutiveUserTurns(turns) === 0,
      `got ${countConsecutiveUserTurns(turns)}`
    );
  }
}

console.log("");
if (failed === 0) {
  console.log(`[TRANSCRIPT] ${passed}/${passed + failed} passed`);
} else {
  console.log(`[TRANSCRIPT] ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(1);
}
