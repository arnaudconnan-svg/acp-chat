"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const serviceAccountPath = path.join(__dirname, "..", process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    return JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8"));
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }

  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH");
}

function normalizeBaseUrl(url) {
  if (!url || typeof url !== "string") {
    throw new Error("Missing FIREBASE_DATABASE_URL");
  }

  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function writeEmptyJsonArray(filePath) {
  fs.writeFileSync(filePath, "[]\n");
}

function writeEmptyJsonObject(filePath) {
  fs.writeFileSync(filePath, "{}\n");
}

function getLegacyBranchNodeTargets() {
  return [["pre", "miumBranches"].join(""), ["pre", "miumBranchSeeds"].join("")];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const baseUrl = normalizeBaseUrl(process.env.FIREBASE_DATABASE_URL);
  const serviceAccount = loadServiceAccount();

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: baseUrl
  });

  const db = admin.database();
  const firebaseTargets = [
    "conversations",
    "messages",
    "users",
    "userLabels",
    "branches",
    "branchSeeds",
    ...getLegacyBranchNodeTargets()
  ];
  const localResets = [
    { path: path.join(__dirname, "..", "data", "messages.json"), kind: "array" },
    { path: path.join(__dirname, "..", "data", "conversations.json"), kind: "array" },
    { path: path.join(__dirname, "..", "data", "users.json"), kind: "array" }
  ];

  console.log(`[RESET-DATA] Base URL: ${baseUrl}`);
  console.log(`[RESET-DATA] Firebase targets: ${firebaseTargets.join(", ")}`);
  console.log(`[RESET-DATA] Local files: ${localResets.map(entry => entry.path).join(", ")}`);

  if (!apply) {
    console.log("[RESET-DATA] Dry run only. Re-run with --apply to delete Firebase data and reset local JSON files.");
    return;
  }

  await Promise.all(firebaseTargets.map(target => db.ref(target).remove()));

  localResets.forEach(entry => {
    if (entry.kind === "object") {
      writeEmptyJsonObject(entry.path);
      return;
    }

    writeEmptyJsonArray(entry.path);
  });

  console.log("[RESET-DATA] Firebase data removed and local JSON stores reset.");
}

main().catch(err => {
  console.error(`[RESET-DATA][FAIL] ${err.message}`);
  process.exitCode = 1;
});