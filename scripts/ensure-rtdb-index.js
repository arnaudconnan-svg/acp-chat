"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const REQUIRED_INDEX = "conversationId";

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

function toRulesContainer(rawRules) {
  if (rawRules && typeof rawRules === "object" && rawRules.rules && typeof rawRules.rules === "object") {
    return rawRules;
  }

  return { rules: rawRules && typeof rawRules === "object" ? rawRules : {} };
}

function ensureMessagesConversationIndex(rulesContainer) {
  const next = JSON.parse(JSON.stringify(rulesContainer || { rules: {} }));

  if (!next.rules || typeof next.rules !== "object" || Array.isArray(next.rules)) {
    next.rules = {};
  }

  if (!next.rules.messages || typeof next.rules.messages !== "object" || Array.isArray(next.rules.messages)) {
    next.rules.messages = {};
  }

  const current = next.rules.messages[".indexOn"];

  if (Array.isArray(current)) {
    if (!current.includes(REQUIRED_INDEX)) {
      next.rules.messages[".indexOn"] = [...current, REQUIRED_INDEX];
      return { changed: true, rules: next };
    }

    return { changed: false, rules: next };
  }

  if (typeof current === "string") {
    if (current === REQUIRED_INDEX) {
      return { changed: false, rules: next };
    }

    next.rules.messages[".indexOn"] = [current, REQUIRED_INDEX];
    return { changed: true, rules: next };
  }

  next.rules.messages[".indexOn"] = [REQUIRED_INDEX];
  return { changed: true, rules: next };
}

function hasRequiredIndex(rulesContainer) {
  const value = rulesContainer?.rules?.messages?.[".indexOn"];

  if (Array.isArray(value)) {
    return value.includes(REQUIRED_INDEX);
  }

  if (typeof value === "string") {
    return value === REQUIRED_INDEX;
  }

  return false;
}

async function fetchRules(db) {
  const rulesText = await db.getRules();

  try {
    return JSON.parse(String(rulesText || "{}"));
  } catch (err) {
    throw new Error(`Unable to parse existing RTDB rules JSON: ${err.message}`);
  }
}

async function putRules(db, rulesContainer) {
  await db.setRules(JSON.stringify(rulesContainer, null, 2));
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

  const rawRules = await fetchRules(db);
  const rulesContainer = toRulesContainer(rawRules);
  const ensured = ensureMessagesConversationIndex(rulesContainer);

  console.log(`[RTDB-INDEX] Base URL: ${baseUrl}`);
  console.log(`[RTDB-INDEX] Existing index present: ${hasRequiredIndex(rulesContainer)}`);

  if (!ensured.changed) {
    console.log("[RTDB-INDEX] No change needed. messages..indexOn already contains conversationId.");
    return;
  }

  if (!apply) {
    console.log("[RTDB-INDEX] Dry run only. Re-run with --apply to push updated rules.");
    return;
  }

  const backupDir = path.join(__dirname, "..", "data");
  const backupFile = path.join(backupDir, `rtdb-rules-backup-${Date.now()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(rulesContainer, null, 2));
  console.log(`[RTDB-INDEX] Backup written: ${backupFile}`);

  await putRules(db, ensured.rules);
  console.log("[RTDB-INDEX] Rules updated.");

  const refreshedRawRules = await fetchRules(db);
  const refreshedContainer = toRulesContainer(refreshedRawRules);

  if (!hasRequiredIndex(refreshedContainer)) {
    throw new Error("Post-update validation failed: conversationId index not found in rules");
  }

  console.log("[RTDB-INDEX] Validation OK. messages..indexOn includes conversationId.");
}

main().catch(err => {
  console.error(`[RTDB-INDEX][FAIL] ${err.message}`);
  process.exitCode = 1;
});
