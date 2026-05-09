"use strict";

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const fileArg = argv.find(arg => !arg.startsWith("--"));
  const slowThresholdArg = argv.find(arg => arg.startsWith("--slow-threshold-ms="));
  const stateArg = argv.find(arg => arg.startsWith("--state="));

  return {
    filePath: fileArg || path.join(__dirname, "..", "data", "render-live.log"),
    slowThresholdMs: slowThresholdArg ? Math.max(0, Number(slowThresholdArg.split("=")[1]) || 0) : 4000,
    stateFilter: stateArg ? String(stateArg.split("=")[1] || "").trim() : ""
  };
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[index];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function readLogLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function collectStageDurations(entries) {
  const byStage = new Map();

  for (const entry of entries) {
    if (!Array.isArray(entry.stageTimings)) continue;
    for (const stageEntry of entry.stageTimings) {
      const stage = String(stageEntry?.stage || "").trim();
      const deltaMs = Number(stageEntry?.deltaMs);
      if (!stage || !Number.isFinite(deltaMs) || deltaMs < 0) continue;

      const bucket = byStage.get(stage) || [];
      bucket.push(deltaMs);
      byStage.set(stage, bucket);
    }
  }

  const summary = [];
  for (const [stage, values] of byStage.entries()) {
    const sorted = values.slice().sort((a, b) => a - b);
    summary.push({
      stage,
      count: values.length,
      meanMs: Number(mean(values).toFixed(1)),
      p95Ms: percentile(sorted, 95),
      maxMs: sorted[sorted.length - 1]
    });
  }

  summary.sort((a, b) => b.meanMs - a.meanMs);
  return summary;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(args.filePath);

  if (!fs.existsSync(filePath)) {
    console.error(`[perf] log file not found: ${filePath}`);
    process.exit(1);
  }

  const entries = readLogLines(filePath).filter((entry) => entry && entry.event === "pipeline_summary");
  const filtered = entries.filter((entry) => {
    if (args.stateFilter && String(entry.conversationState || "") !== args.stateFilter) return false;
    return true;
  });

  if (filtered.length === 0) {
    console.log("[perf] no matching pipeline_summary entries");
    return;
  }

  const elapsedValues = filtered
    .map(entry => Number(entry.elapsedMs))
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  const slowCount = filtered.filter(entry => Number(entry.elapsedMs) >= args.slowThresholdMs).length;

  const stageSummary = collectStageDurations(filtered);

  console.log(JSON.stringify({
    filePath,
    count: filtered.length,
    slowThresholdMs: args.slowThresholdMs,
    slowCount,
    elapsed: {
      meanMs: Number(mean(elapsedValues).toFixed(1)),
      medianMs: percentile(elapsedValues, 50),
      p95Ms: percentile(elapsedValues, 95),
      maxMs: elapsedValues[elapsedValues.length - 1] || 0
    },
    firstTurnCount: filtered.filter(entry => entry.isFirstTurn === true).length,
    topStagesByMeanMs: stageSummary.slice(0, 10)
  }, null, 2));
}

main();