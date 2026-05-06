"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

function runStep(label, command, args) {
  console.log(`\n[doctor] ${label}`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    console.error(`[doctor] FAILED: ${label}`);
    return false;
  }

  console.log(`[doctor] OK: ${label}`);
  return true;
}

function readVersion(bin, args = ["--version"]) {
  const result = spawnSync(bin, args, {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  return result.status === 0 ? String(result.stdout || "").trim() : "unavailable";
}

console.log("[doctor] Local diagnostics");
console.log(`[doctor] node: ${readVersion("node")}`);
console.log(`[doctor] npm: ${readVersion("npm")}`);
console.log(`[doctor] NODE_ENV: ${String(process.env.NODE_ENV || "<unset>")}`);

const serviceAccountPath = path.join(rootDir, "serviceAccount.json");
console.log(`[doctor] serviceAccount.json present: ${fs.existsSync(serviceAccountPath) ? "yes" : "no"}`);

const steps = [
  ["Syntax check server", "node", ["--check", "server.js"]],
  ["Core state harness", "npm", ["run", "state:harness"]],
  ["Branching harness", "npm", ["run", "branching:harness"]],
  ["Transcript harness", "npm", ["run", "transcript:harness"]]
];

let allPassed = true;
for (const [label, command, args] of steps) {
  const ok = runStep(label, command, args);
  if (!ok) {
    allPassed = false;
  }
}

console.log("");
if (!allPassed) {
  console.error("[doctor] one or more checks failed");
  process.exit(1);
}

console.log("[doctor] all checks passed");
