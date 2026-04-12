"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const REQUIRED_INDEX = "conversationId";
const REQUIRED_USER_INDEX = "email";

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

function ensureUsersEmailIndex(rulesContainer) {
  const next = JSON.parse(JSON.stringify(rulesContainer || { rules: {} }));

  if (!next.rules || typeof next.rules !== "object" || Array.isArray(next.rules)) {
    next.rules = {};
  }

  if (!next.rules.users || typeof next.rules.users !== "object" || Array.isArray(next.rules.users)) {
    next.rules.users = {};
  }

  const current = next.rules.users[".indexOn"];

  if (Array.isArray(current)) {
    if (!current.includes(REQUIRED_USER_INDEX)) {
      next.rules.users[".indexOn"] = [...current, REQUIRED_USER_INDEX];
      return { changed: true, rules: next };
    }

    return { changed: false, rules: next };
  }

  if (typeof current === "string") {
    if (current === REQUIRED_USER_INDEX) {
      return { changed: false, rules: next };
    }

    next.rules.users[".indexOn"] = [current, REQUIRED_USER_INDEX];
    return { changed: true, rules: next };
  }

  next.rules.users[".indexOn"] = [REQUIRED_USER_INDEX];
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

function hasRequiredUsersIndex(rulesContainer) {
  const value = rulesContainer?.rules?.users?.[".indexOn"];

  if (Array.isArray(value)) {
    return value.includes(REQUIRED_USER_INDEX);
  }

  if (typeof value === "string") {
    return value === REQUIRED_USER_INDEX;
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
  const ensuredMessages = ensureMessagesConversationIndex(rulesContainer);
  const ensuredUsers = ensureUsersEmailIndex(ensuredMessages.rules);
  const changed = ensuredMessages.changed || ensuredUsers.changed;

  console.log(`[RTDB-INDEX] Base URL: ${baseUrl}`);
  console.log(`[RTDB-INDEX] Existing messages index present: ${hasRequiredIndex(rulesContainer)}`);
  console.log(`[RTDB-INDEX] Existing users index present: ${hasRequiredUsersIndex(rulesContainer)}`);

  if (!changed) {
    console.log("[RTDB-INDEX] No change needed. Required indexes are already present.");
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

  await putRules(db, ensuredUsers.rules);
  console.log("[RTDB-INDEX] Rules updated.");

  const refreshedRawRules = await fetchRules(db);
  const refreshedContainer = toRulesContainer(refreshedRawRules);

  if (!hasRequiredIndex(refreshedContainer)) {
    throw new Error("Post-update validation failed: conversationId index not found in rules");
  }

  if (!hasRequiredUsersIndex(refreshedContainer)) {
    throw new Error("Post-update validation failed: email index not found in rules");
  }

  console.log("[RTDB-INDEX] Validation OK. messages and users indexes are present.");
}

main().catch(err => {
  console.error(`[RTDB-INDEX][FAIL] ${err.message}`);
  process.exitCode = 1;
});
