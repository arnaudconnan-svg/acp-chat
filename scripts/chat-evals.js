"use strict";

const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:3000";
const DATASET_PATH = process.env.EVAL_DATASET_PATH || path.join(__dirname, "..", "data", "chat-evals.json");
const OUTPUT_PATH = process.env.EVAL_OUTPUT_PATH || path.join(__dirname, "..", "data", "chat-evals-report.latest.json");
const EVAL_MAX_RETRIES = Number.parseInt(process.env.EVAL_MAX_RETRIES || "5", 10);
const EVAL_RETRY_BASE_MS = Number.parseInt(process.env.EVAL_RETRY_BASE_MS || "500", 10);
const EVAL_RETRY_MAX_MS = Number.parseInt(process.env.EVAL_RETRY_MAX_MS || "8000", 10);
const EVAL_PACING_MS = Number.parseInt(process.env.EVAL_PACING_MS || "350", 10);
const EVAL_BATCH_SIZE = Number.parseInt(process.env.EVAL_BATCH_SIZE || "8", 10);
const EVAL_BATCH_PAUSE_MS = Number.parseInt(process.env.EVAL_BATCH_PAUSE_MS || "1800", 10);
const EVAL_RECENT_HISTORY_TAIL = Number.parseInt(process.env.EVAL_RECENT_HISTORY_TAIL || "6", 10);
const EVAL_BRANCH_HISTORY_TAIL = Number.parseInt(process.env.EVAL_BRANCH_HISTORY_TAIL || "8", 10);
const EVAL_HISTORY_CONTENT_MAX_CHARS = Number.parseInt(process.env.EVAL_HISTORY_CONTENT_MAX_CHARS || "240", 10);
const EVAL_MEMORY_MAX_CHARS = Number.parseInt(process.env.EVAL_MEMORY_MAX_CHARS || "420", 10);

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
  for (let attempt = 0; attempt <= EVAL_MAX_RETRIES; attempt += 1) {
    try {
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

      const shouldRetryStatus = [408, 429, 500, 502, 503, 504].includes(response.status);
      if (shouldRetryStatus && attempt < EVAL_MAX_RETRIES) {
        const retryAfterHeader = response.headers.get("retry-after-ms") || response.headers.get("retry-after");
        const retryAfterMs = Number.parseFloat(retryAfterHeader || "0");
        const backoffMs = Math.min(EVAL_RETRY_MAX_MS, EVAL_RETRY_BASE_MS * Math.pow(2, attempt));
        const jitterMs = Math.floor(Math.random() * 250);
        await sleep(Math.max(Number.isFinite(retryAfterMs) ? retryAfterMs : 0, backoffMs + jitterMs));
        continue;
      }

      return {
        status: response.status,
        ok: response.ok,
        contentType,
        body,
        text
      };
    } catch (err) {
      if (attempt >= EVAL_MAX_RETRIES) {
        throw err;
      }

      const backoffMs = Math.min(EVAL_RETRY_MAX_MS, EVAL_RETRY_BASE_MS * Math.pow(2, attempt));
      const jitterMs = Math.floor(Math.random() * 250);
      await sleep(backoffMs + jitterMs);
    }
  }

  throw new Error("requestChat retry loop exhausted unexpectedly");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function truncateText(value, maxChars) {
  if (maxChars <= 0) {
    return String(value || "");
  }

  const normalized = String(value || "").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeHistoryEntries(history, tailCount, maxContentChars) {
  if (!Array.isArray(history)) {
    return [];
  }

  const safeTail = Number.isInteger(tailCount) && tailCount > 0 ? tailCount : history.length;
  const slice = history.slice(-safeTail);

  return slice.map(item => {
    const role = String(item?.role || "").trim();
    return {
      role: role || "user",
      content: truncateText(item?.content, maxContentChars)
    };
  });
}

function normalizeCaseFlags(flags) {
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    return {};
  }

  return flags;
}

function buildPayload(testCase, index) {
  const recentHistoryTail = Number.isInteger(testCase.recentHistoryTail) ? testCase.recentHistoryTail : EVAL_RECENT_HISTORY_TAIL;
  const branchHistoryTail = Number.isInteger(testCase.branchHistoryTail) ? testCase.branchHistoryTail : EVAL_BRANCH_HISTORY_TAIL;
  const historyMaxChars = Number.isInteger(testCase.historyContentMaxChars)
    ? testCase.historyContentMaxChars
    : EVAL_HISTORY_CONTENT_MAX_CHARS;
  const memoryMaxChars = Number.isInteger(testCase.memoryMaxChars) ? testCase.memoryMaxChars : EVAL_MEMORY_MAX_CHARS;

  return {
    conversationId: `eval-${testCase.id || `case-${index + 1}`}`,
    userId: "eval_runner",
    message: String(testCase.message || ""),
    recentHistory: normalizeHistoryEntries(testCase.recentHistory, recentHistoryTail, historyMaxChars),
    conversationBranchHistory: Array.isArray(testCase.conversationBranchHistory)
      ? normalizeHistoryEntries(testCase.conversationBranchHistory, branchHistoryTail, historyMaxChars)
      : undefined,
    memory: truncateText(typeof testCase.memory === "string" ? testCase.memory : "", memoryMaxChars),
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

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function chipsIncludeExpected(chips, expectedChip) {
  return chips.some(chip => chip === expectedChip || chip.startsWith(`${expectedChip} :`));
}

function evaluateExpectations(testCase, result) {
  const expectations = testCase.expect || {};
  const reply = String(result.body?.reply || "");
  const debugMeta = result.body?.debugMeta || {};
  const memory = String(debugMeta.memory || "");
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

  if (Array.isArray(expectations.rewriteSourceIncludes)) {
    const actualRewriteSource = String(debugMeta.rewriteSource || "");
    for (const expectedPart of expectations.rewriteSourceIncludes) {
      if (!actualRewriteSource.includes(String(expectedPart))) {
        failures.push(
          `expected debugMeta.rewriteSource to include '${String(expectedPart)}', got '${actualRewriteSource || "null"}'`
        );
      }
    }
  }

  if (expectations.interpretationRejection !== undefined && debugMeta.interpretationRejection !== expectations.interpretationRejection) {
    failures.push(
      `expected debugMeta.interpretationRejection=${expectations.interpretationRejection}, got ${String(debugMeta.interpretationRejection)}`
    );
  }

  if (expectations.infoSubmode !== undefined && debugMeta.infoSubmode !== expectations.infoSubmode) {
    failures.push(`expected debugMeta.infoSubmode='${expectations.infoSubmode}', got '${String(debugMeta.infoSubmode)}'`);
  }

  if (
    expectations.explorationCalibrationLevel !== undefined &&
    debugMeta.explorationCalibrationLevel !== expectations.explorationCalibrationLevel
  ) {
    failures.push(
      `expected debugMeta.explorationCalibrationLevel=${expectations.explorationCalibrationLevel}, got ${String(debugMeta.explorationCalibrationLevel)}`
    );
  }

  if (expectations.modeChip !== undefined) {
    const chips = Array.isArray(debugMeta.topChips) ? debugMeta.topChips : [];
    if (!chipsIncludeExpected(chips, expectations.modeChip)) {
      failures.push(`expected topChips to include '${expectations.modeChip}', got [${chips.join(", ")}]`);
    }
  }

  if (Array.isArray(expectations.topChipsInclude)) {
    const chips = Array.isArray(debugMeta.topChips) ? debugMeta.topChips : [];
    for (const chip of expectations.topChipsInclude) {
      if (!chipsIncludeExpected(chips, chip)) {
        failures.push(`expected topChips to include '${chip}', got [${chips.join(", ")}]`);
      }
    }
  }

  if (Array.isArray(expectations.memoryIncludes)) {
    const comparableMemory = normalizeComparableText(memory);
    for (const snippet of expectations.memoryIncludes) {
      if (!comparableMemory.includes(normalizeComparableText(snippet))) {
        failures.push(`expected debugMeta.memory to include '${String(snippet)}'`);
      }
    }
  }

  if (expectations.explorationSubmode !== undefined && debugMeta.explorationSubmode !== expectations.explorationSubmode) {
    failures.push(`expected debugMeta.explorationSubmode='${expectations.explorationSubmode}', got '${String(debugMeta.explorationSubmode)}'`);
  }

  if (expectations.conversationStateKey !== undefined && debugMeta.conversationStateKey !== expectations.conversationStateKey) {
    failures.push(`expected debugMeta.conversationStateKey='${expectations.conversationStateKey}', got '${String(debugMeta.conversationStateKey)}'`);
  }

  if (expectations.allianceState !== undefined && debugMeta.allianceState !== expectations.allianceState) {
    failures.push(`expected debugMeta.allianceState='${expectations.allianceState}', got '${String(debugMeta.allianceState)}'`);
  }

  if (expectations.processingWindow !== undefined && debugMeta.processingWindow !== expectations.processingWindow) {
    failures.push(`expected debugMeta.processingWindow='${expectations.processingWindow}', got '${String(debugMeta.processingWindow)}'`);
  }

  if (expectations.dependencyRiskLevel !== undefined && debugMeta.dependencyRiskLevel !== expectations.dependencyRiskLevel) {
    failures.push(`expected debugMeta.dependencyRiskLevel='${expectations.dependencyRiskLevel}', got '${String(debugMeta.dependencyRiskLevel)}'`);
  }

  if (expectations.externalSupportMode !== undefined && debugMeta.externalSupportMode !== expectations.externalSupportMode) {
    failures.push(`expected debugMeta.externalSupportMode='${expectations.externalSupportMode}', got '${String(debugMeta.externalSupportMode)}'`);
  }

  if (expectations.closureIntent !== undefined && debugMeta.closureIntent !== expectations.closureIntent) {
    failures.push(`expected debugMeta.closureIntent=${expectations.closureIntent}, got ${String(debugMeta.closureIntent)}`);
  }

  if (Array.isArray(expectations.replyMustNotInclude)) {
    const comparableReply = normalizeComparableText(reply);
    for (const snippet of expectations.replyMustNotInclude) {
      if (comparableReply.includes(normalizeComparableText(snippet))) {
        failures.push(`expected reply not to include '${String(snippet)}'`);
      }
    }
  }

  return failures;
}

function buildCaseReport(label, result, failures = []) {
  const debugMeta = result.body?.debugMeta || {};
  return {
    label,
    status: result.status,
    passed: failures.length === 0,
    failures,
    reply: String(result.body?.reply || result.text || ""),
    debugMeta: {
      topChips: Array.isArray(debugMeta.topChips) ? debugMeta.topChips : [],
      infoSubmode: debugMeta.infoSubmode ?? null,
      explorationSubmode: typeof debugMeta.explorationSubmode === "string" ? debugMeta.explorationSubmode : null,
      interpretationRejection: debugMeta.interpretationRejection === true,
      needsSoberReadjustment: debugMeta.needsSoberReadjustment === true,
      explorationCalibrationLevel: Number.isInteger(debugMeta.explorationCalibrationLevel) ? debugMeta.explorationCalibrationLevel : null,
      rewriteSource: typeof debugMeta.rewriteSource === "string" ? debugMeta.rewriteSource : null,
      memoryRewriteSource: typeof debugMeta.memoryRewriteSource === "string" ? debugMeta.memoryRewriteSource : null,
      modelConflict: debugMeta.modelConflict === true,
      memory: typeof debugMeta.memory === "string" ? debugMeta.memory : "",
      conversationStateKey: typeof debugMeta.conversationStateKey === "string" ? debugMeta.conversationStateKey : null,
      allianceState: typeof debugMeta.allianceState === "string" ? debugMeta.allianceState : null,
      processingWindow: typeof debugMeta.processingWindow === "string" ? debugMeta.processingWindow : null,
      dependencyRiskLevel: typeof debugMeta.dependencyRiskLevel === "string" ? debugMeta.dependencyRiskLevel : null,
      externalSupportMode: typeof debugMeta.externalSupportMode === "string" ? debugMeta.externalSupportMode : null,
      closureIntent: debugMeta.closureIntent === true
    }
  };
}

function writeJsonReport(report) {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
}

function buildJsonReport({ datasetLength, passed, failed, caseReports, completed, runtimeError = null }) {
  return {
    baseUrl: BASE_URL,
    datasetPath: DATASET_PATH,
    outputPath: OUTPUT_PATH,
    total: datasetLength,
    passed,
    failed,
    completed,
    runtimeError,
    cases: caseReports
  };
}

async function run() {
  const dataset = readDataset();

  console.log(`[EVAL] Base URL: ${BASE_URL}`);
  console.log(`[EVAL] Dataset: ${DATASET_PATH}`);
  console.log(`[EVAL] Cases: ${dataset.length}`);
  console.log(`[EVAL] JSON report: ${OUTPUT_PATH}`);
  console.log(`[EVAL] Retry: max=${EVAL_MAX_RETRIES}, base=${EVAL_RETRY_BASE_MS}ms, maxBackoff=${EVAL_RETRY_MAX_MS}ms`);
  console.log(`[EVAL] Pacing: interCase=${EVAL_PACING_MS}ms, batch=${EVAL_BATCH_SIZE}, batchPause=${EVAL_BATCH_PAUSE_MS}ms`);
  console.log(
    `[EVAL] Payload lightening: recentTail=${EVAL_RECENT_HISTORY_TAIL}, branchTail=${EVAL_BRANCH_HISTORY_TAIL}, historyChars=${EVAL_HISTORY_CONTENT_MAX_CHARS}, memoryChars=${EVAL_MEMORY_MAX_CHARS}`
  );

  let passed = 0;
  let failed = 0;
  const caseReports = [];

  writeJsonReport(buildJsonReport({
    datasetLength: dataset.length,
    passed,
    failed,
    caseReports,
    completed: false
  }));

  try {
    for (let index = 0; index < dataset.length; index += 1) {
      const testCase = dataset[index];
      const label = String(testCase.id || `case-${index + 1}`);
      const payload = buildPayload(testCase, index);
      const result = await requestChat(payload);
      const failures = evaluateExpectations(testCase, result);

      if (failures.length > 0) {
        failed += 1;
        caseReports.push(buildCaseReport(label, result, failures));
        writeJsonReport(buildJsonReport({
          datasetLength: dataset.length,
          passed,
          failed,
          caseReports,
          completed: false
        }));
        console.error(`[FAIL] ${label}`);
        for (const failure of failures) {
          console.error(`  - ${failure}`);
        }
        console.error(`  reply: ${String(result.body?.reply || result.text || "")}`);

        if (index < dataset.length - 1 && EVAL_PACING_MS > 0) {
          await sleep(EVAL_PACING_MS);
        }

        if (
          index < dataset.length - 1 &&
          EVAL_BATCH_SIZE > 0 &&
          EVAL_BATCH_PAUSE_MS > 0 &&
          (index + 1) % EVAL_BATCH_SIZE === 0
        ) {
          await sleep(EVAL_BATCH_PAUSE_MS);
        }

        continue;
      }

      passed += 1;
      caseReports.push(buildCaseReport(label, result, []));
      writeJsonReport(buildJsonReport({
        datasetLength: dataset.length,
        passed,
        failed,
        caseReports,
        completed: false
      }));
      console.log(`[PASS] ${label}`);
      console.log(`  reply: ${String(result.body?.reply || "")}`);
      console.log(`  rewriteSource: ${String(result.body?.debugMeta?.rewriteSource || "") || "null"}`);
      console.log(`  needsSoberReadjustment: ${String(result.body?.debugMeta?.needsSoberReadjustment === true)}`);

      if (index < dataset.length - 1 && EVAL_PACING_MS > 0) {
        await sleep(EVAL_PACING_MS);
      }

      if (
        index < dataset.length - 1 &&
        EVAL_BATCH_SIZE > 0 &&
        EVAL_BATCH_PAUSE_MS > 0 &&
        (index + 1) % EVAL_BATCH_SIZE === 0
      ) {
        await sleep(EVAL_BATCH_PAUSE_MS);
      }
    }
  } catch (err) {
    writeJsonReport(buildJsonReport({
      datasetLength: dataset.length,
      passed,
      failed,
      caseReports,
      completed: false,
      runtimeError: err.message
    }));
    throw err;
  }

  if (failed > 0) {
    writeJsonReport(buildJsonReport({
      datasetLength: dataset.length,
      passed,
      failed,
      caseReports,
      completed: true
    }));
    console.error(`[EVAL] ${passed}/${dataset.length} cases passed, ${failed} failed.`);
    process.exitCode = 1;
    return;
  }

  writeJsonReport(buildJsonReport({
    datasetLength: dataset.length,
    passed,
    failed,
    caseReports,
    completed: true
  }));
  console.log(`[EVAL] ${passed}/${dataset.length} cases passed.`);
}

run().catch(err => {
  const message = err && err.message ? err.message : String(err);
  console.error(`[FAIL] eval runtime: ${message}`);
  process.exitCode = 1;
});