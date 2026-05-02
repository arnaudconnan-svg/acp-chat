require("dotenv").config();

// Main server entry point.
// - initialize Firebase admin with credentials
// - configure Express, static asset headers, and chat pipeline
// - preserve existing behavior while making the code easier to follow
const admin = require("firebase-admin");
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const serviceAccountPath = require("path").join(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    serviceAccount = require(serviceAccountPath);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH");
  }
} catch (err) {
  throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT JSON: ${err.message}`);
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();
const messagesRef = db.ref("messages");
const userLabelsRef = db.ref("userLabels");
const usersRef = db.ref("users");
const adminSettingsRef = db.ref("adminSettings");
const branchRecordsRef = db.ref("branches");
const branchSeedSnapshotsRef = db.ref("branchSeeds");
const crypto = require("crypto");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const adminSessions = new Map(); // sessionId -> { isAdmin: true, createdAt }
const ADMIN_SESSION_DURATION = 24 * 60 * 60 * 1000; // 24h
const ADMIN_SESSION_SIGNING_SECRET = process.env.ADMIN_SESSION_SECRET || SESSION_SECRET || ADMIN_PASSWORD || "dev-admin-session-secret";
const userSessions = new Map(); // sessionToken -> { userId, createdAt }
const USER_SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30d
const USER_SESSION_SIGNING_SECRET = process.env.USER_SESSION_SECRET || SESSION_SECRET || ADMIN_PASSWORD || "dev-user-session-secret";

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

// --- Emergency numbers --------------------------------------------------------
const EMERGENCY_NUMBERS_FILE = path.join(__dirname, "data/emergency-numbers.json");
const { updateEmergencyNumbers: runEmergencyNumbersUpdate } = require("./lib/emergency-updater");
let emergencyNumbers = {};
try {
  const raw = fs.readFileSync(EMERGENCY_NUMBERS_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  // Strip internal _meta key
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.startsWith("_")) emergencyNumbers[k] = v;
  }
} catch {
  // Non-blocking: fallback text will be used if file is missing
}

let emergencyRefreshInProgress = false;
let lastEmergencyRefreshAt = 0;

const EMERGENCY_REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EMERGENCY_REFRESH_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const EMERGENCY_REFRESH_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REFRESH_EMERGENCY_ON_BOOT = String(process.env.REFRESH_EMERGENCY_ON_BOOT || "false").toLowerCase() === "true";

async function safeRefreshEmergencyNumbers(reason = "interval") {
  const now = Date.now();

  if (emergencyRefreshInProgress) {
    console.log(`[server][emergency-refresh] skipped (${reason}): already in progress.`);
    return;
  }

  if (lastEmergencyRefreshAt > 0 && now - lastEmergencyRefreshAt < EMERGENCY_REFRESH_MIN_INTERVAL_MS) {
    console.log(`[server][emergency-refresh] skipped (${reason}): too recent.`);
    return;
  }

  emergencyRefreshInProgress = true;
  lastEmergencyRefreshAt = now;

  try {
    const updated = await runEmergencyNumbersUpdate(EMERGENCY_NUMBERS_FILE, "[server][emergency-refresh]");
    emergencyNumbers = updated;
    console.log("[server][emergency-refresh] in-memory data updated.");
  } catch (err) {
    console.error("[server][emergency-refresh] refresh failed:", err.message);
  } finally {
    emergencyRefreshInProgress = false;
  }
}

function normalizeCountryCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function lookupEmergencyNumbers(countryCode) {
  const code = normalizeCountryCode(countryCode);
  if (!code) return null;
  return emergencyNumbers[code] || null;
}

function buildEmergencyNumbersText(emergencyInfo) {
  if (!emergencyInfo) return null;
  const parts = [];
  if (emergencyInfo.emergency) parts.push(`urgences : ${emergencyInfo.emergency}`);
  if (emergencyInfo.suicide) parts.push(`pr�vention suicide : ${emergencyInfo.suicide}`);
  return parts.join(" � ") || null;
}
// -----------------------------------------------------------------------------
const {
  clampDependencyRiskScore,
  clampExplorationDirectivityLevel,
  computeExplorationDirectivityLevel,
  getExplorationStructureInstruction,
  normalizeAllianceState,
  normalizeAffiliationWindow,
  normalizeDischargeState,
  normalizeConversationState,
  normalizeConsecutiveNonExplorationTurns,
  normalizeDependencyRiskLevel,
  normalizeEngagementLevel,
  normalizeExternalSupportMode,
  normalizeFlags,
  normalizeProcessingWindow,
  normalizeSessionFlags,
  normalizeStagnationTurns,
  registerExplorationRelance
} = require("./lib/flags");
const { createAnalyzers } = require("./lib/analyzers");
const { baseStateOf } = require("./lib/conversation-state");
const { createMemoryHelpers, forceLectureBotReset } = require("./lib/memory");
const {
  buildAdvancedDebugTrace,
  buildDebug,
  buildPostureDecision,
  computeAffiliationTurnScore,
  computeAffiliationEstablished,
  normalizeGuardText,
  shouldForceExplorationForSituatedImpasse
} = require("./lib/pipeline");
const { buildDefaultPromptRegistry } = require("./lib/prompts");
const {
  createCritic,
  hasTutoiementInReply,
  hasVouvoiementInReply,
  hasTheoreticalViolationHeuristic,
  isProceduralInstrumentalReply
} = require("./lib/critic");
const {
  buildTopChips,
  buildDirectivityText,
  buildResponseDebugMeta: _buildResponseDebugMeta
} = require("./lib/debugmeta");
const { buildLLMUserTurns } = require("./lib/llm-messages");
const {
  CHAT_PRIORITY_RULES,
  CHAT_PRIORITY_MATCHERS,
  resolveChatPriorityRule,
  buildCrisisRoutingDecision
} = require("./lib/chat-routing");
const { createWriter } = require("./lib/writer");

// Local fallback storage for message data when needed.
const MESSAGES_FILE = path.join(__dirname, "data/messages.json");

function readMessages() {
  try {
    const data = fs.readFileSync(MESSAGES_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeMessages(messages) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

const express = require("express");
const OpenAI = require("openai");
const http = require("http");
const https = require("https");

const app = express();
const port = process.env.PORT || 3000;

const _httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20 });
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 0,
  timeout: 55000,
  httpAgent: _httpsAgent,
  fetchOptions: { agent: (url) => url.startsWith("https") ? _httpsAgent : _httpAgent }
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableOpenAIError(err) {
  return Boolean(
    err && (
      err.status === 429 ||
      err.code === "rate_limit_exceeded" ||
      err.type === "tokens"
    )
  );
}

function readRetryDelayMs(err, attempt) {
  const retryAfterMsHeader = err?.headers?.get?.("retry-after-ms");
  const retryAfterSecondsHeader = err?.headers?.get?.("retry-after");
  const retryAfterMs = Number.parseInt(String(retryAfterMsHeader || ""), 10);

  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs + 150, 2500);
  }

  const retryAfterSeconds = Number.parseFloat(String(retryAfterSecondsHeader || ""));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(Math.ceil(retryAfterSeconds * 1000) + 150, 2500);
  }

  return Math.min(400 * (attempt + 1), 2500);
}

const originalCreateChatCompletion = client.chat.completions.create.bind(client.chat.completions);
client.chat.completions.create = async function createChatCompletionWithRetry(...args) {
  let attempt = 0;

  while (true) {
    try {
      return await originalCreateChatCompletion(...args);
    } catch (err) {
      if (!isRetryableOpenAIError(err) || attempt >= 2) {
        throw err;
      }

      await wait(readRetryDelayMs(err, attempt));
      attempt += 1;
    }
  }
};

function readModelId(envKey, fallback) {
  const configuredValue = String(process.env[envKey] || "").trim();
  return configuredValue || fallback;
}

const MODEL_IDS = {
  analysis: readModelId("OPENAI_MODEL_ANALYSIS", "gpt-4.1-mini"),
  generation: readModelId("OPENAI_MODEL_GENERATION", "gpt-4.1"),
  title: readModelId("OPENAI_MODEL_TITLE", "gpt-4o-mini")
};

function createEmailNotifier() {
  const notifyTo = String(process.env.NOTIFY_EMAIL_TO || "").trim();
  const smtpHost = String(process.env.NOTIFY_SMTP_HOST || "").trim();
  const smtpPort = Number(process.env.NOTIFY_SMTP_PORT || 587);
  const smtpSecure = String(process.env.NOTIFY_SMTP_SECURE || "false").trim().toLowerCase() === "true";
  const smtpUser = String(process.env.NOTIFY_SMTP_USER || "").trim();
  const smtpPass = String(process.env.NOTIFY_SMTP_PASSWORD || "").trim();
  const fromAddress = String(process.env.NOTIFY_EMAIL_FROM || smtpUser).trim();

  if (!notifyTo || !smtpHost || !smtpPort || !smtpUser || !smtpPass) {
    return {
      enabled: false,
      sendNewMessageAlert: async () => {}
    };
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });

  async function send(subject, text) {
    try {
      await transporter.sendMail({
        from: fromAddress,
        to: notifyTo,
        subject,
        text
      });
    } catch (err) {
      console.error("[NOTIFY][EMAIL_ERROR]", err.message);
    }
  }

  return {
    enabled: true,
    async sendNewMessageAlert() {
      await send(
        "[Facilitat.io] Nouveau message utilisateur",
        [
          "Il y a un ou plusieurs nouveaux messages enregistres dans Firebase.",
          "Rappel: une seule alerte est envoyee tant que l'admin n'est pas revenue sur /admin.html"
        ].join("\n")
      );
    }
  };
}

const emailNotifier = createEmailNotifier();
let adminVisitedSinceLastAlert = true;
let cachedAdminMailsEnabled = false;
let adminMailsCacheReady = false;

function normalizeMailsEnabledSetting(value) {
  return value !== false;
}

function getCachedAdminMailsEnabled() {
  return cachedAdminMailsEnabled === true;
}

async function bootstrapAdminSettingsCache() {
  try {
    const snap = await adminSettingsRef.child("mailsEnabled").once("value");
    cachedAdminMailsEnabled = normalizeMailsEnabledSetting(snap.val());
    adminMailsCacheReady = true;
    console.log("[server][admin-settings] mailsEnabled cache initialized:", cachedAdminMailsEnabled);
  } catch (err) {
    cachedAdminMailsEnabled = false;
    adminMailsCacheReady = false;
    console.error("[server][admin-settings] boot cache init failed:", err.message);
  }
}

function startAdminSettingsListener() {
  adminSettingsRef.child("mailsEnabled").on(
    "value",
    (snap) => {
      cachedAdminMailsEnabled = normalizeMailsEnabledSetting(snap.val());
      adminMailsCacheReady = true;
    },
    (err) => {
      console.error("[server][admin-settings] listener error:", err.message);
    }
  );
}

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/admin.html", requireAdminAuth, (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(__dirname + "/public/admin.html");
});

// Serve the public folder with cache headers tuned for SPA/PWA behavior.
// HTML and manifest files are always revalidated, while static assets are cached.
app.use(express.static("public", {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    const normalized = String(filePath).replace(/\\/g, "/");
    
    if (normalized.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      return;
    }
    
    if (normalized.endsWith("/manifest.json") || normalized.endsWith(".webmanifest")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      return;
    }
    
    if (normalized.endsWith(".js") || normalized.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
      return;
    }
    
    res.setHeader("Cache-Control", "public, max-age=86400");
  }
}));

app.use(express.json());

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    console.warn("[HTTP][INVALID_JSON]", {
      method: req.method,
      path: req.originalUrl
    });

    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  return next(err);
});

const MAX_RECENT_TURNS = 8;
const MAX_INFO_ANALYSIS_TURNS = 6;
const MAX_SUICIDE_ANALYSIS_TURNS = 10;
const MAX_RECALL_ANALYSIS_TURNS = 6;

// --------------------------------------------------
// 1) OUTILS MINIMAUX
// --------------------------------------------------

function generateSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

function signAdminSessionPayload(payload) {
  return crypto
    .createHmac("sha256", ADMIN_SESSION_SIGNING_SECRET)
    .update(payload)
    .digest("hex");
}

function buildAdminSessionToken(createdAt = Date.now()) {
  const payload = String(createdAt);
  const signature = signAdminSessionPayload(payload);
  return `${payload}.${signature}`;
}

function parseAndValidateAdminSessionToken(token) {
  if (typeof token !== "string" || !token.includes(".")) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const payload = String(parts[0] || "").trim();
  const signature = String(parts[1] || "").trim();

  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = signAdminSessionPayload(payload);

  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const createdAt = Number(payload);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }

  if (Date.now() - createdAt > ADMIN_SESSION_DURATION) {
    return null;
  }

  return {
    isAdmin: true,
    createdAt
  };
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  
  if (!rc) return list;
  
  rc.split(";").forEach(cookie => {
    const parts = cookie.split("=");
    const key = parts.shift()?.trim();
    if (!key) return;
    
    try {
      list[key] = decodeURIComponent(parts.join("="));
    } catch {
      list[key] = parts.join("=");
    }
  });
  
  return list;
}

function signUserSessionPayload(payload) {
  return crypto
    .createHmac("sha256", USER_SESSION_SIGNING_SECRET)
    .update(payload)
    .digest("hex");
}

function buildUserSessionToken(userId, createdAt = Date.now()) {
  const payload = `${String(userId || "").trim()}:${createdAt}`;
  const signature = signUserSessionPayload(payload);
  return `${payload}.${signature}`;
}

function parseAndValidateUserSessionToken(token) {
  if (typeof token !== "string" || !token.includes(".")) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const payload = String(parts[0] || "").trim();
  const signature = String(parts[1] || "").trim();

  if (!payload || !signature || !payload.includes(":")) {
    return null;
  }

  const expectedSignature = signUserSessionPayload(payload);
  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const separatorIndex = payload.lastIndexOf(":");
  const userId = payload.slice(0, separatorIndex).trim();
  const createdAt = Number(payload.slice(separatorIndex + 1));

  if (!userId || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }

  if (Date.now() - createdAt > USER_SESSION_DURATION) {
    return null;
  }

  return {
    userId,
    createdAt
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const salt = parts[1];
  const expectedHashHex = parts[2];
  if (!salt || !expectedHashHex) {
    return false;
  }

  const passwordHashHex = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  const passwordBuffer = Buffer.from(passwordHashHex, "hex");
  const expectedBuffer = Buffer.from(expectedHashHex, "hex");

  if (passwordBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(passwordBuffer, expectedBuffer);
}

async function findUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }

  const snapshot = await usersRef
    .orderByChild("email")
    .equalTo(normalizedEmail)
    .limitToFirst(1)
    .once("value");

  const users = snapshot.val() || null;
  if (!users || typeof users !== "object") {
    return null;
  }

  const entries = Object.entries(users);
  if (!entries.length) {
    return null;
  }

  const [userId, userData] = entries[0];
  return {
    userId,
    user: userData && typeof userData === "object" ? userData : null
  };
}

function toPublicUser(userId, userData, options = {}) {
  const safeUser = userData && typeof userData === "object" ? userData : {};

  return {
    id: String(userId || ""),
    email: normalizeEmail(safeUser.email),
    firstName: typeof safeUser.firstName === "string" && safeUser.firstName.trim() ? safeUser.firstName.trim() : null,
    country: normalizeCountryCode(safeUser.country),
    createdAt: typeof safeUser.createdAt === "string" ? safeUser.createdAt : null,
    updatedAt: typeof safeUser.updatedAt === "string" ? safeUser.updatedAt : null,
    privateConversationsByDefault: safeUser.privateConversationsByDefault === true
  };
}

// Retrieve the admin session from cookies and validate its expiration.
function getAdminSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.adminSessionId;
  
  if (!sessionId) return null;
  
  const session = adminSessions.get(sessionId);
  if (!session) {
    const tokenSession = parseAndValidateAdminSessionToken(sessionId);

    if (!tokenSession) {
      return null;
    }

    adminSessions.set(sessionId, tokenSession);
    return tokenSession;
  }
  
  // expiration
  if (Date.now() - session.createdAt > ADMIN_SESSION_DURATION) {
    adminSessions.delete(sessionId);
    return null;
  }
  
  return session;
}

async function getUserSession(req) {
  const cookies = parseCookies(req);
  const sessionToken = cookies.userSessionId;

  if (!sessionToken) {
    return null;
  }

  let session = userSessions.get(sessionToken) || null;

  if (!session) {
    const tokenSession = parseAndValidateUserSessionToken(sessionToken);

    if (!tokenSession) {
      return null;
    }

    session = tokenSession;
    userSessions.set(sessionToken, session);
  }

  if (Date.now() - Number(session.createdAt || 0) > USER_SESSION_DURATION) {
    userSessions.delete(sessionToken);
    return null;
  }

  const userSnap = await usersRef.child(String(session.userId || "")).once("value");
  const userData = userSnap.val();

  if (!userData || typeof userData !== "object") {
    userSessions.delete(sessionToken);
    return null;
  }

  return {
    token: sessionToken,
    userId: String(session.userId || ""),
    user: userData
  };
}

async function requireUserAuth(req, res, next) {
  try {
    const session = await getUserSession(req);

    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    req.userSession = session;
    return next();
  } catch (err) {
    console.error("Erreur requireUserAuth:", err.message);
    return res.status(500).json({ error: "Auth check failed" });
  }
}

async function resolveBranchActorUserId(req) {
  try {
    const session = await getUserSession(req);

    if (session && typeof session.userId === "string" && session.userId.trim()) {
      return session.userId.trim();
    }
  } catch (err) {
    console.error("Erreur resolveBranchActorUserId:", err.message);
  }

  const bodyUserId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  if (bodyUserId) {
    return bodyUserId;
  }

  const queryUserId = typeof req.query?.userId === "string" ? req.query.userId.trim() : "";
  return queryUserId;
}

// Middleware protecting admin routes by redirecting unauthenticated users.
function requireAdminAuth(req, res, next) {
  const session = getAdminSession(req);
  
  if (!session) {
    const nextUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/admin-login.html?next=${nextUrl}`);
  }
  adminVisitedSinceLastAlert = true;
  next();
}

// Normalize the stored memory value.
// If there is no explicit memory text, fall back to the registry's default template.
function normalizeMemory(memory, promptRegistry = buildDefaultPromptRegistry()) {
  const text = String(memory || "").trim();
  if (text) return text;
  
  return String(promptRegistry.NORMALIZE_MEMORY_TEMPLATE || "").trim() ||
    buildDefaultPromptRegistry().NORMALIZE_MEMORY_TEMPLATE;
}

function normalizeIntersessionMemory(memory, promptRegistry = buildDefaultPromptRegistry()) {
  const text = String(memory || "").trim();
  if (text) return text;

  return String(promptRegistry.NORMALIZE_INTERSESSION_MEMORY_TEMPLATE || "").trim() ||
    buildDefaultPromptRegistry().NORMALIZE_INTERSESSION_MEMORY_TEMPLATE;
}

function extractStableContextOnlyFromIntersessionMemory(memory, promptRegistry = buildDefaultPromptRegistry()) {
  const normalized = normalizeIntersessionMemory(memory, promptRegistry);
  const match = normalized.match(/Contexte stable\s*:\s*([\s\S]*?)(?:\n\s*[A-Za-z\u00C0-\u017E][^:\n]*\s*:|$)/i);
  if (!match) return "";

  return match[1]
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && line !== "-")
    .map(line => line.startsWith("-") ? line.slice(1).trim() : line)
    .filter(Boolean)
    .join("\n");
}

function mergeStableContextOnlyIntoIntersessionMemory(stableContextText, previousMemory, promptRegistry = buildDefaultPromptRegistry()) {
  const normalized = normalizeIntersessionMemory(previousMemory, promptRegistry);
  const stableLines = String(stableContextText || "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  const renderedStableBlock = stableLines.length > 0
    ? stableLines.map(line => `- ${line.replace(/^[-\s]+/, "").trim()}`).join("\n")
    : "-";

  if (/Contexte stable\s*:/i.test(normalized)) {
    return normalized.replace(
      /(Contexte stable\s*:\s*)([\s\S]*?)(?=\n\s*[A-Za-z\u00C0-\u017E][^:\n]*\s*:|$)/i,
      `$1\n${renderedStableBlock}\n`
    ).trim();
  }

  return [
    "Contexte stable:",
    renderedStableBlock,
    "",
    normalized
  ].join("\n").trim();
}

// Keep only the last valid user/assistant turns from history.
function trimHistoryWithLimit(history, maxTurns) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-maxTurns);
}

function normalizeConversationBranchHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content }));
}

function trimHistory(history) {
  return trimHistoryWithLimit(history, MAX_RECENT_TURNS);
}

function trimInfoAnalysisHistory(history) {
  return trimHistoryWithLimit(history, MAX_INFO_ANALYSIS_TURNS);
}

function trimSuicideAnalysisHistory(history) {
  return trimHistoryWithLimit(history, MAX_SUICIDE_ANALYSIS_TURNS);
}

function trimRecallAnalysisHistory(history) {
  return trimHistoryWithLimit(history, MAX_RECALL_ANALYSIS_TURNS);
}

function isExplicitAppFeatureRequest(message = "") {
  const text = normalizeGuardText(message);

  // Questions de decouverte generale : pas besoin de mentionner "app" explicitement
  const isGenericDiscovery = /^(comment (ca|cela|tu) (marche|fonctionnes?)|c'est quoi (cette app|ca|cela)\??|(tu peux|vous pouvez) faire quoi|qu'est-ce que (tu peux|vous pouvez) faire|a quoi (tu sers|vous servez))[\s?!.]*$/.test(text);
  if (isGenericDiscovery) return true;

  const mentionsApp = /\b(app|application|outil|plateforme|assistant)\b/.test(text);
  const asksUsage = /comment (utiliser|fonctionne|ca marche)|que fait l'app|quoi faire dans l'app|mode d'emploi|etapes|fonctionnalites|plan d'urgence|dans l'app/.test(text);

  return mentionsApp && asksUsage;
}

// --------------------------------------------------
// 3) ANALYSE INFO + CONTACT + RECALL + CONFLIT MODELE + RELANCE
// --------------------------------------------------

// Detect whether the user is asking an information request.
async function llmInfoAnalysis(message = "", history = [], promptRegistry = buildDefaultPromptRegistry()) {
  const context = trimInfoAnalysisHistory(history);
  
  const r = await client.chat.completions.create({
    model: MODEL_IDS.analysis,
    temperature: 0,
    max_tokens: 60,
    messages: [
      { role: "system", content: promptRegistry.ANALYZE_INFO },
      ...context.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message }
    ]
  });
  
  try {
    const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    
    return {
      isInfoRequest: parsed.isInfoRequest === true,
      source: "llm"
    };
  } catch {
    return {
      isInfoRequest: false,
      source: "llm_fallback"
    };
  }
}

const {
  analyzeDischargeState,
  analyzeExplorationCalibration,
  analyzeExplorationRelance,
  analyzeEmotionalDecentering,
  analyzeAttentionQuality,
  analyzeAllianceRupture,
  analyzeInfoRequest,
  analyzeInfoSignal,
  analyzeInterpretationRejection,
  analyzeTechnicalContext,
  analyzeSomaticSignal,
  analyzeUserRegister,
  analyzeRecallRouting,
  analyzeRelationalAdjustmentNeed,
  analyzeSuicideRisk,
  analyzeClosureIntent,
  acuteCrisisFollowupResponse,
  n1Fallback,
  n1ResponseLLM,
  n2Response,
  proposeState
} = createAnalyzers({
  client,
  MODEL_IDS,
  isExplicitAppFeatureRequest,
  llmInfoAnalysis,
  normalizeMemory,
  normalizeSessionFlags,
  shouldForceExplorationForSituatedImpasse,
  trimHistory,
  trimInfoAnalysisHistory,
  trimRecallAnalysisHistory,
  trimSuicideAnalysisHistory
});

async function buildLongTermMemoryRecallResponse({
  memory = "",
  conversationBranchHistory = [],
  promptRegistry = buildDefaultPromptRegistry()
} = {}) {
  const normalizedBranchHistory = normalizeConversationBranchHistory(conversationBranchHistory);
  const user = `
Memoire resumee :
${normalizeMemory(memory, promptRegistry)}

Transcript complet de la branche courante :
${normalizedBranchHistory.length > 0 ? normalizedBranchHistory.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n") : "(indisponible)"}

Formule une reponse de rappel honnete a partir de ces reperes.
`;
  
  const r = await client.chat.completions.create({
    model: MODEL_IDS.analysis,
    temperature: 0.7,
    max_tokens: 150,
    messages: [
      { role: "system", content: promptRegistry.MEMORY_RECALL_RESPONSE },
      { role: "user", content: user }
    ]
  });
  
  return (r.choices?.[0]?.message?.content || "").trim() ||
    (normalizedBranchHistory.length > 0 ?
      "Je peux reprendre quelques elements de ce fil, mais pas garantir chaque detail mot pour mot." :
      "Je garde quelques reperes generaux d'une session a l'autre, mais pas le fil detaille exact.");
}

async function loadConversationBranchHistoryForRecall({
  conversationId = "",
  isPrivateConversation = false,
  conversationBranchHistory = [],
  recentHistory = []
} = {}) {
  const normalizedLocalBranchHistory = normalizeConversationBranchHistory(conversationBranchHistory);

  if (isPrivateConversation === true || !conversationId) {
    return normalizedLocalBranchHistory.length > 0 ? normalizedLocalBranchHistory : normalizeConversationBranchHistory(recentHistory);
  }

  try {
    const messagesSnap = await messagesRef
      .orderByChild("conversationId")
      .equalTo(conversationId)
      .once("value");

    const branchHistory = Object.values(messagesSnap.val() || {})
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      .map(m => ({ role: m.role, content: m.content }));

    if (branchHistory.length > 0) {
      return normalizedLocalBranchHistory.length > branchHistory.length ? normalizedLocalBranchHistory : branchHistory;
    }
  } catch (err) {
    console.warn("[RECALL][BRANCH_LOAD_FAILED]", {
      conversationId,
      error: err && err.message ? err.message : String(err)
    });
  }

  if (normalizedLocalBranchHistory.length > 0) {
    return normalizedLocalBranchHistory;
  }

  return normalizeConversationBranchHistory(recentHistory);
}

function buildNoMemoryRecallResponse() {
  return "Je n'ai pas assez de reperes pour retrouver cela clairement. Tu peux me redonner un peu de contexte ?";
}

// Ask the LLM whether the generated content appears to violate the model conflict policy.
async function analyzeModelConflict(content = "", promptRegistry = buildDefaultPromptRegistry()) {
  const r = await client.chat.completions.create({
    model: MODEL_IDS.analysis,
    temperature: 0,
    max_tokens: 40,
    messages: [
      { role: "system", content: promptRegistry.ANALYZE_CONFLICT_MODEL },
      { role: "user", content: content }
    ]
  });
  
  try {
    const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    
    return {
      modelConflict: parsed.modelConflict === true
    };
  } catch {
    return {
      modelConflict: false
    };
  }
}

async function rewriteConflictModelContent({
  message = "",
  history = [],
  memory = "",
  originalContent,
  promptRegistry = buildDefaultPromptRegistry()
}) {
  const user = `
Message utilisateur :
${message}

Contexte recent :
${history.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

Memoire :
${normalizeMemory(memory, promptRegistry)}

Contenu initial a reformuler :
${originalContent}
`;
  
  const r = await client.chat.completions.create({
    model: MODEL_IDS.generation,
    temperature: 0.3,
    max_tokens: 500,
    messages: [
      { role: "system", content: promptRegistry.REWRITE_TITLE_CONFLICT_MODEL },
      { role: "user", content: user }
    ]
  });
  
  return (r.choices?.[0]?.message?.content || "").trim() || originalContent;
}


// Phase 5: Rewrite a reply to explicitly signal interpretive uncertainty.
async function rewriteForUncertainty({
  reply = "",
  message = "",
  history = [],
  promptRegistry = buildDefaultPromptRegistry()
}) {
  const user = `Message utilisateur :
${message}

Contexte recent :
${(history || []).map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

Reponse a reformuler avec incertitude explicite :
${reply}
`;
  const r = await client.chat.completions.create({
    model: MODEL_IDS.generation,
    temperature: 0.3,
    max_tokens: 350,
    messages: [
      { role: "system", content: promptRegistry.UNCERTAINTY_REWRITE },
      { role: "user", content: user }
    ]
  });
  return String(r.choices?.[0]?.message?.content || "").trim() || reply;
}

// --------------------------------------------------
// 4) MODE + DEBUG
// --------------------------------------------------

// --------------------------------------------------
// 5) MEMOIRE
// --------------------------------------------------

const {
  compressMemoryIfRedundant,
  compressIntersessionMemory,
  finalizeMemoryCandidate,
  shouldCompressMemoryCandidate,
  updateIntersessionMemory,
  updateMemory
} = createMemoryHelpers({
  client,
  MODEL_IDS,
  normalizeIntersessionMemory,
  normalizeMemory
});

const { applySelectiveCritic } = createCritic({ client, MODEL_IDS });

const {
  wrapPromptBlock,
  buildPostureContractBlock,
  getIdentityPrompt,
  getDischargePrompt,
  getRelationalAdjustmentPrompt,
  getInfoPrompt,
  getExplorationPrompt,
  buildExplorationSignalPromptBlock,
  buildStabilizationPromptBlock,
  buildAllianceRupturePromptBlock,
  buildDependencyRiskGuardrailBlock,
  buildClosurePromptBlock,
  buildRelationalAdjustmentPromptBlock,
  buildDischargeStatePromptBlock,
  buildInterpretationRejectionPromptBlock,
  buildSystemPrompt,
  generateReply
} = createWriter({ client, MODEL_IDS, normalizeMemory });

// --------------------------------------------------
// 8) SESSION CLOSE
// --------------------------------------------------

function validateSessionCloseRequestShape(body = {}) {
  const issues = [];

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    issues.push("body_not_object");
    return issues;
  }

  if (body.memory !== undefined && typeof body.memory !== "string") {
    issues.push("memory_not_string");
  }

  if (body.flags !== undefined && (typeof body.flags !== "object" || body.flags === null || Array.isArray(body.flags))) {
    issues.push("flags_not_object");
  }

  return issues;
}

// Reset session flags and return the normalized memory/flags state when the session ends.
app.post("/session/close", async (req, res) => {
  try {
    const requestIssues = validateSessionCloseRequestShape(req.body);

    if (requestIssues.length > 0) {
      console.warn("[SESSION_CLOSE][REQUEST_SHAPE]", {
        issues: requestIssues
      });

      return res.status(400).json({
        error: "Invalid session close request",
        issues: requestIssues
      });
    }

    const promptRegistry = buildDefaultPromptRegistry();
    const previousMemory = normalizeMemory(req.body?.memory, promptRegistry);
    const flags = normalizeSessionFlags(req.body?.flags);
    
    // Reset all session flags while preserving the normalized memory state.
    return res.json({
      memory: previousMemory,
      flags: normalizeSessionFlags({
        ...flags,
        acuteCrisis: false,
        dischargeState: { wasDischarge: false },
        explorationRelanceWindow: [],
        explorationDirectivityLevel: 0
      })
    });
  } catch (err) {
    console.error("Erreur /session/close:", err);
    return res.status(500).json({
      error: "Erreur session close",
      memory: normalizeMemory(req.body?.memory, buildDefaultPromptRegistry()),
      flags: normalizeSessionFlags({})
    });
  }
});

// ------------------------------
// GENERATION TITRE AUTO
// ------------------------------

function normalizeTitleDenyKey(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeGeneratedTitleCandidate(value = "") {
  let title = String(value || "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (title.length > 40) {
    title = title.slice(0, 40).trim();
  }

  return title;
}

// Generate a short, clean title for a conversation from the first user messages.
// Uses the LLM when possible, with fallback rules to keep titles safe and concise.
async function generateConversationTitle(messages, options = {}) {
  const forbiddenTitles = Array.isArray(options?.forbiddenTitles)
    ? options.forbiddenTitles.map(value => String(value || "").trim()).filter(Boolean)
    : [];
  const forbiddenTitleKeys = new Set(forbiddenTitles.map(normalizeTitleDenyKey).filter(Boolean));

  function isForbiddenTitle(title = "") {
    const key = normalizeTitleDenyKey(title);
    return !!key && forbiddenTitleKeys.has(key);
  }

  async function requestTitleFromLlm(sourceText = "", extraForbiddenTitles = []) {
    const effectiveForbidden = Array.from(new Set([
      ...forbiddenTitles,
      ...extraForbiddenTitles.map(value => String(value || "").trim()).filter(Boolean)
    ])).slice(0, 80);

    const avoidBlock = effectiveForbidden.length > 0
      ? [
          "Titres interdits (ne pas proposer ces formulations exactes, meme avec ponctuation/casse differente) :",
          ...effectiveForbidden.map(title => `- ${title}`)
        ].join("\n")
      : "Aucun titre interdit fourni.";

    const completion = await client.chat.completions.create({
      model: MODEL_IDS.title,
      temperature: 0.2,
      max_tokens: 30,
      messages: [{
        role: "system",
        content: [
          "Tu generes un titre tres court en francais pour une conversation.",
          "Contraintes :",
          "- 2 a 6 mots",
          "- pas de guillemets",
          "- pas d'emoji",
          "- pas de point final",
          "- formulation naturelle et specifique",
          "- ne recopie pas simplement le premier message",
          "- ne commence pas par Verbatim de type Je, J, Tu, Mon, Ma sauf si c'est indispensable",
          "- respecte strictement la liste des titres interdits"
        ].join("\n")
      }, {
        role: "user",
        content: `${sourceText}\n\n${avoidBlock}`
      }]
    });

    return sanitizeGeneratedTitleCandidate(completion.choices?.[0]?.message?.content || "");
  }

  try {
    const userMessages = messages
      .filter(m => m && m.role === "user" && typeof m.content === "string")
      .slice(0, 3)
      .map(m => m.content.trim())
      .filter(Boolean);
    
    if (userMessages.length === 0) return null;
    
    const sourceText = userMessages.join("\n\n");

    let title = await requestTitleFromLlm(sourceText);
    
    if (!title) {
      const merged = userMessages.join(" ");
      const words = merged
        .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5);
      
      title = words.length ? words.join(" ") : "Conversation";
    }

        title = sanitizeGeneratedTitleCandidate(title);
    
    if (!title) {
      title = "Conversation";
    }

    if (isForbiddenTitle(title)) {
      const retriedTitle = await requestTitleFromLlm(sourceText, [title]);
      if (retriedTitle && !isForbiddenTitle(retriedTitle)) {
        title = retriedTitle;
      }
    }
    
    const titleConflict = await analyzeModelConflict(title, buildDefaultPromptRegistry());
    
    if (titleConflict.modelConflict === true) {
      title = await rewriteConflictModelContent({
        message: sourceText,
        history: messages
          .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-MAX_RECENT_TURNS)
          .map(m => ({ role: m.role, content: m.content })),
        memory: "",
        originalContent: title,
        promptRegistry: buildDefaultPromptRegistry()
      });
      
      title = sanitizeGeneratedTitleCandidate(title);
      if (!title || isForbiddenTitle(title)) {
        const retriedAfterRewrite = await requestTitleFromLlm(sourceText, [title]);
        if (retriedAfterRewrite && !isForbiddenTitle(retriedAfterRewrite)) {
          title = retriedAfterRewrite;
        }
      }
    }

    if (isForbiddenTitle(title)) {
      return null;
    }
    
    return title || "Conversation";
  } catch (err) {
    console.error("Erreur generation titre:", err.message);
    
    const fallbackMessages = messages
      .filter(m => m && m.role === "user" && typeof m.content === "string")
      .slice(0, 3)
      .map(m => m.content.trim())
      .filter(Boolean);
    
    const merged = fallbackMessages.join(" ");
    const words = merged
      .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    
    let fallbackTitle = words.length ? words.join(" ") : "Conversation";
    
    try {
      const titleConflict = await analyzeModelConflict(fallbackTitle, buildDefaultPromptRegistry());
      
      if (titleConflict.modelConflict === true) {
        fallbackTitle = await rewriteConflictModelContent({
          message: merged,
          history: messages
            .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
            .slice(-MAX_RECENT_TURNS)
            .map(m => ({ role: m.role, content: m.content })),
          memory: "",
          originalContent: fallbackTitle,
          promptRegistry: buildDefaultPromptRegistry()
        });
        
        fallbackTitle = String(fallbackTitle || "")
          .replace(/\s+/g, " ")
          .trim();

        fallbackTitle = sanitizeGeneratedTitleCandidate(fallbackTitle);
      }
    } catch (rewriteErr) {
      console.error("Erreur rewrite titre:", rewriteErr.message);
    }

    if (isForbiddenTitle(fallbackTitle)) {
      return null;
    }
    
    return fallbackTitle || "Conversation";
  }
}

// --------------------------------------------------
// 9) ROUTE
// --------------------------------------------------

// Admin login route that creates a time-limited session cookie.
app.get("/api/admin/session", async (req, res) => {
  try {
    const session = getAdminSession(req);
    if (!session) {
      return res.json({ authenticated: false });
    }

    return res.json({
      authenticated: true,
      settings: {
        mailsEnabled: getCachedAdminMailsEnabled()
      }
    });
  } catch (err) {
    console.error("Erreur /api/admin/session:", err.message);
    return res.status(500).json({ error: "Admin session lookup failed" });
  }
});

app.put("/api/admin/settings", requireAdminAuth, async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      typeof req.body.mailsEnabled !== "boolean"
    ) {
      return res.status(400).json({ error: "Invalid admin settings payload" });
    }

    const mailsEnabled = req.body.mailsEnabled === true;
    await adminSettingsRef.update({ mailsEnabled });
    cachedAdminMailsEnabled = mailsEnabled;
    adminMailsCacheReady = true;

    return res.json({
      success: true,
      settings: {
        mailsEnabled
      }
    });
  } catch (err) {
    console.error("Erreur PUT /api/admin/settings:", err.message);
    return res.status(500).json({ error: "Admin settings update failed" });
  }
});

app.post("/api/admin/login", (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || typeof req.body.password !== "string") {
    return res.status(400).json({ error: "Invalid admin login request" });
  }

  const { password } = req.body;
  
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  const sessionId = buildAdminSessionToken();
  
  adminSessions.set(sessionId, {
    isAdmin: true,
    createdAt: Date.now()
  });
  
  res.setHeader(
    "Set-Cookie",
    `adminSessionId=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_DURATION / 1000)}`
  );
  
  res.json({ success: true });
});

// Admin logout route that clears the session cookie and removes the session.
app.post("/api/admin/logout", (req, res) => {
  const cookies = parseCookies(req);
  const sessionId = cookies.adminSessionId;
  
  if (sessionId) {
    adminSessions.delete(sessionId);
  }
  
  res.setHeader(
    "Set-Cookie",
    "adminSessionId=; HttpOnly; Path=/; Max-Age=0"
  );
  
  res.json({ success: true });
});

app.get("/api/auth/session", async (req, res) => {
  try {
    const session = await getUserSession(req);
    const isAdmin = Boolean(getAdminSession(req));

    if (!session) {
      return res.json({ authenticated: false, user: null });
    }

    return res.json({
      authenticated: true,
      user: toPublicUser(session.userId, session.user, { isAdmin })
    });
  } catch (err) {
    console.error("Erreur /api/auth/session:", err.message);
    return res.status(500).json({ error: "Session lookup failed" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      typeof req.body.email !== "string" ||
      typeof req.body.password !== "string"
    ) {
      return res.status(400).json({ error: "Invalid register request" });
    }

    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Invalid email" });
    }

    if (password.length < 10) {
      return res.status(400).json({ error: "Password must contain at least 10 characters" });
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    // Optional profile fields
    const firstName = typeof req.body.firstName === "string" ? req.body.firstName.trim().slice(0, 50) : null;
    const country = normalizeCountryCode(req.body.country);

    const now = new Date().toISOString();
    const userId = `u_${crypto.randomBytes(12).toString("hex")}`;
    const userRecord = {
      email,
      passwordHash: hashPassword(password),
      privateConversationsByDefault: false,
      createdAt: now,
      updatedAt: now
    };
    if (firstName) userRecord.firstName = firstName;
    if (country) userRecord.country = country;

    await usersRef.child(userId).set(userRecord);

    const sessionToken = buildUserSessionToken(userId);
    userSessions.set(sessionToken, {
      userId,
      createdAt: Date.now()
    });

    res.setHeader(
      "Set-Cookie",
      `userSessionId=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(USER_SESSION_DURATION / 1000)}`
    );

    return res.status(201).json({
      success: true,
      user: toPublicUser(userId, userRecord)
    });
  } catch (err) {
    console.error("Erreur /api/auth/register:", err.message);
    return res.status(500).json({ error: "Register failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      typeof req.body.email !== "string" ||
      typeof req.body.password !== "string"
    ) {
      return res.status(400).json({ error: "Invalid login request" });
    }

    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const found = await findUserByEmail(email);

    if (!found || !found.user || !verifyPassword(password, found.user.passwordHash)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const sessionToken = buildUserSessionToken(found.userId);
    userSessions.set(sessionToken, {
      userId: found.userId,
      createdAt: Date.now()
    });

    res.setHeader(
      "Set-Cookie",
      `userSessionId=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(USER_SESSION_DURATION / 1000)}`
    );

    return res.json({
      success: true,
      user: toPublicUser(found.userId, found.user)
    });
  } catch (err) {
    console.error("Erreur /api/auth/login:", err.message);
    return res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  const cookies = parseCookies(req);
  const sessionToken = cookies.userSessionId;

  if (sessionToken) {
    userSessions.delete(sessionToken);
  }

  res.setHeader(
    "Set-Cookie",
    "userSessionId=; HttpOnly; Path=/; Max-Age=0"
  );

  return res.json({ success: true });
});

app.post("/api/auth/change-password", requireUserAuth, async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      typeof req.body.currentPassword !== "string" ||
      typeof req.body.newPassword !== "string"
    ) {
      return res.status(400).json({ error: "Invalid change password request" });
    }

    const session = req.userSession;
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");

    if (!verifyPassword(currentPassword, session.user.passwordHash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    if (newPassword.length < 10) {
      return res.status(400).json({ error: "Password must contain at least 10 characters" });
    }

    const now = new Date().toISOString();
    await usersRef.child(session.userId).update({
      passwordHash: hashPassword(newPassword),
      updatedAt: now
    });

    return res.json({ success: true, updatedAt: now });
  } catch (err) {
    console.error("Erreur /api/auth/change-password:", err.message);
    return res.status(500).json({ error: "Password change failed" });
  }
});

app.get("/api/account/preferences", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    return res.json({
      privateConversationsByDefault: session?.user?.privateConversationsByDefault === true
    });
  } catch (err) {
    console.error("Erreur GET /api/account/preferences:", err.message);
    return res.status(500).json({ error: "Preferences lookup failed" });
  }
});

app.put("/api/account/preferences", requireUserAuth, async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      typeof req.body.privateConversationsByDefault !== "boolean"
    ) {
      return res.status(400).json({ error: "Invalid preferences payload" });
    }

    const session = req.userSession;
    const value = req.body.privateConversationsByDefault === true;
    const now = new Date().toISOString();

    await usersRef.child(session.userId).update({
      privateConversationsByDefault: value,
      updatedAt: now
    });

    return res.json({
      success: true,
      privateConversationsByDefault: value,
      updatedAt: now
    });
  } catch (err) {
    console.error("Erreur PUT /api/account/preferences:", err.message);
    return res.status(500).json({ error: "Preferences update failed" });
  }
});

app.get("/api/account/profile", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    return res.json({
      firstName: typeof session.user.firstName === "string" && session.user.firstName.trim() ? session.user.firstName.trim() : null,
      country: normalizeCountryCode(session.user.country)
    });
  } catch (err) {
    console.error("Erreur GET /api/account/profile:", err.message);
    return res.status(500).json({ error: "Profile lookup failed" });
  }
});

app.put("/api/account/profile", requireUserAuth, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Invalid profile payload" });
    }

    const session = req.userSession;
    const patch = {};

    if ("firstName" in req.body) {
      const raw = typeof req.body.firstName === "string" ? req.body.firstName.trim().slice(0, 50) : "";
      patch.firstName = raw || null;
    }

    if ("country" in req.body) {
      const code = normalizeCountryCode(req.body.country);
      patch.country = code || null;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const now = new Date().toISOString();
    const update = { ...patch, updatedAt: now };
    // Firebase doesn't store null fields � remove them so they're deleted
    for (const [k, v] of Object.entries(update)) {
      if (v === null) update[k] = null; // Firebase treats null as delete
    }

    await usersRef.child(session.userId).update(update);

    return res.json({
      success: true,
      firstName: patch.firstName !== undefined ? patch.firstName : (typeof session.user.firstName === "string" ? session.user.firstName.trim() : null),
      country: patch.country !== undefined ? patch.country : normalizeCountryCode(session.user.country),
      updatedAt: now
    });
  } catch (err) {
    console.error("Erreur PUT /api/account/profile:", err.message);
    return res.status(500).json({ error: "Profile update failed" });
  }
});

app.get("/api/account/conversations", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const snapshot = await db.ref("conversations").once("value");
    const raw = snapshot.val() || {};

    const conversations = Object.entries(raw)
      .filter(([, value]) => {
        if (String(value?.userId || "") !== session.userId) {
          return false;
        }

        if (typeof value?.deletedAt === "string" && value.deletedAt.trim()) {
          return false;
        }

        if (value?.isBranch === true) {
          return false;
        }

        return true;
      })
      .map(([id, value]) => ({
        id,
        title: typeof value?.title === "string" ? value.title : null,
        updatedAt: value?.updatedAt || value?.createdAt || null,
        createdAt: value?.createdAt || null,
        messageCount: Number(value?.messageCount || 0),
        titleLocked: value?.titleLocked === true,
        lastUserMessage: typeof value?.lastUserMessage === "string" ? value.lastUserMessage : ""
      }))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

    return res.json({ conversations });
  } catch (err) {
    console.error("Erreur /api/account/conversations:", err.message);
    return res.status(500).json({ error: "Conversation lookup failed" });
  }
});

app.get("/api/account/conversations/:id", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const conversationId = String(req.params?.id || "").trim();

    if (!conversationId) {
      return res.status(400).json({ error: "Conversation invalide" });
    }

    const convSnap = await db.ref("conversations").child(conversationId).once("value");
    const conversation = convSnap.val();

    if (!conversation || typeof conversation !== "object") {
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    if (typeof conversation.deletedAt === "string" && conversation.deletedAt.trim()) {
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    if (String(conversation.userId || "") !== session.userId) {
      return res.status(403).json({ error: "Conversation ownership mismatch" });
    }

    const messagesSnap = await messagesRef
      .orderByChild("conversationId")
      .equalTo(conversationId)
      .once("value");

    const messagesRaw = messagesSnap.val() || {};
    const messages = Object.entries(messagesRaw)
      .map(([id, value]) => ({
        id,
        role: String(value?.role || ""),
        content: String(value?.content || ""),
        debug: Array.isArray(value?.debug) ? value.debug : [],
        debugMeta: value?.debugMeta && typeof value.debugMeta === "object" ? value.debugMeta : null,
        stateSnapshot: value?.stateSnapshot && typeof value?.stateSnapshot === "object" ? {
          memory: typeof value.stateSnapshot.memory === "string" ? value.stateSnapshot.memory : "",
          flags: normalizeSessionFlags(value.stateSnapshot.flags || {})
        } : null,
        timestamp: Number(value?.timestamp || 0)
      }))
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

    return res.json({
      conversation: {
        id: conversationId,
        title: typeof conversation.title === "string" ? conversation.title : null,
        updatedAt: conversation.updatedAt || conversation.createdAt || null,
        createdAt: conversation.createdAt || null,
        memory: normalizeMemory(conversation.memory || "", buildDefaultPromptRegistry()),
        flags: normalizeSessionFlags(conversation.flags || {})
      },
      messages
    });
  } catch (err) {
    console.error("Erreur /api/account/conversations/:id:", err.message);
    return res.status(500).json({ error: "Conversation fetch failed" });
  }
});

app.patch("/api/account/conversations/:id", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const conversationId = String(req.params?.id || "").trim();

    if (!conversationId) {
      return res.status(400).json({ error: "Conversation invalide" });
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Invalid conversation update request" });
    }

    const hasTitleField = Object.prototype.hasOwnProperty.call(req.body, "title");
    if (!hasTitleField) {
      return res.status(400).json({ error: "Missing title field" });
    }

    const rawTitle = req.body.title;
    if (rawTitle !== null && typeof rawTitle !== "string") {
      return res.status(400).json({ error: "Invalid title value" });
    }

    const convRef = db.ref("conversations").child(conversationId);
    const convSnap = await convRef.once("value");
    const conversation = convSnap.val();

    if (!conversation || typeof conversation !== "object") {
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    if (typeof conversation.deletedAt === "string" && conversation.deletedAt.trim()) {
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    if (String(conversation.userId || "") !== session.userId) {
      return res.status(403).json({ error: "Conversation ownership mismatch" });
    }

    const normalizedTitle = typeof rawTitle === "string" ? rawTitle.trim().slice(0, 60) : "";
    const now = new Date().toISOString();

    await convRef.update({
      title: normalizedTitle || null,
      titleLocked: normalizedTitle.length > 0,
      updatedAt: now
    });

    return res.json({
      success: true,
      conversation: {
        id: conversationId,
        title: normalizedTitle || null,
        titleLocked: normalizedTitle.length > 0,
        updatedAt: now
      }
    });
  } catch (err) {
    console.error("Erreur PATCH /api/account/conversations/:id:", err.message);
    return res.status(500).json({ error: "Conversation update failed" });
  }
});

app.delete("/api/account/conversations/:id", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const conversationId = String(req.params?.id || "").trim();

    if (!conversationId) {
      return res.status(400).json({ error: "Conversation invalide" });
    }

    const convRef = db.ref("conversations").child(conversationId);
    const convSnap = await convRef.once("value");
    const conversation = convSnap.val();

    if (!conversation || typeof conversation !== "object") {
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    if (typeof conversation.deletedAt === "string" && conversation.deletedAt.trim()) {
      return res.json({ success: true, alreadyDeleted: true });
    }

    if (String(conversation.userId || "") !== session.userId) {
      return res.status(403).json({ error: "Conversation ownership mismatch" });
    }

    const now = new Date().toISOString();

    await convRef.update({
      deletedAt: now,
      updatedAt: now
    });

    return res.json({ success: true, deletedAt: now });
  } catch (err) {
    console.error("Erreur DELETE /api/account/conversations/:id:", err.message);
    return res.status(500).json({ error: "Conversation delete failed" });
  }
});

app.post("/api/account/conversations/claim", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;

    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      typeof req.body.anonymousUserId !== "string" ||
      !Array.isArray(req.body.conversationIds)
    ) {
      return res.status(400).json({ error: "Invalid claim request" });
    }

    const anonymousUserId = String(req.body.anonymousUserId || "").trim();
    const conversationIds = req.body.conversationIds
      .map(value => String(value || "").trim())
      .filter(Boolean)
      .slice(0, 100);

    if (!anonymousUserId || conversationIds.length === 0) {
      return res.status(400).json({ error: "Claim payload incomplete" });
    }

    const uniqueConversationIds = Array.from(new Set(conversationIds));
    const claimedConversationIds = [];
    let alreadyOwnedCount = 0;
    let skippedCount = 0;

    for (const conversationId of uniqueConversationIds) {
      const convRef = db.ref("conversations").child(conversationId);
      const convSnap = await convRef.once("value");
      const conversation = convSnap.val();

      if (!conversation || typeof conversation !== "object") {
        skippedCount += 1;
        continue;
      }

      const ownerId = String(conversation.userId || "").trim();

      if (ownerId === session.userId) {
        alreadyOwnedCount += 1;
        continue;
      }

      if (ownerId !== anonymousUserId) {
        skippedCount += 1;
        continue;
      }

      await convRef.update({ userId: session.userId });

      const messagesSnap = await messagesRef
        .orderByChild("conversationId")
        .equalTo(conversationId)
        .once("value");

      const messages = messagesSnap.val() || {};
      const messageUpdates = {};

      Object.entries(messages).forEach(([messageId, value]) => {
        if (typeof messageId !== "string" || !value || typeof value !== "object") {
          return;
        }

        if (String(value.userId || "").trim() === anonymousUserId) {
          messageUpdates[`${messageId}/userId`] = session.userId;
        }
      });

      if (Object.keys(messageUpdates).length > 0) {
        await messagesRef.update(messageUpdates);
      }

      claimedConversationIds.push(conversationId);
    }

    return res.json({
      success: true,
      claimedConversationIds,
      claimedCount: claimedConversationIds.length,
      alreadyOwnedCount,
      skippedCount
    });
  } catch (err) {
    console.error("Erreur /api/account/conversations/claim:", err.message);
    return res.status(500).json({ error: "Conversation claim failed" });
  }
});

app.post("/api/account/conversations/import-local", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;

    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      !Array.isArray(req.body.conversations)
    ) {
      return res.status(400).json({ error: "Invalid local import request" });
    }

    const forceOverwrite = req.body.forceOverwrite === true;
    const conversations = req.body.conversations.slice(0, 50);
    const importedConversationIds = [];
    const messageIdsByConversation = {};
    let alreadyOwnedCount = 0;
    let skippedCount = 0;

    for (const rawConversation of conversations) {
      const safeConversation = rawConversation && typeof rawConversation === "object" && !Array.isArray(rawConversation) ? rawConversation : null;
      const conversationId = String(safeConversation?.id || "").trim();

      if (!conversationId) {
        skippedCount += 1;
        continue;
      }

      const convRef = db.ref("conversations").child(conversationId);
      const convSnap = await convRef.once("value");
      const existingConversation = convSnap.val();

      if (existingConversation && typeof existingConversation === "object") {
        const ownerId = String(existingConversation.userId || "").trim();

        if (ownerId === session.userId) {
          if (!forceOverwrite) {
            alreadyOwnedCount += 1;
            continue;
          }
          // forceOverwrite: delete existing messages then re-import
          const existingMsgsSnap = await messagesRef.orderByChild("conversationId").equalTo(conversationId).once("value");
          const deleteOps = [];
          existingMsgsSnap.forEach(child => { deleteOps.push(child.ref.remove()); });
          await Promise.all(deleteOps);
        } else {
          skippedCount += 1;
          continue;
        }
      }

      const rawMessages = Array.isArray(safeConversation?.messages) ? safeConversation.messages : [];
      const sanitizedMessages = rawMessages
        .map((entry, index) => {
          const safeEntry = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
          const role = String(safeEntry?.role || "").trim();
          const content = typeof safeEntry?.content === "string" ? safeEntry.content : "";

          if ((role !== "user" && role !== "assistant") || !content.trim()) {
            return null;
          }

          const timestampCandidate = Number(safeEntry?.t || safeEntry?.timestamp || 0);
          const timestamp = Number.isFinite(timestampCandidate) && timestampCandidate > 0 ?
            timestampCandidate :
            Date.now() + index;

          const debugMeta = safeEntry?.debugMeta && typeof safeEntry.debugMeta === "object" && !Array.isArray(safeEntry.debugMeta) ? safeEntry.debugMeta : null;
          const stateSnapshot = safeEntry?.stateSnapshot && typeof safeEntry.stateSnapshot === "object" && !Array.isArray(safeEntry.stateSnapshot) ? safeEntry.stateSnapshot : null;

          return {
            role,
            content,
            timestamp,
            debug: Array.isArray(safeEntry?.debug) ? safeEntry.debug : [],
            debugMeta: debugMeta ? {
              topChips: Array.isArray(debugMeta.topChips) ? debugMeta.topChips : [],
              memory: typeof debugMeta.memory === "string" ? debugMeta.memory : "",
              directivityText: typeof debugMeta.directivityText === "string" ? debugMeta.directivityText : "",
              conversationState: typeof debugMeta.conversationState === "string" ? debugMeta.conversationState : (typeof debugMeta.conversationStateKey === "string" ? debugMeta.conversationStateKey : null),
              consecutiveNonExplorationTurns: Number.isInteger(debugMeta.consecutiveNonExplorationTurns) ? Math.max(0, debugMeta.consecutiveNonExplorationTurns) : 0,
              interpretationRejection: debugMeta.interpretationRejection === true,
              needsSoberReadjustment: debugMeta.needsSoberReadjustment === true,
              relationalAdjustmentActive: (debugMeta.relationalAdjustmentActive ?? debugMeta.relationalAdjustmentTriggered) === true,
              pipelineStages: Array.isArray(debugMeta.pipelineStages) ? debugMeta.pipelineStages.map(e => ({
                stage: typeof e?.stage === "string" ? e.stage : null,
                deltaMs: Number.isFinite(e?.deltaMs) ? e.deltaMs : null
              })).filter(e => e.stage) : [],
              explorationCalibrationLevel: Number.isInteger(debugMeta.explorationCalibrationLevel) ? debugMeta.explorationCalibrationLevel : null,
              explorationSignal: typeof debugMeta.explorationSignal === "string" ? debugMeta.explorationSignal : null,
              memoryRewriteIntent: debugMeta.memoryRewriteIntent && typeof debugMeta.memoryRewriteIntent === "object" ? {
                compressionRequested: debugMeta.memoryRewriteIntent.compressionRequested === true,
                interpretationRejectionActive: debugMeta.memoryRewriteIntent.interpretationRejectionActive === true,
                rejectsUnderlyingPhenomenon: debugMeta.memoryRewriteIntent.rejectsUnderlyingPhenomenon === true,
                soberReadjustmentActive: debugMeta.memoryRewriteIntent.soberReadjustmentActive === true,
                lectureBotForcedReset: debugMeta.memoryRewriteIntent.lectureBotForcedReset === true
              } : null,
              memoryCompressed: debugMeta.memoryCompressed === true,
              memoryBeforeCompression: typeof debugMeta.memoryBeforeCompression === "string" ? debugMeta.memoryBeforeCompression : null,
              criticTriggered: debugMeta.criticTriggered === true,
              criticIssues: Array.isArray(debugMeta.criticIssues) ? debugMeta.criticIssues.map(v => String(v || "")).filter(Boolean) : [],
              criticOriginalReply: typeof debugMeta.criticOriginalReply === "string" ? debugMeta.criticOriginalReply : null,
              conversationState: typeof debugMeta.conversationState === "string" ? debugMeta.conversationState : null,
              intent: typeof debugMeta.intent === "string" ? debugMeta.intent : null,
              forbidden: Array.isArray(debugMeta.forbidden) ? debugMeta.forbidden.map(v => String(v || "")).filter(Boolean) : [],
              confidenceSignal: typeof debugMeta.confidenceSignal === "number" ? Math.max(0, Math.min(1, debugMeta.confidenceSignal)) : 1.0,
              responseRegister: typeof debugMeta.responseRegister === "string" ? debugMeta.responseRegister : null,
              phraseLengthPolicy: typeof debugMeta.phraseLengthPolicy === "string" ? debugMeta.phraseLengthPolicy : null,
              relancePolicy: typeof debugMeta.relancePolicy === "string" ? debugMeta.relancePolicy : null,
              somaticFocusPolicy: typeof debugMeta.somaticFocusPolicy === "string" ? debugMeta.somaticFocusPolicy : null,
              actionCollapseGuardActive: debugMeta.actionCollapseGuardActive === true,
              stateTransitionFrom: typeof debugMeta.stateTransitionFrom === "string" ? debugMeta.stateTransitionFrom : null,
              stateTransitionValid: debugMeta.stateTransitionValid !== false,
              stateTransitionRequested: typeof debugMeta.stateTransitionRequested === "string" ? debugMeta.stateTransitionRequested : null,
              allianceSignal: typeof debugMeta.allianceSignal === "string" ? debugMeta.allianceSignal : null,
              engagementLevel: typeof debugMeta.engagementLevel === "string" ? debugMeta.engagementLevel : null,
              stagnationTurns: Number.isInteger(debugMeta.stagnationTurns) ? Math.max(0, debugMeta.stagnationTurns) : 0,
              processingWindow: typeof debugMeta.processingWindow === "string" ? debugMeta.processingWindow : null,
              dependencyRiskScore: Number.isFinite(debugMeta.dependencyRiskScore) ? Math.max(0, Math.min(100, Math.round(Number(debugMeta.dependencyRiskScore)))) : 0,
              dependencyRiskLevel: typeof debugMeta.dependencyRiskLevel === "string" ? debugMeta.dependencyRiskLevel : null,
              externalSupportMode: typeof debugMeta.externalSupportMode === "string" ? debugMeta.externalSupportMode : null,
              closureIntent: debugMeta.closureIntent === true,
              infoRoutingSource: typeof debugMeta.infoRoutingSource === "string" ? debugMeta.infoRoutingSource : null,
              modelConflict: debugMeta.modelConflict === true,
              humanFieldRisk: debugMeta.humanFieldRisk === true,
              humanFieldOriginalReply: typeof debugMeta.humanFieldOriginalReply === "string" ? debugMeta.humanFieldOriginalReply : null,
            } : null,
            stateSnapshot: stateSnapshot ? {
              memory: typeof stateSnapshot.memory === "string" ? normalizeMemory(stateSnapshot.memory, buildDefaultPromptRegistry()) : "",
              flags: normalizeSessionFlags(stateSnapshot.flags || {})
            } : null
          };
        })
        .filter(Boolean);

      const normalizedMemory = normalizeMemory(
        typeof safeConversation?.memory === "string" ? safeConversation.memory : "",
        buildDefaultPromptRegistry()
      );
      const normalizedFlags = normalizeSessionFlags(safeConversation?.flags || {});
      const conversationIsPrivate = safeConversation?.isPrivate === true;

      const updatedAtCandidate = Number(safeConversation?.updatedAt || 0);
      const updatedAtIso = Number.isFinite(updatedAtCandidate) && updatedAtCandidate > 0 ?
        new Date(updatedAtCandidate).toISOString() :
        new Date().toISOString();

      const firstUserMessage = sanitizedMessages.find(item => item.role === "user");
      const lastUserMessage = [...sanitizedMessages].reverse().find(item => item.role === "user");
      const fallbackTitle = lastUserMessage?.content?.slice(0, 60) || firstUserMessage?.content?.slice(0, 60) || "Conversation sans titre";
      const rawTitle = typeof safeConversation?.title === "string" ? safeConversation.title.trim() : "";

      await convRef.set({
        userId: session.userId,
        title: rawTitle || fallbackTitle,
        titleLocked: safeConversation?.isCustomTitle === true,
        messageCount: sanitizedMessages.length,
        lastUserMessage: lastUserMessage?.content || "",
        memory: normalizedMemory,
        flags: normalizedFlags,
        importedFromLocal: true,
        importedFromLocalPrivate: conversationIsPrivate,
        createdAt: updatedAtIso,
        updatedAt: updatedAtIso
      });

      const pushedMessageIds = [];
      for (const message of sanitizedMessages) {
        const pushRef = await messagesRef.push({
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
          userId: session.userId,
          conversationId,
          debug: message.debug,
          debugMeta: message.debugMeta,
          stateSnapshot: message.stateSnapshot
        });
        pushedMessageIds.push(pushRef.key);
      }

      importedConversationIds.push(conversationId);
      messageIdsByConversation[conversationId] = pushedMessageIds;
    }

    return res.json({
      success: true,
      importedConversationIds,
      importedCount: importedConversationIds.length,
      alreadyOwnedCount,
      skippedCount,
      messageIdsByConversation
    });
  } catch (err) {
    console.error("Erreur /api/account/conversations/import-local:", err.message);
    return res.status(500).json({ error: "Local conversation import failed" });
  }
});

app.get("/api/branches", async (req, res) => {
  try {
    const actorUserId = await resolveBranchActorUserId(req);

    if (!actorUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const snapshot = await branchRecordsRef
      .orderByChild("userId")
      .equalTo(actorUserId)
      .limitToLast(100)
      .once("value");

    const raw = snapshot.val() || {};
    const branches = Object.entries(raw)
      .map(([id, item]) => ({
        id,
        sourceConversationId: String(item?.sourceConversationId || ""),
        sourceAnchorMessageId: String(item?.sourceAnchorMessageId || ""),
        branchConversationId: String(item?.branchConversationId || ""),
        seedMessageCount: Number(item?.seedMessageCount) || 0,
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : null,
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : null,
        activatedAt: typeof item?.activatedAt === "string" ? item.activatedAt : null,
        status: String(item?.status || "active")
      }))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

    return res.json({ branches });
  } catch (err) {
    console.error("Erreur /api/branches:", err.message);
    return res.status(500).json({ error: "Branches lookup failed" });
  }
});

app.post("/api/branches/from-message", async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      typeof req.body.sourceConversationId !== "string" ||
      (req.body.anchorMessageId !== undefined && typeof req.body.anchorMessageId !== "string") ||
      (req.body.seedMessages !== undefined && !Array.isArray(req.body.seedMessages)) ||
      (req.body.userId !== undefined && typeof req.body.userId !== "string")
    ) {
      return res.status(400).json({ error: "Invalid branch request" });
    }

    const actorUserId = await resolveBranchActorUserId(req);
    const sourceConversationId = String(req.body.sourceConversationId || "").trim();
    const anchorMessageId = String(req.body.anchorMessageId || "").trim();
    const requestedSeedMessages = Array.isArray(req.body.seedMessages) ? req.body.seedMessages : null;

    if (!sourceConversationId || !actorUserId) {
      return res.status(400).json({ error: "Missing sourceConversationId or userId" });
    }

    const conversationSnap = await db.ref("conversations").child(sourceConversationId).once("value");
    const sourceConversation = conversationSnap.val();

    if (!sourceConversation || typeof sourceConversation !== "object") {
      return res.status(404).json({ error: "Source conversation not found" });
    }

    if (String(sourceConversation.userId || "") !== actorUserId) {
      return res.status(403).json({ error: "Conversation ownership mismatch" });
    }

    const messagesSnap = await messagesRef
      .orderByChild("conversationId")
      .equalTo(sourceConversationId)
      .once("value");

    const rawMessages = messagesSnap.val() || {};
    const messageEntries = Object.entries(rawMessages)
      .map(([id, item]) => ({
        id,
        item: item && typeof item === "object" ? item : {}
      }))
      .sort((a, b) => {
        const aDate = String(a.item.createdAt || "");
        const bDate = String(b.item.createdAt || "");
        if (aDate && bDate && aDate !== bDate) {
          return aDate.localeCompare(bDate);
        }
        return String(a.id).localeCompare(String(b.id));
      });

    let seededMessages = [];
    let resolvedAnchorMessageId = anchorMessageId;

    if (anchorMessageId) {
      const anchorIndex = messageEntries.findIndex(entry => entry.id === anchorMessageId);

      if (anchorIndex < 0) {
        return res.status(404).json({ error: "Anchor message not found" });
      }

      const seededEntries = messageEntries.slice(0, anchorIndex + 1);
      seededMessages = seededEntries.map(entry => ({
        id: entry.id,
        role: String(entry.item.role || ""),
        content: String(entry.item.content || ""),
        debug: Array.isArray(entry.item.debug) ? entry.item.debug : [],
        debugMeta: entry.item.debugMeta && typeof entry.item.debugMeta === "object" ? entry.item.debugMeta : null,
        stateSnapshot: entry.item.stateSnapshot && typeof entry.item.stateSnapshot === "object" ? {
          memory: typeof entry.item.stateSnapshot.memory === "string" ? entry.item.stateSnapshot.memory : "",
          flags: normalizeSessionFlags(entry.item.stateSnapshot.flags || {})
        } : null,
        createdAt: typeof entry.item.createdAt === "string" ? entry.item.createdAt : null
      }));
    } else {
      seededMessages = (requestedSeedMessages || [])
        .map(item => ({
          id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : null,
          role: String(item?.role || ""),
          content: String(item?.content || ""),
          debug: Array.isArray(item?.debug) ? item.debug : [],
          debugMeta: item?.debugMeta && typeof item.debugMeta === "object" ? item.debugMeta : null,
          stateSnapshot: item?.stateSnapshot && typeof item.stateSnapshot === "object" ? {
            memory: typeof item.stateSnapshot.memory === "string" ? item.stateSnapshot.memory : "",
            flags: normalizeSessionFlags(item.stateSnapshot.flags || {})
          } : null,
          createdAt: typeof item?.createdAt === "string" ? item.createdAt : null
        }))
        .filter(item => item.role && item.content);

      resolvedAnchorMessageId = String(
        [...seededMessages].reverse().find(item => typeof item?.id === "string" && item.id.trim())?.id || ""
      ).trim();
    }

    const now = new Date().toISOString();
    const branchConversationId = `c_branch_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const branchRef = branchRecordsRef.push();
    const branchId = branchRef.key;

    if (!branchId) {
      return res.status(500).json({ error: "Failed to create branch id" });
    }

    await Promise.all([
      branchRef.set({
        userId: actorUserId,
        sourceConversationId,
        sourceAnchorMessageId: resolvedAnchorMessageId,
        branchConversationId,
        seedMessageCount: seededMessages.length,
        status: "active",
        createdAt: now,
        updatedAt: now
      }),
      branchSeedSnapshotsRef.child(branchId).set({
        sourceConversationId,
        sourceAnchorMessageId: resolvedAnchorMessageId,
        seededAt: now,
        messages: seededMessages
      })
    ]);

    return res.status(201).json({
      success: true,
      branch: {
        id: branchId,
        sourceConversationId,
        sourceAnchorMessageId: resolvedAnchorMessageId,
        branchConversationId,
        seedMessageCount: seededMessages.length,
        createdAt: now,
        status: "active"
      }
    });
  } catch (err) {
    console.error("Erreur /api/branches/from-message:", err.message);
    return res.status(500).json({ error: "Branch creation failed" });
  }
});

app.post("/api/branches/create-and-activate", async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      typeof req.body.sourceConversationId !== "string" ||
      (req.body.anchorMessageId !== undefined && typeof req.body.anchorMessageId !== "string") ||
      (req.body.seedMessages !== undefined && !Array.isArray(req.body.seedMessages)) ||
      (req.body.userId !== undefined && typeof req.body.userId !== "string") ||
      (req.body.flags !== undefined && (typeof req.body.flags !== "object" || req.body.flags === null || Array.isArray(req.body.flags)))
    ) {
      return res.status(400).json({ error: "Invalid branch request" });
    }

    const actorUserId = await resolveBranchActorUserId(req);
    const sourceConversationId = String(req.body.sourceConversationId || "").trim();
    const anchorMessageId = String(req.body.anchorMessageId || "").trim();
    const requestedSeedMessages = Array.isArray(req.body.seedMessages) ? req.body.seedMessages : null;

    if (!sourceConversationId || !actorUserId) {
      return res.status(400).json({ error: "Missing sourceConversationId or userId" });
    }

    const requestedBranchMemory = typeof req.body?.memory === "string" && req.body.memory.trim() ?
      normalizeMemory(req.body.memory, buildDefaultPromptRegistry()) :
      "";
    const requestedBranchFlags = req.body?.flags !== undefined ?
      normalizeSessionFlags(req.body.flags) :
      null;

    const [conversationSnap, messagesSnap] = await Promise.all([
      db.ref("conversations").child(sourceConversationId).once("value"),
      messagesRef.orderByChild("conversationId").equalTo(sourceConversationId).once("value")
    ]);

    const sourceConversation = conversationSnap.val();
    if (!sourceConversation || typeof sourceConversation !== "object") {
      return res.status(404).json({ error: "Source conversation not found" });
    }

    if (String(sourceConversation.userId || "") !== actorUserId) {
      return res.status(403).json({ error: "Conversation ownership mismatch" });
    }

    const rawMessages = messagesSnap.val() || {};
    const messageEntries = Object.entries(rawMessages)
      .map(([id, item]) => ({
        id,
        item: item && typeof item === "object" ? item : {}
      }))
      .sort((a, b) => {
        const aDate = String(a.item.createdAt || "");
        const bDate = String(b.item.createdAt || "");
        if (aDate && bDate && aDate !== bDate) return aDate.localeCompare(bDate);
        return String(a.id).localeCompare(String(b.id));
      });

    let seededMessages = [];
    let resolvedAnchorMessageId = anchorMessageId;

    if (anchorMessageId) {
      const anchorIndex = messageEntries.findIndex(entry => entry.id === anchorMessageId);
      if (anchorIndex < 0) {
        return res.status(404).json({ error: "Anchor message not found" });
      }
      seededMessages = messageEntries.slice(0, anchorIndex + 1).map(entry => ({
        id: entry.id,
        role: String(entry.item.role || ""),
        content: String(entry.item.content || ""),
        debug: Array.isArray(entry.item.debug) ? entry.item.debug : [],
        debugMeta: entry.item.debugMeta && typeof entry.item.debugMeta === "object" ? entry.item.debugMeta : null,
        stateSnapshot: entry.item.stateSnapshot && typeof entry.item.stateSnapshot === "object" ? {
          memory: typeof entry.item.stateSnapshot.memory === "string" ? entry.item.stateSnapshot.memory : "",
          flags: normalizeSessionFlags(entry.item.stateSnapshot.flags || {})
        } : null,
        createdAt: typeof entry.item.createdAt === "string" ? entry.item.createdAt : null
      }));
    } else {
      seededMessages = (requestedSeedMessages || [])
        .map(item => ({
          id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : null,
          role: String(item?.role || ""),
          content: String(item?.content || ""),
          debug: Array.isArray(item?.debug) ? item.debug : [],
          debugMeta: item?.debugMeta && typeof item.debugMeta === "object" ? item.debugMeta : null,
          stateSnapshot: item?.stateSnapshot && typeof item.stateSnapshot === "object" ? {
            memory: typeof item.stateSnapshot.memory === "string" ? item.stateSnapshot.memory : "",
            flags: normalizeSessionFlags(item.stateSnapshot.flags || {})
          } : null,
          createdAt: typeof item?.createdAt === "string" ? item.createdAt : null
        }))
        .filter(item => item.role && item.content);

      resolvedAnchorMessageId = String(
        [...seededMessages].reverse().find(item => typeof item?.id === "string" && item.id.trim())?.id || ""
      ).trim();
    }

    const now = new Date().toISOString();
    const branchConversationId = `c_branch_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const branchRef = branchRecordsRef.push();
    const branchId = branchRef.key;

    if (!branchId) {
      return res.status(500).json({ error: "Failed to create branch id" });
    }

    const sourceConversationTitle = String(sourceConversation.title || "").trim();

    const lastUserMessage = [...seededMessages].reverse().find(m => String(m?.role || "") === "user");

    await Promise.all([
      branchRef.set({
        userId: actorUserId,
        sourceConversationId,
        sourceAnchorMessageId: resolvedAnchorMessageId,
        branchConversationId,
        seedMessageCount: seededMessages.length,
        status: "active",
        createdAt: now,
        updatedAt: now,
        activatedAt: now
      }),
      branchSeedSnapshotsRef.child(branchId).set({
        sourceConversationId,
        sourceAnchorMessageId: resolvedAnchorMessageId,
        seededAt: now,
        messages: seededMessages
      }),
      db.ref("conversations").child(branchConversationId).set({
        userId: actorUserId,
        isBranch: true,
        sourceConversationId,
        createdAt: now,
        updatedAt: now,
        title: sourceConversationTitle || `Branche de ${sourceConversationId}`,
        titleLocked: false,
        messageCount: seededMessages.filter(m => String(m?.role || "") === "user").length,
        lastUserMessage: lastUserMessage ? String(lastUserMessage.content || "") : "",
        memory: requestedBranchMemory,
        flags: requestedBranchFlags || normalizeSessionFlags({})
      })
    ]);

    if (seededMessages.length > 0) {
      await Promise.all(
        seededMessages.map((message, index) => {
          const timestampBase = Date.now();
          return messagesRef.push({
            role: String(message?.role || ""),
            content: String(message?.content || ""),
            timestamp: timestampBase + index,
            userId: actorUserId,
            conversationId: branchConversationId,
            debug: Array.isArray(message?.debug) ? message.debug : [],
            debugMeta: message?.debugMeta && typeof message.debugMeta === "object" ? message.debugMeta : null,
            branchId,
            sourceMessageId: typeof message?.id === "string" ? message.id : null
          });
        })
      );
    }

    return res.status(201).json({
      success: true,
      branch: {
        id: branchId,
        sourceConversationId,
        sourceAnchorMessageId: resolvedAnchorMessageId,
        branchConversationId,
        seedMessageCount: seededMessages.length,
        createdAt: now,
        status: "active",
        activatedAt: now
      },
      memory: requestedBranchMemory,
      flags: requestedBranchFlags !== null ? requestedBranchFlags : undefined
    });
  } catch (err) {
    console.error("Erreur /api/branches/create-and-activate:", err.message);
    return res.status(500).json({ error: "Branch create-and-activate failed" });
  }
});

// Store feedback (thumbUp/thumbDown + optional comment) on an existing message.
// If devShare is false, the call should not reach this endpoint � frontend handles locally only.
app.post("/api/messages/:id/feedback", async (req, res) => {
  try {
    const messageId = String(req.params?.id || "").trim();
    if (!messageId) {
      return res.status(400).json({ error: "Missing messageId" });
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const type = req.body.type;
    if (type !== "thumbUp" && type !== "thumbDown") {
      return res.status(400).json({ error: "type must be thumbUp or thumbDown" });
    }

    const rawComment = typeof req.body.comment === "string" ? req.body.comment.trim() : "";
    const comment = rawComment.slice(0, 1000); // Bound comment length
    const devShare = req.body.devShare === true;
    const userId = typeof req.body.userId === "string" ? req.body.userId.trim() : "";

    const messageSnap = await messagesRef.child(messageId).once("value");
    if (!messageSnap.exists()) {
      return res.status(404).json({ error: "Message not found" });
    }

    const messageData = messageSnap.val();
    // Allow feedback on both user and assistant messages, but only if conversationId present
    if (!messageData || typeof messageData.conversationId !== "string") {
      return res.status(400).json({ error: "Message has no conversationId" });
    }

    const feedback = {
      type,
      comment: comment || null,
      devShare,
      userId: userId || null,
      timestamp: Date.now()
    };

    await messagesRef.child(messageId).update({ feedback });

    console.log("[FEEDBACK]", { messageId, type, devShare, userId: userId || "anon" });
    return res.json({ success: true, messageId, feedback });
  } catch (err) {
    console.error("Erreur /api/messages/:id/feedback:", err.message);
    return res.status(500).json({ error: "Feedback failed" });
  }
});

// Create a non-private snapshot branch containing only the target user+bot pair,
// then attach feedback to the bot message in that snapshot.
// Used when the source conversation is private and the user wants to share feedback.
app.post("/api/branches/feedback-snapshot", async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const type = req.body.type;
    if (type !== "thumbUp" && type !== "thumbDown") {
      return res.status(400).json({ error: "type must be thumbUp or thumbDown" });
    }

    const rawComment = typeof req.body.comment === "string" ? req.body.comment.trim() : "";
    const comment = rawComment.slice(0, 1000);
    const devShare = req.body.devShare === true;
    const userId = typeof req.body.userId === "string" ? req.body.userId.trim() : "";

    // The frontend sends the raw user + bot message content when from a private conversation
    const userContent = typeof req.body.userContent === "string" ? req.body.userContent.trim() : "";
    const botContent = typeof req.body.botContent === "string" ? req.body.botContent.trim() : "";

    if (!userContent || !botContent) {
      return res.status(400).json({ error: "Missing userContent or botContent" });
    }

    const now = new Date().toISOString();
    const snapshotConversationId = "c_fbsnap_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    // Create a non-private conversation to hold the snapshot
    await db.ref("conversations").child(snapshotConversationId).set({
      userId: userId || "u_anon",
      createdAt: now,
      updatedAt: now,
      title: "Feedback snapshot",
      titleLocked: true,
      messageCount: 2,
      feedbackSnapshot: true,
      isPrivate: false
    });

    // Push user message then bot message
    const timestampBase = Date.now();
    const userMsgRef = await messagesRef.push({
      role: "user",
      content: userContent,
      timestamp: timestampBase,
      userId: userId || "u_anon",
      conversationId: snapshotConversationId,
      feedbackSnapshot: true
    });

    const botMsgRef = await messagesRef.push({
      role: "assistant",
      content: botContent,
      timestamp: timestampBase + 1,
      userId: userId || "u_anon",
      conversationId: snapshotConversationId,
      feedbackSnapshot: true,
      feedback: {
        type,
        comment: comment || null,
        devShare,
        userId: userId || null,
        timestamp: Date.now()
      }
    });

    console.log("[FEEDBACK_SNAPSHOT]", {
      snapshotConversationId,
      type,
      devShare,
      userId: userId || "anon"
    });

    return res.status(201).json({
      success: true,
      snapshotConversationId,
      userMessageId: userMsgRef.key,
      botMessageId: botMsgRef.key
    });
  } catch (err) {
    console.error("Erreur /api/branches/feedback-snapshot:", err.message);
    return res.status(500).json({ error: "Feedback snapshot failed" });
  }
});

app.post("/api/branches/:id/activate", async (req, res) => {
  try {
    const branchId = String(req.params?.id || "").trim();
    const actorUserId = await resolveBranchActorUserId(req);

    if (
      req.body !== undefined &&
      (typeof req.body !== "object" || req.body === null || Array.isArray(req.body))
    ) {
      return res.status(400).json({ error: "Invalid branch activation payload" });
    }

    if (
      req.body?.flags !== undefined &&
      (typeof req.body.flags !== "object" || req.body.flags === null || Array.isArray(req.body.flags))
    ) {
      return res.status(400).json({ error: "Invalid branch flags payload" });
    }

    if (req.body?.userId !== undefined && typeof req.body.userId !== "string") {
      return res.status(400).json({ error: "Invalid branch user id payload" });
    }

    if (!branchId || !actorUserId) {
      return res.status(400).json({ error: "Invalid branch id" });
    }

    const requestedBranchMemory = typeof req.body?.memory === "string" && req.body.memory.trim() ?
      normalizeMemory(req.body.memory, buildDefaultPromptRegistry()) :
      "";
    const requestedBranchFlags = req.body?.flags !== undefined ?
      normalizeSessionFlags(req.body.flags) :
      null;

    const branchRef = branchRecordsRef.child(branchId);
    const [branchSnap, seedSnap] = await Promise.all([
      branchRef.once("value"),
      branchSeedSnapshotsRef.child(branchId).once("value")
    ]);

    const branch = branchSnap.val();
    const seed = seedSnap.val();

    if (!branch || typeof branch !== "object") {
      return res.status(404).json({ error: "Branch not found" });
    }

    if (String(branch.userId || "") !== actorUserId) {
      return res.status(403).json({ error: "Branch ownership mismatch" });
    }

    let seedMessages = (seed && typeof seed === "object" && Array.isArray(seed.messages)) ?
      seed.messages :
      null;

    if (!Array.isArray(seedMessages)) {
      seedMessages = [];
      await branchSeedSnapshotsRef.child(branchId).set({
        sourceConversationId: String(branch.sourceConversationId || ""),
        sourceAnchorMessageId: String(branch.sourceAnchorMessageId || ""),
        seededAt: new Date().toISOString(),
        messages: seedMessages
      });
    }

    const branchConversationId = String(branch.branchConversationId || "").trim();
    if (!branchConversationId) {
      return res.status(500).json({ error: "Missing branch conversation id" });
    }

    const convRef = db.ref("conversations").child(branchConversationId);
    const existingConvSnap = await convRef.once("value");
    const existingConversation = existingConvSnap.val();

    if (!existingConversation || typeof existingConversation !== "object") {
      let sourceConversationTitle = "";
      const sourceConversationId = String(branch.sourceConversationId || "").trim();

      if (sourceConversationId) {
        const sourceConvSnap = await db.ref("conversations").child(sourceConversationId).once("value");
        const sourceConversation = sourceConvSnap.val();
        if (sourceConversation && typeof sourceConversation === "object") {
          sourceConversationTitle = String(sourceConversation.title || "").trim();
        }
      }

      const lastUserMessage = [...seedMessages]
        .reverse()
        .find(m => String(m?.role || "") === "user");
      const now = new Date().toISOString();

      await convRef.set({
        userId: actorUserId,
        isBranch: true,
        sourceConversationId: String(branch.sourceConversationId || ""),
        createdAt: now,
        updatedAt: now,
        title: sourceConversationTitle || `Branche de ${String(branch.sourceConversationId || "conversation")}`,
        titleLocked: false,
        messageCount: seedMessages.filter(m => String(m?.role || "") === "user").length,
        lastUserMessage: lastUserMessage ? String(lastUserMessage.content || "") : "",
        memory: requestedBranchMemory,
        flags: requestedBranchFlags || normalizeSessionFlags({})
      });

      // Seed all historical messages into the new conversation once.
      await Promise.all(
        seedMessages.map((message, index) => {
          const timestampBase = Date.now();
          return messagesRef.push({
            role: String(message?.role || ""),
            content: String(message?.content || ""),
            timestamp: timestampBase + index,
            userId: actorUserId,
            conversationId: branchConversationId,
            debug: Array.isArray(message?.debug) ? message.debug : [],
            debugMeta: message?.debugMeta && typeof message.debugMeta === "object" ? message.debugMeta : null,
            branchId,
            sourceMessageId: typeof message?.id === "string" ? message.id : null
          });
        })
      );
    }

    const conversationStatePatch = {
      updatedAt: new Date().toISOString()
    };

    if (requestedBranchMemory) {
      conversationStatePatch.memory = requestedBranchMemory;
    }

    if (requestedBranchFlags !== null) {
      conversationStatePatch.flags = requestedBranchFlags;
    }

    await convRef.update(conversationStatePatch);

    const activatedAt = new Date().toISOString();
    await branchRef.update({
      status: "active",
      activatedAt,
      updatedAt: activatedAt
    });

    return res.json({
      success: true,
      branch: {
        id: branchId,
        branchConversationId,
        activatedAt,
        status: "active"
      },
      memory: requestedBranchMemory,
      flags: requestedBranchFlags !== null ? requestedBranchFlags : undefined
    });
  } catch (err) {
    console.error("Erreur /api/branches/:id/activate:", err.message);
    return res.status(500).json({ error: "Branch activation failed" });
  }
});

// Fetch a single branch record + seed messages (for cross-device resume).
app.get("/api/branches/:id", async (req, res) => {
  try {
    const branchId = String(req.params?.id || "").trim();
    const actorUserId = await resolveBranchActorUserId(req);

    if (!branchId || !actorUserId) {
      return res.status(400).json({ error: "Invalid branch id" });
    }

    const [branchSnap, seedSnap] = await Promise.all([
      branchRecordsRef.child(branchId).once("value"),
      branchSeedSnapshotsRef.child(branchId).once("value")
    ]);

    const branch = branchSnap.val();
    const seed = seedSnap.val();

    if (!branch || typeof branch !== "object") {
      return res.status(404).json({ error: "Branch not found" });
    }

    if (String(branch.userId || "") !== actorUserId) {
      return res.status(403).json({ error: "Branch ownership mismatch" });
    }

    const safeSeedMessages = Array.isArray(seed?.messages)
      ? seed.messages.map(m => ({
          role: String(m?.role || ""),
          content: String(m?.content || ""),
          debug: Array.isArray(m?.debug) ? m.debug : [],
          debugMeta: m?.debugMeta && typeof m.debugMeta === "object" ? m.debugMeta : null,
          createdAt: typeof m?.createdAt === "string" ? m.createdAt : null
        }))
      : [];

    return res.json({
      branch: {
        id: branchId,
        sourceConversationId: String(branch.sourceConversationId || ""),
        sourceAnchorMessageId: String(branch.sourceAnchorMessageId || ""),
        branchConversationId: String(branch.branchConversationId || ""),
        seedMessageCount: Number(branch.seedMessageCount) || 0,
        status: String(branch.status || "active"),
        createdAt: typeof branch.createdAt === "string" ? branch.createdAt : null,
        activatedAt: typeof branch.activatedAt === "string" ? branch.activatedAt : null
      },
      messages: safeSeedMessages
    });
  } catch (err) {
    console.error("Erreur GET /api/branches/:id:", err.message);
    return res.status(500).json({ error: "Branch lookup failed" });
  }
});

// Intersession memory endpoints.
// GET returns the stored long-term memory for the authenticated user.
app.get("/api/intersession-memory", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const snap = await usersRef.child(session.userId).once("value");
    const userData = snap.val() || {};
    const memory = userData.intersessionMemory;
    const historyRaw = Array.isArray(userData.intersessionMemoryHistory) ? userData.intersessionMemoryHistory : [];
    return res.json({
      memory: typeof memory === "string" && memory.trim() ? memory : null,
      stableContextOnly: extractStableContextOnlyFromIntersessionMemory(memory),
      intersessionMemoryCompressed: typeof userData.intersessionMemoryCompressed === "string" && userData.intersessionMemoryCompressed.trim() ? userData.intersessionMemoryCompressed : null,
      intersessionMemoryCompressedAt: typeof userData.intersessionMemoryCompressedAt === "string" ? userData.intersessionMemoryCompressedAt : null,
      intersessionMemoryUpdatedAt: typeof userData.intersessionMemoryUpdatedAt === "string" ? userData.intersessionMemoryUpdatedAt : null,
      intersessionMemoryHistory: historyRaw.slice(0, 3).map(entry => ({
        memory: typeof entry?.memory === "string" ? entry.memory : "",
        stableContextOnly: extractStableContextOnlyFromIntersessionMemory(entry?.memory || ""),
        savedAt: typeof entry?.savedAt === "string" ? entry.savedAt : null
      }))
    });
  } catch (err) {
    console.error("Erreur GET /api/intersession-memory:", err.message);
    return res.status(500).json({ error: "Intersession memory read failed" });
  }
});

// Deterministic strip of transient session memory blocks before intersession consolidation.
// Removes "Mouvements en cours" content and the "Lecture bot" block entirely.
function stripTransientMemoryBlocksForIntersession(memoryText) {
  const lines = String(memoryText || "").split("\n");
  const result = [];
  let inTransientBlock = false;

  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (/^mouvements en cours\s*:/.test(trimmed)) {
      inTransientBlock = true;
      result.push(line); // Keep the header
      result.push("-"); // Replace content with empty marker
      continue;
    }
    if (/^lecture bot\s*:/.test(trimmed)) {
      inTransientBlock = true; // Skip header and all content
      continue;
    }
    // Any new section header exits the transient block
    if (line.trim() && !line.trim().startsWith("-") && /^[A-Za-z\u00C0-\u017E].*:/.test(line.trim())) {
      inTransientBlock = false;
    }
    if (!inTransientBlock) {
      result.push(line);
    }
  }
  return result.join("\n").trim();
}

// PUT saves the long-term memory for the authenticated user.
app.put("/api/intersession-memory", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;

    if (
      !req.body ||
      typeof req.body !== "object" ||
      typeof req.body.memory !== "string"
    ) {
      return res.status(400).json({ error: "Invalid memory payload" });
    }

    const sessionMemory = String(req.body.memory || "").slice(0, 8000);
    const strippedSessionMemory = stripTransientMemoryBlocksForIntersession(sessionMemory);
    const previousSnap = await usersRef.child(session.userId).child("intersessionMemory").once("value");
    const previousIntersessionMemory = typeof previousSnap.val() === "string" ? previousSnap.val() : "";
    const memory = await updateIntersessionMemory(
      previousIntersessionMemory,
      strippedSessionMemory,
      buildDefaultPromptRegistry()
    );

    await usersRef.child(session.userId).update({
      intersessionMemory: memory,
      intersessionMemoryUpdatedAt: new Date().toISOString()
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur PUT /api/intersession-memory:", err.message);
    if (err && (err.code === "insufficient_quota" || err.type === "insufficient_quota")) {
      return res.status(503).json({
        error: "OpenAI quota exhausted",
        code: "insufficient_quota",
        status: "service_unavailable",
        serviceUnavailable: true,
        serviceUnavailableReason: "quota_exhausted",
        userMessage: "Le service est temporairement indisponible car le quota API est epuise. Aucun nouveau message ne peut etre traite tant que ce quota n'est pas retabli. Recharge la page apres retablissement du quota."
      });
    }
    return res.status(500).json({ error: "Intersession memory save failed" });
  }
});

// POST compresses the intersession memory into a short excerpt (~500 chars).
// Skips the LLM call when the compressed version is already up to date.
app.post("/api/intersession-memory/compress", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const snap = await usersRef.child(session.userId).once("value");
    const userData = snap.val() || {};
    const intersessionMemory = userData.intersessionMemory;
    const compressedAt = userData.intersessionMemoryCompressedAt;
    const updatedAt = userData.intersessionMemoryUpdatedAt;

    // Skip if already compressed and up to date
    if (
      compressedAt && updatedAt &&
      new Date(compressedAt) >= new Date(updatedAt)
    ) {
      return res.json({ success: true, skipped: true, compressed: userData.intersessionMemoryCompressed || null });
    }

    if (!intersessionMemory || !String(intersessionMemory).trim()) {
      return res.json({ success: true, skipped: true, compressed: null });
    }

    const compressed = await compressIntersessionMemory(intersessionMemory, buildDefaultPromptRegistry());
    const now = new Date().toISOString();

    await usersRef.child(session.userId).update({
      intersessionMemoryCompressed: compressed,
      intersessionMemoryCompressedAt: now
    });

    return res.json({ success: true, compressed });
  } catch (err) {
    console.error("Erreur POST /api/intersession-memory/compress:", err.message);
    return res.status(500).json({ error: "Intersession memory compression failed" });
  }
});

// PATCH saves intersession memory directly (no LLM), archives current version, forces refresh.
app.patch("/api/intersession-memory/direct", requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    if (
      !req.body ||
      typeof req.body !== "object" ||
      typeof req.body.memory !== "string"
    ) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const newStableContextOnly = String(req.body.memory || "").slice(0, 2000);
    const now = new Date().toISOString();

    // Archive current version before overwriting
    const snap = await usersRef.child(session.userId).once("value");
    const userData = snap.val() || {};
    const currentMemory = userData.intersessionMemory;
    const currentUpdatedAt = userData.intersessionMemoryUpdatedAt;
    const currentHistory = Array.isArray(userData.intersessionMemoryHistory) ? userData.intersessionMemoryHistory : [];

    if (typeof currentMemory === "string" && currentMemory.trim()) {
      const newEntry = { memory: currentMemory, savedAt: currentUpdatedAt || now };
      const updatedHistory = [newEntry, ...currentHistory].slice(0, 3);
      await usersRef.child(session.userId).child("intersessionMemoryHistory").set(updatedHistory);
    }

    const nextMemory = mergeStableContextOnlyIntoIntersessionMemory(newStableContextOnly, currentMemory);

    await usersRef.child(session.userId).update({
      intersessionMemory: nextMemory,
      intersessionMemoryUpdatedAt: now,
      intersessionRefreshForced: true
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur PATCH /api/intersession-memory/direct:", err.message);
    return res.status(500).json({ error: "Intersession memory direct save failed" });
  }
});

// POST beacon � called by sendBeacon on pagehide / visibilitychange.
// Responds 200 immediately; consolidation runs async in the background.
// Race-condition guard: ignored if the beacon's timestamp is older than the
// intersessionMemoryUpdatedAt already stored (e.g. explicit close arrived first).
app.post("/api/session/beacon", async (req, res) => {
  // Respond immediately � sendBeacon ignores the body anyway.
  res.status(200).json({ ok: true });

  try {
    const session = await getUserSession(req);
    if (!session) return; // unauthenticated � ignore silently

    const memory = typeof req.body?.memory === "string" ? req.body.memory.slice(0, 8000) : "";
    const beaconTimestamp = typeof req.body?.timestamp === "string" ? req.body.timestamp : null;

    if (!memory.trim()) return;

    const now = new Date().toISOString();

    // Update lastActiveAt unconditionally � lightweight, no LLM.
    await usersRef.child(session.userId).update({ lastActiveAt: now });

    // Race-condition guard: skip consolidation if a more recent update already exists.
    const snap = await usersRef.child(session.userId).once("value");
    const userData = snap.val() || {};
    const storedUpdatedAt = userData.intersessionMemoryUpdatedAt;

    if (beaconTimestamp && storedUpdatedAt && new Date(storedUpdatedAt) > new Date(beaconTimestamp)) {
      // A more recent consolidation (explicit close) already happened � skip.
      return;
    }

    const strippedMemory = stripTransientMemoryBlocksForIntersession(memory);
    const previousIntersessionMemory = typeof userData.intersessionMemory === "string"
      ? userData.intersessionMemory
      : "";

    const consolidated = await updateIntersessionMemory(
      previousIntersessionMemory,
      strippedMemory,
      buildDefaultPromptRegistry()
    );

    await usersRef.child(session.userId).update({
      intersessionMemory: consolidated,
      intersessionMemoryUpdatedAt: now
    });
  } catch (err) {
    // Background processing � errors are non-critical, log and continue.
    console.error("Erreur /api/session/beacon (background):", err.message);
  }
});

// Admin route to set or remove a human-readable label for a user.
app.post("/api/admin/user-label", requireAdminAuth, async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      typeof req.body.userId !== "string" ||
      (req.body.label !== undefined && typeof req.body.label !== "string")
    ) {
      return res.status(400).json({ error: "Invalid user label request" });
    }

    const userId = req.body.userId.trim();
    const label = typeof req.body.label === "string" ? req.body.label.trim() : "";
    
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }
    
    if (!label) {
      await userLabelsRef.child(userId).remove();
      return res.json({ success: true, removed: true });
    }
    
    await userLabelsRef.child(userId).set(label);
    
    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur user-label:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/admin/users", requireAdminAuth, async (req, res) => {
  try {
    const snapshot = await usersRef.once("value");
    const raw = snapshot.val() || {};

    const users = Object.entries(raw)
      .map(([id, user]) => {
        const safeUser = user && typeof user === "object" ? user : {};
        return {
          id,
          email: normalizeEmail(safeUser.email || ""),
          createdAt: typeof safeUser.createdAt === "string" ? safeUser.createdAt : null,
          updatedAt: typeof safeUser.updatedAt === "string" ? safeUser.updatedAt : null
        };
      })
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

    return res.json({ users });
  } catch (err) {
    console.error("Erreur /api/admin/users:", err.message);
    return res.status(500).json({ error: "Users lookup failed" });
  }
});

// Route to manually set the title of a conversation and lock it.
app.post("/api/conversations/:id/title", async (req, res) => {
  try {
    if (!req.params || typeof req.params.id !== "string" || !req.params.id.trim()) {
      return res.status(400).json({ error: "Conversation invalide" });
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || typeof req.body.title !== "string") {
      return res.status(400).json({ error: "Invalid conversation title request" });
    }

    const conversationId = req.params.id;
    const title = req.body.title.trim();
    
    if (!title) {
      return res.status(400).json({ error: "Titre vide" });
    }
    
    const convRef = db.ref("conversations").child(conversationId);
    
    await convRef.update({
      title,
      titleLocked: true
    });
    
    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur update title:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// Return the title and metadata for a given conversation.
app.get("/api/conversations/:id/title", async (req, res) => {
  try {
    if (!req.params || typeof req.params.id !== "string" || !req.params.id.trim()) {
      return res.status(400).json({ error: "Conversation invalide" });
    }

    const conversationId = req.params.id;
    const snapshot = await db.ref("conversations").child(conversationId).once("value");
    const data = snapshot.val() || null;
    
    if (!data) {
      return res.status(404).json({ error: "Conversation introuvable" });
    }
    
    return res.json({
      id: conversationId,
      title: data.title || null,
      titleLocked: data.titleLocked === true,
      updatedAt: data.updatedAt || data.createdAt || null
    });
  } catch (err) {
    console.error("Erreur get conversation title:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// Admin route to read the intersession memory (non-compressed) of a specific user.
app.get("/api/admin/intersession-memory/:userId", requireAdminAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "userId requis" });
    const snap = await usersRef.child(userId).child("intersessionMemory").once("value");
    const memory = typeof snap.val() === "string" ? snap.val() : "";
    return res.json({ memory });
  } catch (err) {
    console.error("Erreur GET /api/admin/intersession-memory/:userId:", err.message);
    return res.status(500).json({ error: "Lecture m�moire inter-sessions �chou�e" });
  }
});

// Admin route to list all conversations with optional user labels.
app.get("/api/admin/conversations", requireAdminAuth, async (req, res) => {
  try {
    const [convSnap, labelsSnap] = await Promise.all([
      db.ref("conversations").once("value"),
      userLabelsRef.once("value")
    ]);
    
    const data = convSnap.val() || {};
    const labels = labelsSnap.val() || {};
    
    const conversations = Object.entries(data)
      .filter(([, value]) => value?.isBranch !== true)
      .map(([id, value]) => {
      const rawUserId = value.userId || null;
      const label = rawUserId && labels[rawUserId] ? labels[rawUserId] : null;
      
      return {
        id,
        userId: rawUserId,
        userLabel: label,
        displayUser: label || rawUserId,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt || value.createdAt,
        displayTitle: value.title || (
          value.lastUserMessage ?
          value.lastUserMessage.slice(0, 40) :
          "(sans titre)"
        ),
        messageCount: value.messageCount || 0
      };
    });
    
    conversations.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    
    res.json(conversations);
  } catch (err) {
    console.error("Erreur conversations admin:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.patch("/api/admin/conversations/:id/title", requireAdminAuth, async (req, res) => {
  try {
    if (!req.params || typeof req.params.id !== "string" || !req.params.id.trim()) {
      return res.status(400).json({ error: "Conversation invalide" });
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || (req.body.title !== null && typeof req.body.title !== "string")) {
      return res.status(400).json({ error: "Invalid conversation title request" });
    }

    const conversationId = String(req.params.id || "").trim();
    const convRef = db.ref("conversations").child(conversationId);
    const convSnap = await convRef.once("value");
    const existing = convSnap.val();

    if (!existing || typeof existing !== "object") {
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    const normalizedTitle = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 60) : "";
    const now = new Date().toISOString();

    await convRef.update({
      title: normalizedTitle || null,
      titleLocked: normalizedTitle.length > 0,
      updatedAt: now
    });

    return res.json({
      success: true,
      conversation: {
        id: conversationId,
        title: normalizedTitle || null,
        titleLocked: normalizedTitle.length > 0,
        updatedAt: now
      }
    });
  } catch (err) {
    console.error("Erreur PATCH /api/admin/conversations/:id/title:", err.message);
    return res.status(500).json({ error: "Conversation update failed" });
  }
});

app.delete("/api/admin/conversations/:id", requireAdminAuth, async (req, res) => {
  try {
    if (!req.params || typeof req.params.id !== "string" || !req.params.id.trim()) {
      return res.status(400).json({ error: "Conversation invalide" });
    }

    const conversationId = String(req.params.id || "").trim();
    const convRef = db.ref("conversations").child(conversationId);
    const convSnap = await convRef.once("value");
    const existing = convSnap.val();

    if (!existing || typeof existing !== "object") {
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    const messagesSnap = await messagesRef
      .orderByChild("conversationId")
      .equalTo(conversationId)
      .once("value");

    const messageIds = Object.keys(messagesSnap.val() || {});

    const branchSnap = await branchRecordsRef.once("value");
    const branches = branchSnap.val() || {};
    const relatedBranchIds = Object.entries(branches)
      .filter(([, value]) => {
        const sourceConversationId = String(value?.sourceConversationId || "").trim();
        const branchConversationId = String(value?.branchConversationId || "").trim();
        return sourceConversationId === conversationId || branchConversationId === conversationId;
      })
      .map(([id]) => id);

    await Promise.all([
      convRef.remove(),
      ...messageIds.map(messageId => messagesRef.child(messageId).remove()),
      ...relatedBranchIds.map(branchId => branchRecordsRef.child(branchId).remove()),
      ...relatedBranchIds.map(branchId => branchSeedSnapshotsRef.child(branchId).remove())
    ]);

    return res.json({
      success: true,
      deletedConversationId: conversationId,
      deletedMessageCount: messageIds.length,
      deletedBranchCount: relatedBranchIds.length
    });
  } catch (err) {
    console.error("Erreur DELETE /api/admin/conversations/:id:", err.message);
    return res.status(500).json({ error: "Conversation delete failed" });
  }
});

app.post("/api/admin/wipe-data", requireAdminAuth, async (req, res) => {
  try {
    const firebaseTargets = [
      "conversations",
      "messages",
      "users",
      "userLabels",
      "branches",
      "branchSeeds",
      ["pre", "miumBranches"].join(""),
      ["pre", "miumBranchSeeds"].join("")
    ];

    const results = await Promise.allSettled(
      firebaseTargets.map(target => db.ref(target).remove())
    );

    const failedTargets = results
      .map((result, index) => ({ result, target: firebaseTargets[index] }))
      .filter(entry => entry.result.status === "rejected")
      .map(entry => entry.target);

    if (failedTargets.length > 0) {
      return res.status(500).json({
        error: "Wipe Firebase incomplet",
        failedTargets
      });
    }

    return res.json({
      success: true,
      wipedTargets: firebaseTargets
    });
  } catch (err) {
    console.error("Erreur POST /api/admin/wipe-data:", err.message);
    return res.status(500).json({ error: "Wipe Firebase failed" });
  }
});

// Admin route to fetch all messages for a specific conversation.
app.get("/api/admin/conversations/:id/messages", requireAdminAuth, async (req, res) => {
  try {
    if (!req.params || typeof req.params.id !== "string" || !req.params.id.trim()) {
      return res.status(400).json({ error: "Conversation invalide" });
    }

    const conversationId = req.params.id;
    
    const [messagesSnap, labelsSnap] = await Promise.all([
      messagesRef
      .orderByChild("conversationId")
      .equalTo(conversationId)
      .once("value"),
      userLabelsRef.once("value")
    ]);
    
    const data = messagesSnap.val() || {};
    const labels = labelsSnap.val() || {};
    
    const list = Object.entries(data).map(([id, value]) => {
      const rawUserId = value.userId || null;
      const label = rawUserId && labels[rawUserId] ? labels[rawUserId] : null;

      const rawFeedback = value.feedback && typeof value.feedback === "object" ? value.feedback : null;
      const normalizedFeedback = rawFeedback ? {
        type: rawFeedback.type === "thumbUp" || rawFeedback.type === "thumbDown" ? rawFeedback.type : null,
        comment: typeof rawFeedback.comment === "string" ? rawFeedback.comment : null,
        devShare: rawFeedback.devShare === true,
        timestamp: typeof rawFeedback.timestamp === "number" ? rawFeedback.timestamp : null
      } : null;
      
      return {
        id,
        ...value,
        feedback: normalizedFeedback,
        userLabel: label,
        displayUser: label || rawUserId
      };
    }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    res.json(list);
  } catch (err) {
    console.error("Erreur messages conversation:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/admin/conversations/:id/branches", requireAdminAuth, async (req, res) => {
  try {
    if (!req.params || typeof req.params.id !== "string" || !req.params.id.trim()) {
      return res.status(400).json({ error: "Conversation invalide" });
    }

    const currentConversationId = String(req.params.id || "").trim();
    const [convSnap, branchSnap] = await Promise.all([
      db.ref("conversations").once("value"),
      branchRecordsRef.once("value")
    ]);

    const conversationsRaw = convSnap.val() || {};
    const branchesRaw = branchSnap.val() || {};

    const branches = Object.entries(branchesRaw)
      .map(([id, item]) => ({
        id,
        sourceConversationId: String(item?.sourceConversationId || "").trim(),
        sourceAnchorMessageId: String(item?.sourceAnchorMessageId || "").trim(),
        branchConversationId: String(item?.branchConversationId || "").trim(),
        seedMessageCount: Number(item?.seedMessageCount) || 0,
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : null,
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : null,
        activatedAt: typeof item?.activatedAt === "string" ? item.activatedAt : null,
        status: String(item?.status || "active")
      }))
      .filter(item => item.sourceConversationId && item.branchConversationId);

    const parentBranchByConversationId = new Map();
    const childBranchesByConversationId = new Map();

    branches.forEach(branch => {
      parentBranchByConversationId.set(branch.branchConversationId, branch);

      if (!childBranchesByConversationId.has(branch.sourceConversationId)) {
        childBranchesByConversationId.set(branch.sourceConversationId, []);
      }

      childBranchesByConversationId.get(branch.sourceConversationId).push(branch);
    });

    let rootConversationId = currentConversationId;
    const visitedAncestorIds = new Set([rootConversationId]);

    while (parentBranchByConversationId.has(rootConversationId)) {
      const parentBranch = parentBranchByConversationId.get(rootConversationId);
      const nextRootId = String(parentBranch?.sourceConversationId || "").trim();

      if (!nextRootId || visitedAncestorIds.has(nextRootId)) {
        break;
      }

      visitedAncestorIds.add(nextRootId);
      rootConversationId = nextRootId;
    }

    const relatedConversationIds = new Set([rootConversationId, currentConversationId]);
    const relevantBranches = [];
    const pendingConversationIds = [rootConversationId];
    const visitedTreeIds = new Set();

    while (pendingConversationIds.length > 0) {
      const sourceConversationId = pendingConversationIds.shift();

      if (!sourceConversationId || visitedTreeIds.has(sourceConversationId)) {
        continue;
      }

      visitedTreeIds.add(sourceConversationId);

      const children = childBranchesByConversationId.get(sourceConversationId) || [];
      children
        .slice()
        .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
        .forEach(branch => {
          relevantBranches.push(branch);
          relatedConversationIds.add(branch.sourceConversationId);
          relatedConversationIds.add(branch.branchConversationId);
          pendingConversationIds.push(branch.branchConversationId);
        });
    }

    const conversations = Array.from(relatedConversationIds)
      .filter(Boolean)
      .map(id => {
        const value = conversationsRaw[id] && typeof conversationsRaw[id] === "object" ? conversationsRaw[id] : {};
        const fallbackTitle = typeof value.lastUserMessage === "string" && value.lastUserMessage.trim() ?
          value.lastUserMessage.slice(0, 48) :
          "Conversation sans titre";

        return {
          id,
          title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : fallbackTitle,
          createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
          messageCount: Number(value.messageCount || 0)
        };
      });

    return res.json({
      rootConversationId,
      currentConversationId,
      conversations,
      branches: relevantBranches
    });
  } catch (err) {
    console.error("Erreur branches conversation admin:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// Normalize incoming /chat payload into a stable request object.
// This function keeps body parsing separated from the main pipeline logic.
function parseChatRequest(req) {
  const message = String(req.body?.message || "");
  const isEdited = req.body?.isEdited === true;
  const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
  const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId.trim() : "";
  const isPrivateConversation = req.body?.isPrivateConversation === true;
  const userId = req.body?.userId || "u_anon";
  const convRef = conversationId && !isPrivateConversation ? db.ref("conversations").child(conversationId) : null;
  const recentHistory = trimHistory(req.body?.recentHistory);
  const conversationBranchHistory = normalizeConversationBranchHistory(req.body?.conversationBranchHistory);
  const mailsEnabled = req.body?.mailsEnabled !== false;
  const logsEnabled = req.body?.logsEnabled === true;
  const adminUiActive = req.body?.adminUiActive === true;
  const titleDenyList = Array.isArray(req.body?.titleDenyList)
    ? req.body.titleDenyList
        .map(value => String(value || "").trim())
        .filter(Boolean)
        .slice(0, 200)
    : [];

  return {
    message,
    isEdited,
    requestId,
    conversationId,
    isPrivateConversation,
    userId,
    convRef,
    recentHistory,
    conversationBranchHistory,
    titleDenyList,
    mailsEnabled,
    logsEnabled,
    adminUiActive
  };
}

function validateChatRequestShape(body = {}) {
  const issues = [];

  if (!body || typeof body !== "object") {
    issues.push("body_not_object");
    return issues;
  }

  if (typeof body.message !== "string") {
    issues.push("message_not_string");
  } else if (!body.message.trim()) {
    issues.push("message_empty");
  } else if (body.message.length > 12000) {
    issues.push("message_too_long");
  }

  if (typeof body.userId !== "string" && body.userId !== undefined && body.userId !== null) {
    issues.push("userId_invalid_type");
  }

  if (body.requestId !== undefined && typeof body.requestId !== "string") {
    issues.push("requestId_invalid_type");
  }

  if (typeof body.conversationId !== "string" || !body.conversationId.trim()) {
    issues.push("conversationId_missing_or_invalid");
  }

  if (body.isPrivateConversation !== undefined && typeof body.isPrivateConversation !== "boolean") {
    issues.push("isPrivateConversation_not_boolean");
  }

  if (body.recentHistory !== undefined && !Array.isArray(body.recentHistory)) {
    issues.push("recentHistory_not_array");
  }

  if (body.conversationBranchHistory !== undefined && !Array.isArray(body.conversationBranchHistory)) {
    issues.push("conversationBranchHistory_not_array");
  }

  if (body.titleDenyList !== undefined) {
    if (!Array.isArray(body.titleDenyList)) {
      issues.push("titleDenyList_not_array");
    } else if (body.titleDenyList.some(value => typeof value !== "string")) {
      issues.push("titleDenyList_entry_not_string");
    }
  }

  if (body.memory !== undefined && typeof body.memory !== "string") {
    issues.push("memory_not_string");
  }

  if (body.flags !== undefined && (typeof body.flags !== "object" || body.flags === null || Array.isArray(body.flags))) {
    issues.push("flags_not_object");
  }

  return issues;
}

const activeChatRequests = new Map();
const CHAT_REQUEST_STALE_TTL_MS = 15 * 60 * 1000;
const activeChatProgressStreams = new Map(); // requestId -> Set(response)

function mapChatStageToProgressStep(stage = "") {
  const key = String(stage || "").trim();

  if (!key) {
    return "reading";
  }

  if (["request_destructured", "request_normalized", "suicide_analysis"].includes(key)) {
    return "reading";
  }

  if (["recall_analysis", "mode_analysis"].includes(key) || key.startsWith("analyzer_")) {
    return "understanding";
  }

  if (["reply_generation", "critic"].includes(key)) {
    return "drafting";
  }

  if (["memory_update", "persist_response"].includes(key)) {
    return "finalizing";
  }

  return "reading";
}

function writeSSEEvent(res, eventName, payload) {
  try {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {}
}

function pushChatProgressEvent(requestId, eventName, payload) {
  const safeId = String(requestId || "").trim();
  if (!safeId) return;

  const streams = activeChatProgressStreams.get(safeId);
  if (!streams || streams.size === 0) return;

  for (const res of streams) {
    writeSSEEvent(res, eventName, payload);
  }
}

function publishChatProgressStage(requestId, stage, status = "in_progress") {
  const safeId = String(requestId || "").trim();
  if (!safeId) return;

  const entry = activeChatRequests.get(safeId);
  const progressStep = mapChatStageToProgressStep(stage);

  if (entry && entry.lastProgressStep === progressStep) {
    return;
  }

  if (entry) {
    activeChatRequests.set(safeId, {
      ...entry,
      updatedAt: Date.now(),
      lastProgressStep: progressStep
    });
  }

  pushChatProgressEvent(safeId, "progress", {
    requestId: safeId,
    status,
    stage,
    progressStep,
    ts: Date.now()
  });
}

function publishChatProgressTerminal(requestId, status) {
  const safeId = String(requestId || "").trim();
  if (!safeId) return;

  pushChatProgressEvent(safeId, "progress", {
    requestId: safeId,
    status,
    stage: status,
    progressStep: status,
    ts: Date.now()
  });
}

function closeChatProgressStreams(requestId) {
  const safeId = String(requestId || "").trim();
  if (!safeId) return;

  const streams = activeChatProgressStreams.get(safeId);
  if (!streams || streams.size === 0) {
    activeChatProgressStreams.delete(safeId);
    return;
  }

  for (const res of streams) {
    try {
      res.end();
    } catch {}
  }

  activeChatProgressStreams.delete(safeId);
}

function registerActiveChatRequest(requestId, userId) {
  const safeId = String(requestId || "").trim();
  if (!safeId) return;

  activeChatRequests.set(safeId, {
    userId: String(userId || "").trim(),
    canceled: false,
    updatedAt: Date.now(),
    lastProgressStep: null
  });
}

function cancelActiveChatRequest(requestId, userId = "") {
  const safeId = String(requestId || "").trim();
  if (!safeId) return false;

  const entry = activeChatRequests.get(safeId);
  if (!entry) return false;

  const safeUserId = String(userId || "").trim();
  if (safeUserId && entry.userId && entry.userId !== safeUserId) {
    return false;
  }

  activeChatRequests.set(safeId, {
    ...entry,
    canceled: true,
    updatedAt: Date.now()
  });

  return true;
}

function isActiveChatRequestCanceled(requestId) {
  const safeId = String(requestId || "").trim();
  if (!safeId) return false;

  const entry = activeChatRequests.get(safeId);
  if (!entry) return false;
  return entry.canceled === true;
}

function finalizeActiveChatRequest(requestId) {
  const safeId = String(requestId || "").trim();
  if (!safeId) return;
  activeChatRequests.delete(safeId);
  closeChatProgressStreams(safeId);
}

function throwIfChatRequestCanceled(requestId) {
  if (isActiveChatRequestCanceled(requestId)) {
    const err = new Error("Chat request canceled");
    err.code = "chat_request_canceled";
    throw err;
  }
}

setInterval(() => {
  const cutoff = Date.now() - CHAT_REQUEST_STALE_TTL_MS;
  for (const [requestId, entry] of activeChatRequests.entries()) {
    if (!entry || Number(entry.updatedAt || 0) < cutoff) {
      finalizeActiveChatRequest(requestId);
    }
  }
}, CHAT_REQUEST_STALE_TTL_MS);

app.post("/chat/cancel", (req, res) => {
  const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";

  if (!requestId) {
    return res.status(400).json({ error: "Missing requestId" });
  }

  const canceled = cancelActiveChatRequest(requestId, userId);
  if (canceled) {
    publishChatProgressTerminal(requestId, "canceled");
  }
  return res.json({ success: true, requestId, canceled });
});

app.get("/chat/progress", (req, res) => {
  const requestId = typeof req.query?.requestId === "string" ? req.query.requestId.trim() : "";

  if (!requestId) {
    return res.status(400).json({ error: "Missing requestId" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let streams = activeChatProgressStreams.get(requestId);
  if (!streams) {
    streams = new Set();
    activeChatProgressStreams.set(requestId, streams);
  }
  streams.add(res);

  writeSSEEvent(res, "ready", {
    requestId,
    status: "connected",
    ts: Date.now()
  });

  req.on("close", () => {
    const activeStreams = activeChatProgressStreams.get(requestId);
    if (!activeStreams) return;
    activeStreams.delete(res);
    if (activeStreams.size === 0) {
      activeChatProgressStreams.delete(requestId);
    }
  });
});

// Normalize memory and session flags before executing the chat pipeline.
// The active prompt registry is used to ensure memory normalization matches
// the same prompt rules that will be applied later.
function normalizeChatMemoryAndFlags(req, activePromptRegistry) {
  const previousMemory = normalizeMemory(req.body?.memory, activePromptRegistry);
  const rawFlags = normalizeFlags(req.body?.flags);
  const flags = normalizeSessionFlags(rawFlags);

  return {
    previousMemory,
    rawFlags,
    flags
  };
}

// Main chat endpoint.
// This route orchestrates the request parsing, safety analysis, mode detection,
// response generation, memory update, and persistence of both user and assistant messages.
app.post("/chat", async (req, res) => {
  const requestData = parseChatRequest(req);
  if (requestData.logsEnabled === true) {
    console.log("CHAT INPUT conversationId:", requestData.conversationId);
  }
  const requestId = String(requestData.requestId || "").trim();
  // traceId: server-generated per-request, always present even without a client requestId.
  const traceId = requestId || `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  if (requestId) {
    registerActiveChatRequest(requestId, requestData.userId || "u_anon");
    req.on("aborted", () => {
      cancelActiveChatRequest(requestId, requestData.userId || "u_anon");
    });
  }
  
  const chatStartTime = Date.now();
  let chatLastStage = "request_parsed";
  let chatStageMarkTime = chatStartTime;
  let logsEnabledForCatch = requestData.logsEnabled === true;
  const chatStageTimings = [];
  
  function markChatStage(stage) {
    const now = Date.now();
    chatStageTimings.push({
      stage,
      deltaMs: now - chatStageMarkTime
    });
    chatStageMarkTime = now;
    chatLastStage = stage;
    publishChatProgressStage(requestId, stage, "in_progress");
  }

  function logChatDecision(event, payload = {}) {
    if (!logsEnabledForCatch) {
      return;
    }

    console.log("[CHAT][DECISION]", {
      conversationId: conversationIdForCatch,
      event,
      ...payload
    });
  }
  
  const requestIssues = validateChatRequestShape(req.body);
  if (requestIssues.length > 0) {
    publishChatProgressTerminal(requestId, "error");
    console.warn("[CHAT][REQUEST_SHAPE]", {
      conversationId: requestData.conversationId,
      issues: requestIssues
    });
    
    return res.status(400).json({
      error: "Invalid chat request",
      issues: requestIssues
    });
  }

  throwIfCanceled();
  
  const basePromptRegistryForCatch = buildDefaultPromptRegistry();
  
  // Values preserved for the fallback error path.
  // If the main pipeline fails, we still return a minimally valid response.
  let modeForCatch = "exploration_open";
  let suicideLevelForCatch = "N0";
  let previousMemoryForCatch = normalizeMemory("", basePromptRegistryForCatch);
  let flagsForCatch = normalizeSessionFlags({});
  let promptRegistryForCatch = basePromptRegistryForCatch;
  let conversationIdForCatch = requestData.conversationId;
  let userIdForCatch = requestData.userId || "u_anon";
  let convRefForCatch = requestData.convRef;
  let isPrivateConversationForCatch = requestData.isPrivateConversation === true;
  let isEditedForCatch = requestData.isEdited === true;
  let userMessagePersistedForCatch = false;
  let assistantMessagePersistedForCatch = false;
  let userMessageRefForCatch = null;

  function throwIfCanceled() {
    throwIfChatRequestCanceled(requestId);
  }

  function normalizePipelineStagesForStorage(pipelineStages) {
    if (!Array.isArray(pipelineStages)) {
      return [];
    }

    return pipelineStages
      .map((entry) => ({
        stage: typeof entry?.stage === "string" ? entry.stage : null,
        deltaMs: Number.isFinite(entry?.deltaMs) ? entry.deltaMs : null
      }))
      .filter((entry) => entry.stage);
  }

  function normalizeDebugMetaForStorage(debugMeta = {}, promptRegistry = buildDefaultPromptRegistry()) {
    const safe = debugMeta && typeof debugMeta === "object" ? debugMeta : {};

    return {
      topChips: Array.isArray(safe.topChips) ? safe.topChips.map((chip) => String(chip || "").trim()).filter(Boolean) : [],
      memory: normalizeMemory(safe.memory, promptRegistry),
      directivityText: typeof safe.directivityText === "string" ? safe.directivityText : "",
      conversationState: normalizeConversationState(safe.conversationState || safe.conversationStateKey),
      consecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(safe.consecutiveNonExplorationTurns),
      interpretationRejection: safe.interpretationRejection === true,
      needsSoberReadjustment: safe.needsSoberReadjustment === true,
      relationalAdjustmentActive: (safe.relationalAdjustmentActive ?? safe.relationalAdjustmentTriggered) === true,
      pipelineStages: normalizePipelineStagesForStorage(safe.pipelineStages),
      explorationCalibrationLevel: Number.isInteger(safe.explorationCalibrationLevel) ? clampExplorationDirectivityLevel(safe.explorationCalibrationLevel) : null,
      explorationSignal: typeof safe.explorationSignal === "string" ? safe.explorationSignal : null,
      memoryRewriteIntent: safe.memoryRewriteIntent && typeof safe.memoryRewriteIntent === "object" ? {
        compressionRequested: safe.memoryRewriteIntent.compressionRequested === true,
        interpretationRejectionActive: safe.memoryRewriteIntent.interpretationRejectionActive === true,
        rejectsUnderlyingPhenomenon: safe.memoryRewriteIntent.rejectsUnderlyingPhenomenon === true,
        soberReadjustmentActive: safe.memoryRewriteIntent.soberReadjustmentActive === true,
        lectureBotForcedReset: safe.memoryRewriteIntent.lectureBotForcedReset === true
      } : null,
      memoryCompressed: safe.memoryCompressed === true,
      memoryBeforeCompression:
        safe.memoryCompressed === true && typeof safe.memoryBeforeCompression === "string" ?
          normalizeMemory(safe.memoryBeforeCompression, promptRegistry) :
          null,
      criticTriggered: safe.criticTriggered === true,
      criticIssues: Array.isArray(safe.criticIssues) ? safe.criticIssues : [],
      criticOriginalReply: typeof safe.criticOriginalReply === "string" ? safe.criticOriginalReply : null,
      // Posture contract (V3)
      conversationState: typeof safe.conversationState === "string" ? safe.conversationState : null,
      intent: typeof safe.intent === "string" ? safe.intent : null,
      forbidden: Array.isArray(safe.forbidden) ? safe.forbidden : [],
      confidenceSignal: typeof safe.confidenceSignal === "number" ? Math.max(0, Math.min(1, safe.confidenceSignal)) : 1.0,
      stateTransitionFrom: typeof safe.stateTransitionFrom === "string" ? safe.stateTransitionFrom : null,
      stateTransitionValid: safe.stateTransitionValid !== false,
      stateTransitionRequested: typeof safe.stateTransitionRequested === "string" ? safe.stateTransitionRequested : null,
      allianceSignal: normalizeAllianceState(safe.allianceSignal),
      engagementLevel: normalizeEngagementLevel(safe.engagementLevel),
      stagnationTurns: normalizeStagnationTurns(safe.stagnationTurns),
      processingWindow: normalizeProcessingWindow(safe.processingWindow),
      dependencyRiskScore: clampDependencyRiskScore(safe.dependencyRiskScore),
      dependencyRiskLevel: normalizeDependencyRiskLevel(safe.dependencyRiskLevel),
      externalSupportMode: normalizeExternalSupportMode(safe.externalSupportMode),
      closureIntent: safe.closureIntent === true
    };
  }

  async function persistFallbackAssistantMessage(reply, debug, debugMeta = {}) {
    if (!conversationIdForCatch || isPrivateConversationForCatch) {
      return;
    }

    await messagesRef.push({
      role: "assistant",
      content: isEditedForCatch ? reply + "\n[MODIFIÉ]" : reply,
      timestamp: Date.now(),
      userId: userIdForCatch,
      conversationId: conversationIdForCatch,
      debug: Array.isArray(debug) ? debug : [],
      debugMeta: normalizeDebugMetaForStorage(debugMeta, promptRegistryForCatch)
    });

    assistantMessagePersistedForCatch = true;

    if (convRefForCatch) {
      await convRefForCatch.update({
        updatedAt: new Date().toISOString()
      });
    }
  }
  
  // Build metadata for the fallback response used in the catch block.
  // This keeps the safe error path consistent with the normal debug output format.
  function buildFallbackResponseDebugMeta({
    memory = "",
    suicideLevel = "N0",
    conversationState = "exploration_open",
    interpretationRejection = false,
    needsSoberReadjustment = false,
    relationalAdjustmentActive = false,
    isRecallRequest = false,
    explorationCalibrationLevel = null,
    explorationDirectivityLevel = 0,
    explorationRelanceWindow = [],
    explorationSignal = null,
    modelConflict = false,
    promptRegistry = buildDefaultPromptRegistry()
  } = {}) {
    return {
      topChips: buildTopChips({
        suicideLevel,
        conversationState,
        explorationSignal,
        interpretationRejection,
        isRecallRequest,
        needsSoberReadjustment,
        relationalAdjustmentActive
      }),
      memory: normalizeMemory(memory, promptRegistry),
      directivityText: buildDirectivityText({
        conversationState,
        explorationCalibrationLevel,
        explorationDirectivityLevel,
        explorationRelanceWindow
      }),
      interpretationRejection: interpretationRejection === true,
      needsSoberReadjustment: needsSoberReadjustment === true,
      relationalAdjustmentActive: relationalAdjustmentActive === true,
      pipelineStages: chatStageTimings.map((entry) => ({
        stage: typeof entry?.stage === "string" ? entry.stage : null,
        deltaMs: Number.isFinite(entry?.deltaMs) ? entry.deltaMs : null
      })).filter((entry) => entry.stage),
      explorationCalibrationLevel: explorationCalibrationLevel !== null && explorationCalibrationLevel !== undefined ?
        clampExplorationDirectivityLevel(explorationCalibrationLevel) :
        null,
      modelConflict: modelConflict === true
    };
  }
  
  try {
    const {
      message,
      isEdited,
      conversationId,
      isPrivateConversation,
      userId,
      convRef,
      recentHistory,
      conversationBranchHistory,
      titleDenyList,
      mailsEnabled,
      logsEnabled,
      adminUiActive
    } = requestData;

    conversationIdForCatch = conversationId;
    userIdForCatch = userId;
    convRefForCatch = convRef;
    isPrivateConversationForCatch = isPrivateConversation === true;
    isEditedForCatch = isEdited;
    
    logsEnabledForCatch = logsEnabled === true;
    markChatStage("request_destructured");
    throwIfCanceled();
    
    // Validate that the request is tied to a conversation.
    if (!conversationId) {
      return res.status(400).json({ error: "Missing conversationId" });
    }
    
    // Normalize memory and flags with the active registry so all later steps use the same rules.
    const activePromptRegistry = buildDefaultPromptRegistry();
    const { rawFlags, flags } = normalizeChatMemoryAndFlags(req, activePromptRegistry);
    let previousMemory = normalizeMemory(req.body?.memory, activePromptRegistry);
    const convMemoryPromise = (!isPrivateConversation && convRef)
          ? convRef.once("value").then(s => {
              const d = s.val();
              return (d && typeof d.memory === "string" && d.memory.trim()) ? d.memory : null;
            }).catch(() => null)
          : Promise.resolve(null);
        const shouldLoadUserProfile = !isPrivateConversation && userId && userId !== "u_anon";
    const userProfilePromise = shouldLoadUserProfile
      ? usersRef.child(String(userId)).once("value")
        .then((snap) => {
          const data = snap.val();
          return data && typeof data === "object" ? data : {};
        })
        .catch(() => null)
      : Promise.resolve(null);
    markChatStage("request_normalized");
    throwIfCanceled();
    
    previousMemoryForCatch = previousMemory;

    // For non-private conversations, use the memory stored in Firebase (written by the previous turn).
    // Falls back to req.body.memory if Firebase has no memory yet (first turn).
    if (!isPrivateConversation && convMemoryPromise) {
      const convMemoryFromDb = await convMemoryPromise;
      if (convMemoryFromDb) {
        previousMemory = normalizeMemory(convMemoryFromDb, activePromptRegistry);
        previousMemoryForCatch = previousMemory;
      }
    }
        flagsForCatch = flags;
    promptRegistryForCatch = activePromptRegistry;
    
    // Try to generate a conversation title if the current title is still default.
    async function maybeGenerateConversationTitle() {
      if (isPrivateConversation === true || !convRef) {
        return;
      }

      try {
        const convSnap = await convRef.once("value");
        const convData = convSnap.val() || {};
        
        if (convData.titleLocked === true) {
          return;
        }
        
        const messagesSnap = await messagesRef
          .orderByChild("conversationId")
          .equalTo(conversationId)
          .once("value");
        
        const conversationMessages = Object.values(messagesSnap.val() || {})
          .filter(m => m && typeof m.content === "string")
          .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        const userMessages = conversationMessages
          .filter(m => m.role === "user")
          .map(m => String(m.content || "").trim())
          .filter(Boolean);
        
        if (userMessages.length === 0) {
          return;
        }
        
        const currentTitle = String(convData.title || "").trim();
        const firstUserMessage = userMessages[0] || "";
        
        const shouldGenerateTitle = !currentTitle ||
          currentTitle === "Nouvelle conversation" ||
          currentTitle === "Conversation sans titre" ||
          currentTitle === "Conversation" ||
          currentTitle === firstUserMessage;
        
        if (!shouldGenerateTitle) {
          return;
        }

        let forbiddenTitles = Array.isArray(titleDenyList) ? titleDenyList.slice(0, 200) : [];

        try {
          const allConversationsSnap = await conversationsRef.once("value");
          const allConversations = allConversationsSnap.val() || {};
          const titlesFromDb = Object.entries(allConversations)
            .filter(([id, value]) => {
              if (id === conversationId) return false;
              if (!value || typeof value !== "object") return false;
              if (typeof value.deletedAt === "string" && value.deletedAt.trim()) return false;
              return String(value.userId || "") === String(userId || "");
            })
            .map(([, value]) => String(value.title || "").trim())
            .filter(Boolean);

          forbiddenTitles = [...forbiddenTitles, ...titlesFromDb];
        } catch (denyErr) {
          console.warn("Erreur chargement deny-list titres:", denyErr.message);
        }

        const generatedTitle = await generateConversationTitle(conversationMessages, {
          forbiddenTitles
        });
        
        if (!generatedTitle || !generatedTitle.trim()) {
          return;
        }
        
        await convRef.update({
          title: generatedTitle.trim(),
          updatedAt: new Date().toISOString()
        });
        
        if (logsEnabledForCatch) {
          console.log("AUTO TITLE UPDATED:", conversationId, "->", generatedTitle.trim());
        }
      } catch (titleErr) {
        console.error("Erreur auto-title /chat:", titleErr.message);
      }
    }
    
    if (!isPrivateConversation) {
      const pushedRef = await messagesRef.push({
        role: "user",
        content: isEdited ? message + "\n[MODIFIÉ]" : message,
        timestamp: Date.now(),
        userId,
        conversationId
      });

      userMessagePersistedForCatch = true;
      userMessageRefForCatch = pushedRef;
      
      await convRef.transaction(current => {
        const now = new Date().toISOString();
        
        if (!current) {
          return {
            userId,
            createdAt: now,
            updatedAt: now,
            title: null,
            titleLocked: false,
            messageCount: 1,
            lastUserMessage: message
          };
        }
        
        return {
          ...current,
          userId,
          updatedAt: now,
          messageCount: (Number(current.messageCount) || 0) + 1,
          lastUserMessage: message
        };
      });
    }

    const effectiveMailsEnabled = (mailsEnabled !== false)
      && (adminMailsCacheReady ? getCachedAdminMailsEnabled() : false);

    if (!isPrivateConversation && emailNotifier.enabled && effectiveMailsEnabled && adminVisitedSinceLastAlert && adminUiActive !== true) {
      adminVisitedSinceLastAlert = false;
      emailNotifier.sendNewMessageAlert();
    }
    
    // Persist the assistant message and attach debug metadata.
    async function persistAssistantMessage(reply, debug, debugMeta = {}, conversationState = null) {
      if (isPrivateConversation) {
        return null;
      }

      const pushedRef = await messagesRef.push({
        role: "assistant",
        content: isEdited ? reply + "\n[MODIFIÉ]" : reply,
        timestamp: Date.now(),
        userId,
        conversationId,
        debug: Array.isArray(debug) ? debug : [],
        debugMeta: normalizeDebugMetaForStorage(debugMeta, activePromptRegistry),
        stateSnapshot: conversationState && typeof conversationState === "object" ? {
          memory: typeof conversationState.memory === "string" ? normalizeMemory(conversationState.memory, activePromptRegistry) : "",
          flags: normalizeSessionFlags(conversationState.flags || {})
        } : null
      });

      assistantMessagePersistedForCatch = true;
      
      const conversationPatch = {
        updatedAt: new Date().toISOString()
      };

      if (typeof conversationState?.memory === "string") {
        conversationPatch.memory = normalizeMemory(conversationState.memory, activePromptRegistry);
      }

      if (conversationState?.flags && typeof conversationState.flags === "object") {
        conversationPatch.flags = normalizeSessionFlags(conversationState.flags);
      }

      await convRef.update(conversationPatch);

      return pushedRef.key || null;
    }

    // Fire-and-forget wrapper: generates a deterministic messageId synchronously,
    // then persists in background without blocking the response path.
    function persistAssistantMessageAsync(reply, debug, debugMeta = {}, conversationState = null) {
      if (isPrivateConversation) return null;
      const messageId = "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      persistAssistantMessage(reply, debug, debugMeta, conversationState).catch(err => {
        console.error("[PERSIST_ASYNC][FAILED]", err && err.message ? err.message : String(err));
      });
      return messageId;
    }
    
    function buildResponseDebugMeta(params) {
      return _buildResponseDebugMeta({
        ...params,
        pipelineStages: chatStageTimings,
        traceId,
        normalizeMemory: (m) => normalizeMemory(m, params.promptRegistry || activePromptRegistry)
      });
    }
    
    async function applyModelConflictPipeline({
      content = "",
      message = "",
      history = [],
      memory = "",
      promptRegistry = activePromptRegistry
    } = {}) {
      const originalContent = String(content || "").trim();
      
      if (!originalContent) {
        return {
          content: originalContent,
          modelConflict: false,
          rewriteSource: null
        };
      }
      
      const conflictAnalysis = await analyzeModelConflict(
        originalContent,
        promptRegistry
      );
      
      const modelConflict = conflictAnalysis.modelConflict === true;
      
      if (!modelConflict) {
        return {
          content: originalContent,
          modelConflict: false,
          rewriteSource: null
        };
      }
      
      const rewrittenContent = await rewriteConflictModelContent({
        message,
        history,
        memory,
        originalContent,
        promptRegistry
      });
      
      return {
        content: String(rewrittenContent || "").trim() || originalContent,
        modelConflict: true,
        rewriteSource: originalContent
      };
    }
    
    // 1) Analyse suicide : risque imm�diat et clarification possible.
    // Cette �tape peut d�clencher des r�ponses prioris�es sans aller plus loin.
    markChatStage("suicide_analysis");
    const suicide = await analyzeSuicideRisk(
      message,
      recentHistory,
      flags,
      activePromptRegistry
    );
    throwIfCanceled();

    logChatDecision("suicide_analysis_result", {
      suicideLevel: suicide.suicideLevel,
      needsClarification: suicide.needsClarification === true,
      crisisResolved: suicide.crisisResolved === true,
      acuteCrisisBefore: flags.acuteCrisis === true
    });
    suicideLevelForCatch = suicide.suicideLevel;
    
    let newFlags = normalizeSessionFlags(flags);
    newFlags.explorationCalibrationLevel = 0;

    const crisisDecision = buildCrisisRoutingDecision(suicide, flags);

    if (crisisDecision.route) {
      logChatDecision("priority_rule_selected", {
        phase: "post_suicide",
        ruleId: crisisDecision.ruleId,
        priority: crisisDecision.priority
      });
    }
    
    // Severe suicide risk override path.
    // If the analysis returns N2, we bypass normal generation and reply with a crisis response.
    if (crisisDecision.route === "n2") {
      newFlags.acuteCrisis = true;
      newFlags.dischargeState = { wasDischarge: false };
      flagsForCatch = normalizeSessionFlags(newFlags);

      logChatDecision("override_n2", {
        acuteCrisisAfter: true
      });
      
      const debug = buildDebug("override", {
        suicideLevel: "N2"
      });
      
      // N2 : g�n�ration contextualis�e via LLM avec fallback sur la r�ponse statique.
      // R�solution des num�ros d'urgence selon le pays de l'utilisateur.
      let n2PromptRegistry = activePromptRegistry;
      try {
        let userCountryCode = null;
        const userData = await userProfilePromise;
        if (userData && typeof userData.country === "string") {
          userCountryCode = normalizeCountryCode(userData.country);
        }
        // Fallback France si pays inconnu (cible principale du produit)
        const emergencyInfo = lookupEmergencyNumbers(userCountryCode) || lookupEmergencyNumbers("FR");
        const emergencyText = buildEmergencyNumbersText(emergencyInfo);
        if (emergencyText) {
          n2PromptRegistry = {
            ...activePromptRegistry,
            N2_RESPONSE_LLM: activePromptRegistry.N2_RESPONSE_LLM.replace("{{EMERGENCY_NUMBERS}}", emergencyText)
          };
        }
      } catch {
        // Non-bloquant : on continue avec les num�ros FR par d�faut si la r�solution �choue
      }

      let reply;
      try {
        const n2PostureDecision = {
          conversationState: "n2_crisis",
          detectedState: "n2_crisis",
          finalDirectivityLevel: 0,
          finalExplorationSignal: "interpretation",
          intent: "orienter vers les ressources de crise",
          forbidden: ["interpretive_hypothesis", "relance", "open_question", "exploration_hypothesis", "reflect"],
          maxSentences: 3,
          toneConstraint: "contained",
          relancePolicy: "forbidden",
          confidenceSignal: 1.0,
          responseRegister: "courant",
          phraseLengthPolicy: "courte",
          somaticFocusPolicy: "none",
          relationalAdjustmentActive: false,
          interpretationRejectionModeActive: false,
          needsSoberReadjustment: false,
          humanFieldGuardActive: false,
          formalAddress: false
        };
        const n2Result = await generateReply({
          message,
          history: recentHistory,
          memory: previousMemory,
          postureDecision: n2PostureDecision,
          promptRegistry: n2PromptRegistry
        });
        reply = n2Result.reply;
      } catch (n2Err) {
        reply = n2Response();
      }
      const responseMemory = previousMemory;
      
      const responseDebugMeta = buildResponseDebugMeta({
        memory: responseMemory,
        suicideLevel: "N2",
        conversationState: "n2_crisis",
        isRecallRequest: false,
        explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
        explorationRelanceWindow: newFlags.explorationRelanceWindow,
        rewriteSource: null,
        memoryRewriteSource: null,
        modelConflict: false,
        promptRegistry: activePromptRegistry
      });
      
      const botMessageId = persistAssistantMessageAsync(reply, debug, responseDebugMeta, { memory: responseMemory, flags: newFlags });
      maybeGenerateConversationTitle();
      publishChatProgressTerminal(requestId, "done");
      
      return res.json({
        conversationId,
        reply,
        memory: responseMemory,
        flags: newFlags,
        debug,
        debugMeta: responseDebugMeta,
        botMessageId
      });
    }
    
    // 2) Crisis follow-up path for an already active acute crisis.
    // If the crisis is not resolved, keep the bot in crisis-handling mode.
    if (flags.acuteCrisis === true) {
      if (crisisDecision.route === "acute_followup") {
        newFlags.acuteCrisis = true;
        newFlags.dischargeState = { wasDischarge: false };
        flagsForCatch = normalizeSessionFlags(newFlags);

        logChatDecision("override_acute_crisis_followup", {
          suicideLevel: suicide.suicideLevel,
          crisisResolved: false
        });
        
        const debug = buildDebug("override", {
          suicideLevel: suicide.suicideLevel
        });
        const reply = acuteCrisisFollowupResponse();
        const responseMemory = previousMemory;
        const responseDebugMeta = buildResponseDebugMeta({
          memory: responseMemory,
          suicideLevel: suicide.suicideLevel,
          mode: null,
          isRecallRequest: false,
          explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
          explorationRelanceWindow: newFlags.explorationRelanceWindow,
          rewriteSource: null,
          memoryRewriteSource: null,
          modelConflict: false,
          promptRegistry: activePromptRegistry
        });
        
        const botMessageId = persistAssistantMessageAsync(reply, debug, responseDebugMeta, { memory: responseMemory, flags: newFlags });
        maybeGenerateConversationTitle();
        publishChatProgressTerminal(requestId, "done");
        
        return res.json({
          conversationId,
          reply,
          memory: responseMemory,
          flags: newFlags,
          debug,
          debugMeta: responseDebugMeta,
          botMessageId
        });
      }
      
      newFlags.acuteCrisis = false;
      flagsForCatch = normalizeSessionFlags(newFlags);
      logChatDecision("acute_crisis_resolved", {
        suicideLevel: suicide.suicideLevel
      });
    }
    
    // 3) N1 signal flows into the main pipeline. writerMode is overridden to
    // "n1_crisis" inside buildPostureDecision; critic runs systematically.
    if (crisisDecision.route === "n1_clarification") {
      logChatDecision("n1_entering_pipeline", {
        suicideLevel: suicide.suicideLevel,
        needsClarification: suicide.needsClarification === true
      });
    }
    
    // 2) Analyse de rappel memoire : identifier si l'utilisateur demande
    // explicitement un rappel conversationnel et quelle memoire mobiliser.
    markChatStage("recall_analysis");
    const recallRoutingPromise = (async () => {
      let recallIntersessionMemory = "";
      const userData = await userProfilePromise;

      if (userData && typeof userData === "object") {
        const compressed = typeof userData.intersessionMemoryCompressed === "string"
          ? userData.intersessionMemoryCompressed.trim()
          : "";
        const raw = typeof userData.intersessionMemory === "string"
          ? userData.intersessionMemory.trim()
          : "";
        recallIntersessionMemory = compressed || raw || "";
      }

      return analyzeRecallRouting(
        message,
        recentHistory,
        previousMemory,
        recallIntersessionMemory,
        activePromptRegistry
      );
    })();

    // Phase 2: run all analyzers in parallel, including proposeState (which now
    // integrates contact detection alongside info detection).
    markChatStage("mode_analysis");
    throwIfCanceled();

    const effectiveExplorationDirectivityLevel = newFlags.explorationDirectivityLevel;

    let finalDirectivityLevel = effectiveExplorationDirectivityLevel;
    let finalExplorationSignal = "interpretation";
    const currentAttentionQualityTurnsUntilRefresh = Number.isInteger(newFlags.attentionQualityTurnsUntilRefresh)
      ? Math.max(0, newFlags.attentionQualityTurnsUntilRefresh)
      : 0;
    const shouldRunAttentionQuality = currentAttentionQualityTurnsUntilRefresh === 0;

    const currentMemoryUpdateTurnsUntilRefresh = Number.isInteger(newFlags.memoryUpdateTurnsUntilRefresh)
      ? Math.max(0, newFlags.memoryUpdateTurnsUntilRefresh)
      : 0;

    // withAnalyzerTiming wraps each Promise to record individual analyzer durations in chatStageTimings.
    function withAnalyzerTiming(name, promise) {
      const t = Date.now();
      return promise.then(result => {
        chatStageTimings.push({ stage: `analyzer_${name}`, deltaMs: Date.now() - t });
        return result;
      });
    }
    const [
      stateProposal,
      allianceRuptureAnalysis,
      relationalAdjustmentAnalysis,
      technicalContextAnalysis,
      somaticSignalAnalysis,
      userRegisterAnalysis,
      emotionalDecenteringResult,
      attentionAnalysis,
      closureAnalysis
    ] = await Promise.all([
      withAnalyzerTiming("propose_state", proposeState(message, recentHistory, newFlags.dischargeState, activePromptRegistry)),
      withAnalyzerTiming("alliance_rupture", analyzeAllianceRupture(message, recentHistory, activePromptRegistry)),
      withAnalyzerTiming("relational_adjustment", analyzeRelationalAdjustmentNeed(message, recentHistory, previousMemory, false, activePromptRegistry)),
      withAnalyzerTiming("technical_context", analyzeTechnicalContext(message)),
      withAnalyzerTiming("somatic_signal", analyzeSomaticSignal(message)),
      withAnalyzerTiming("user_register", analyzeUserRegister(message)),
      withAnalyzerTiming("emotional_decentering", analyzeEmotionalDecentering(message, recentHistory)),
      shouldRunAttentionQuality
        ? withAnalyzerTiming("attention_quality", analyzeAttentionQuality(message, recentHistory, activePromptRegistry))
        : Promise.resolve(null),
      withAnalyzerTiming("closure_intent", analyzeClosureIntent(message))
    ]);
    throwIfCanceled();

    newFlags.attentionQualityTurnsUntilRefresh = shouldRunAttentionQuality
      ? 3
      : Math.max(0, currentAttentionQualityTurnsUntilRefresh - 1);

    // Phase 2b: exploration-specific analysers — only fired when detectedState is exploration.
    // Skipped for discharge, info, and crisis states to avoid unused LLM calls.
    let calibrationAnalysis;
    let interpretationRejection;
    if (stateProposal.detectedState === "exploration") {
      [calibrationAnalysis, interpretationRejection] = await Promise.all([
        withAnalyzerTiming("exploration_calibration", analyzeExplorationCalibration({
            message,
            history: recentHistory,
            memory: previousMemory,
            explorationDirectivityLevel: effectiveExplorationDirectivityLevel,
            explorationRelanceWindow: newFlags.explorationRelanceWindow,
            promptRegistry: activePromptRegistry
          })),
        withAnalyzerTiming("interpretation_rejection", analyzeInterpretationRejection({
            message,
            history: recentHistory,
            memory: previousMemory,
            promptRegistry: activePromptRegistry
          }))
      ]);
    } else {
      calibrationAnalysis = { calibrationLevel: effectiveExplorationDirectivityLevel, explorationSignal: "interpretation" };
      interpretationRejection = { isInterpretationRejection: false, relationalFrictionSignal: "none", rejectsUnderlyingPhenomenon: false };
    }
    throwIfCanceled();

    const emotionalDecenteringAnalysis = emotionalDecenteringResult || { emotionalDecentering: false };

    const contactAnalysis = stateProposal.contactAnalysis || { isContact: false };
    const dischargeAnalysis = stateProposal.dischargeAnalysis || { aggressiveDischargeDirectedToBot: false };
    const detectedState = stateProposal.detectedState;
    newFlags.dischargeState = {
      wasDischarge: typeof detectedState === "string" && detectedState.startsWith("discharge_")
    };

    const detectedPsychoeducationType = detectedState === "info_psychoeducation"
      ? (stateProposal.psychoeducationType || null)
      : null;
    const detectedInfoContextFlags = detectedState === "info_features"
      ? (Array.isArray(stateProposal.infoContextFlags) ? stateProposal.infoContextFlags : [])
      : [];

    // Source de routage info pour observabilit� admin
    let infoRoutingSource = null;
    if (typeof detectedState === "string" && detectedState.startsWith("info_")) {
      const src = stateProposal.infoSource;
      const subSrc = stateProposal.infoSignalSource;
      if (src === "deterministic_app_features") {
        infoRoutingSource = "d�terministe";
      } else if (src === "llm_fallback") {
        infoRoutingSource = "LLM (fallback)";
      } else if (subSrc === "llm_fallback") {
        infoRoutingSource = "LLM / signal fallback";
      } else {
        infoRoutingSource = "LLM";
      }
    }
    const safeInterpretationRejection = (detectedState === "exploration")
      ? (interpretationRejection || { isInterpretationRejection: false, relationalFrictionSignal: "none" })
      : { isInterpretationRejection: false, relationalFrictionSignal: "none" };

    modeForCatch = detectedState;

    // Patch C � affiliation score window
    const affiliationScore = computeAffiliationTurnScore(message);
    const newAffiliationWindow = normalizeAffiliationWindow([...(newFlags.affiliationWindow || [0, 0, 0, 0]), affiliationScore]);
    const affiliationEstablished = computeAffiliationEstablished(newAffiliationWindow);



    const recallRouting = await recallRoutingPromise;
    throwIfCanceled();

    logChatDecision("recall_routing", {
      isRecallAttempt: recallRouting.isRecallAttempt === true,
      isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall === true,
      calledMemory: recallRouting.calledMemory || "none"
    });

    const postRecallPriorityRule = resolveChatPriorityRule({
      phase: "post_recall",
      recallRouting
    });

    if (postRecallPriorityRule) {
      logChatDecision("priority_rule_selected", {
        phase: "post_recall",
        ruleId: postRecallPriorityRule.id,
        priority: postRecallPriorityRule.priority
      });
    }

    // Recall signals flow into the main pipeline. When isRecallAttempt, a recall
    // injection block is added to the writer prompt alongside the current state.
    // recall, branch history is loaded eagerly and merged into the memory context.
    let memoryForReply = previousMemory;
    if (recallRouting.isLongTermMemoryRecall === true) {
      const recallConversationBranchHistory = await loadConversationBranchHistoryForRecall({
        conversationId,
        isPrivateConversation,
        conversationBranchHistory,
        recentHistory
      });
      const normalizedBranchHistory = normalizeConversationBranchHistory(recallConversationBranchHistory);
      const branchTranscript = normalizedBranchHistory.length > 0
        ? normalizedBranchHistory.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")
        : "(indisponible)";
      const baseMem = normalizeMemory(previousMemory, activePromptRegistry);
      memoryForReply = [
        baseMem ? `Memoire resumee :\n${baseMem}` : "",
        `Transcript complet de la branche courante :\n${branchTranscript}`
      ].filter(Boolean).join("\n\n");
    }

    if (recallRouting.isRecallAttempt === true) {
      logChatDecision("recall_entering_pipeline", {
        isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall === true,
        calledMemory: recallRouting.calledMemory || "none"
      });
    }

    // Phase 3: Deterministic arbitrator � consolidate all analyzer outputs into a
    // PostureDecision struct. No LLM calls, no side effects outside this block.
    const previousConversationState = normalizeConversationState(flags.conversationState || flags.conversationStateKey);
    const postureDecision = buildPostureDecision({
      detectedState,
      contactAnalysis,
      emotionalDecenteringAnalysis,
      affiliationWindow: newAffiliationWindow,
      affiliationEstablished,
      relationalAdjustmentAnalysis,
      calibrationAnalysis,
      technicalContextDetected: technicalContextAnalysis?.technicalContextDetected === true,
      somaticSignalAnalysis,
      userRegisterAnalysis,
      interpretationRejection: safeInterpretationRejection,
      effectiveExplorationDirectivityLevel,
      previousConversationState,
      currentConsecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(newFlags.consecutiveNonExplorationTurns),
      currentExplorationRelanceWindow: newFlags.explorationRelanceWindow,
      // Phase B structural flags � persistent fallback values (overridden by C2 per-turn analysis)
      allianceSignal: newFlags.allianceSignal,
      engagementLevel: newFlags.engagementLevel,
      stagnationTurns: newFlags.stagnationTurns,
      processingWindow: newFlags.processingWindow,
      closureIntent: newFlags.closureIntent,
      // C2 per-turn attention analysis (periodic) + rupture analysis (event-driven)
      attentionAnalysis,
      allianceRuptureAnalysis,
      // Contract inputs for confidenceSignal computation
      message,
      recentHistory,
      suicideLevel: suicide.suicideLevel,
      isRecallAttempt: recallRouting.isRecallAttempt === true,
      psychoeducationType: detectedPsychoeducationType,
      infoContextFlags: detectedInfoContextFlags,
      dischargeAnalysis,
      previousFormalAddress: newFlags.formalAddress === true,
      dependencyRiskLevel: flags.dependencyRiskLevel,
    });

    finalDirectivityLevel = postureDecision.finalDirectivityLevel;
    finalExplorationSignal = postureDecision.finalExplorationSignal;
    const { conversationState, consecutiveNonExplorationTurns } = postureDecision;

    Object.assign(newFlags, postureDecision.flagUpdates);
    flagsForCatch = normalizeSessionFlags(newFlags);

    if (postureDecision.relationalAdjustmentActive) {
      logChatDecision("relational_adjustment_caps_directivity", {
        previousLevel: postureDecision.preAdjustmentDirectivityLevel,
        cappedLevel: postureDecision.finalDirectivityLevel,
        relationalAdjustmentActive: true
      });
    }

    logChatDecision("mode_detected", {
      detectedState,
      isContact: contactAnalysis.isContact === true,
      relationalAdjustmentActive: postureDecision.relationalAdjustmentActive,
      previousWasDischarge: flags.dischargeState?.wasDischarge === true,
      currentWasDischarge: newFlags.dischargeState?.wasDischarge === true,
      previousConversationState,
      conversationState,
      consecutiveNonExplorationTurns,
      finalDirectivityLevel,
      finalExplorationSignal,
      responseRegister: postureDecision.responseRegister,
      phraseLengthPolicy: postureDecision.phraseLengthPolicy,
      relancePolicy: postureDecision.relancePolicy,
      somaticFocusPolicy: postureDecision.somaticFocusPolicy,
      actionCollapseGuardActive: postureDecision.actionCollapseGuardActive
    });

    if (postureDecision.stateTransitionValid === false) {
      console.warn("[CHAT][STATE_TRANSITION_OUT_OF_GRAPH]", {
        conversationId,
        previousConversationState: postureDecision.previousConversationState,
        requestedConversationState: postureDecision.requestedConversationState,
        enforcedConversationState: postureDecision.conversationState
      });
    }
    
    // 4) G�n�ration principale de la r�ponse selon le mode d�tect�,
    // puis application d'un pipeline de correction si le contenu est en conflit mod�le.
    markChatStage("reply_generation");

    // Blocs 3+4 : injection m�moire longue terme (intersession compress�e).
    // turnsUntilIntersessionRefresh === 0 ? injection. Sinon, d�cr�ment� chaque tour.
    // intersessionRefreshForced (Firebase) permet un refresh imm�diat apr�s �dition directe.
    let intersessionMemoryForThisTurn = "";
    if (userId && userId !== "u_anon") {
      const currentTurnsUntil = Number.isInteger(newFlags.turnsUntilIntersessionRefresh)
        ? newFlags.turnsUntilIntersessionRefresh
        : 0;
      const userData = await userProfilePromise;
      const forceRefreshNow = currentTurnsUntil > 0
        && userData
        && userData.intersessionRefreshForced === true;
      const needsInjection = currentTurnsUntil === 0 || forceRefreshNow;
      if (needsInjection) {
        const compressedVal = userData && typeof userData.intersessionMemoryCompressed === "string"
          ? userData.intersessionMemoryCompressed
          : "";
        if (compressedVal.trim()) {
          intersessionMemoryForThisTurn = compressedVal;
        }
        if (forceRefreshNow) {
          try {
            await usersRef.child(userId).update({ intersessionRefreshForced: false });
          } catch {}
        }
        newFlags.turnsUntilIntersessionRefresh = 8;
      } else {
        newFlags.turnsUntilIntersessionRefresh = Math.max(0, currentTurnsUntil - 1);
      }
    }

    const generatedBase = await generateReply({
      message,
      history: recentHistory,
      memory: recallRouting.isRecallAttempt === true ? memoryForReply : previousMemory,
      postureDecision,
      interpretationRejection: safeInterpretationRejection,
      intersessionMemoryCompressed: intersessionMemoryForThisTurn,
      promptRegistry: activePromptRegistry,
    });
    throwIfCanceled();

    let reply = generatedBase.reply;
    let relanceAnalysis = null;

    // Phase 4: Selective critic - single guardrail for exploration, discharge, and info.
    // CRITIC_PASS now covers theoretical violations. No separate conflict-model or uncertainty passes.
    // For n1_crisis, critic runs systematically regardless of heuristics.
    let criticTriggered = false;
    let criticIssues = [];
    let criticOriginalReply = null;
    let humanFieldRisk = false;
    let contractLengthExceeded = false;
    let criticTriggerReasons = [];
    const criticStateApplies = (cs) => cs && (
      cs.startsWith("exploration_") || cs.startsWith("discharge_") || cs.startsWith("info_")
    );
    const n1CrisisForced = postureDecision.conversationState === "n1_crisis";
    const recallForced = postureDecision.recallInjectionActive === true;
    const criticApplies = n1CrisisForced || recallForced || criticStateApplies(postureDecision.conversationState);
    if (criticApplies) {
      const sentenceCount = String(reply || "")
        .split(/[.!?]+/)
        .map(chunk => chunk.trim())
        .filter(Boolean).length;
      contractLengthExceeded = Number.isFinite(postureDecision.maxSentences)
        && postureDecision.maxSentences > 0
        && sentenceCount > postureDecision.maxSentences;
      humanFieldRisk = postureDecision.humanFieldGuardActive === true && isProceduralInstrumentalReply(reply);
      const formalAddressRisk = postureDecision.formalAddress === true && hasTutoiementInReply(reply);
      const vouvoiementRisk = postureDecision.formalAddress !== true && hasVouvoiementInReply(reply, message);
      const theoreticalViolationRisk = hasTheoreticalViolationHeuristic(reply);
      const criticShouldTrigger =
        n1CrisisForced ||
        recallForced ||
        contractLengthExceeded ||
        humanFieldRisk ||
        formalAddressRisk ||
        vouvoiementRisk ||
        theoreticalViolationRisk;
      criticTriggerReasons = criticShouldTrigger ? [
        ...(contractLengthExceeded ? ["contractLengthExceeded"] : []),
        ...(humanFieldRisk ? ["humanFieldRisk"] : []),
        ...(formalAddressRisk ? ["formalAddressRisk"] : []),
        ...(vouvoiementRisk ? ["vouvoiementRisk"] : []),
        ...(theoreticalViolationRisk ? ["theoreticalViolationRisk"] : []),
        ...(n1CrisisForced ? ["n1CrisisForced"] : []),
        ...(recallForced ? ["recallForced"] : []),
      ] : [];
      if (criticShouldTrigger) {
        logChatDecision("critic_triggered", {
          conversationState: postureDecision.conversationState,
          contractLengthExceeded,
          humanFieldRisk,
          sentenceCount
        });
        const t_critic = Date.now();
        const criticResult = await applySelectiveCritic({
          reply,
          message,
          history: recentHistory,
          postureDecision,
          promptRegistry: activePromptRegistry
        });
        chatStageTimings.push({ stage: "critic", deltaMs: Date.now() - t_critic });
        throwIfCanceled();
        criticTriggered = true;
        const contractForbidden = new Set(Array.isArray(postureDecision.forbidden) ? postureDecision.forbidden : []);
        const filteredCriticIssues = Array.isArray(criticResult.criticIssues)
          ? criticResult.criticIssues.filter(issue => {
            if (typeof issue !== "string") return false;
            if (!issue.startsWith("forbidden_")) return true;
            const forbiddenTerm = issue.slice("forbidden_".length);
            return contractForbidden.has(forbiddenTerm);
          })
          : [];
        criticIssues = filteredCriticIssues;
        if (filteredCriticIssues.length > 0) {
          criticOriginalReply = reply;
          reply = criticResult.reply;
          logChatDecision("critic_rewrote", {
            issueCount: filteredCriticIssues.length,
            issues: filteredCriticIssues
          });
        }
      }
    }

    if (detectedState === "exploration") {
      relanceAnalysis = await analyzeExplorationRelance({
        message,
        reply,
        history: recentHistory,
        memory: previousMemory,
        promptRegistry: activePromptRegistry
      });
      
      newFlags = registerExplorationRelance(newFlags, relanceAnalysis.isRelance === true);
      flagsForCatch = normalizeSessionFlags(newFlags);

      logChatDecision("exploration_relance_registered", {
        isRelance: relanceAnalysis.isRelance === true,
        explorationRelanceWindow: newFlags.explorationRelanceWindow,
        explorationDirectivityLevel: newFlags.explorationDirectivityLevel
      });
    }
    
    const debug = buildDebug(postureDecision.requestedBaseState || detectedState, {
      suicideLevel: suicide.suicideLevel,
      calledMemory: recallRouting.calledMemory,
      interpretationRejection: safeInterpretationRejection.isInterpretationRejection,
      needsSoberReadjustment: postureDecision.needsSoberReadjustment,
      relationalAdjustmentActive: relationalAdjustmentAnalysis?.needsRelationalAdjustment === true,
      explorationCalibrationLevel: newFlags.explorationCalibrationLevel,
      explorationDirectivityLevel: finalDirectivityLevel,
      explorationRelanceWindow: newFlags.explorationRelanceWindow,
    });
    
    if (logsEnabled) {
      debug.push(
        ...buildAdvancedDebugTrace({
          suicide,
          recallRouting,
          contactAnalysis,
          detectedState: postureDecision.requestedBaseState || detectedState,
          relationalAdjustmentAnalysis,
          interpretationRejection: safeInterpretationRejection,
          explorationCalibrationLevel: newFlags.explorationCalibrationLevel,
          flagsBefore: flags,
          flagsAfter: newFlags,
          generatedBase,
          relanceAnalysis
        })
      );

      debug.push(`trace.explorationSignal: ${finalExplorationSignal}`);
    }
    

    // 5) Mise � jour de la m�moire interne apr�s la r�ponse finale.
    // Memory update runs asynchronously after the response is sent.
    // Non-private conversations: server reads memory from Firebase next turn (convMemoryPromise).
    // Private conversations: client continues to use req.body.memory (no Firebase), so we still
    //   need to compute and return newMemory synchronously for them.
    let newMemory = previousMemory; // default: returned as-is in JSON for non-private
    let memoryWasCompressed = false;
    let memoryBeforeCompression = previousMemory;
    let memoryRewriteIntent = {
      compressionRequested: false,
      interpretationRejectionActive: safeInterpretationRejection.isInterpretationRejection === true,
      rejectsUnderlyingPhenomenon: safeInterpretationRejection.rejectsUnderlyingPhenomenon === true,
      soberReadjustmentActive: postureDecision.needsSoberReadjustment === true,
      lectureBotForcedReset: false
    };
    let memoryAge = 0;

    // Fire-and-forget memory update for non-private conversations.
    // For private conversations, compute synchronously (no Firebase storage).
    if (isPrivateConversation) {
      // Synchronous path for private conversations (no Firebase, client-authoritative).
      markChatStage("memory_update");
          const memoryPrioritySignal = postureDecision.memoryPrioritySignal || "normal";
          const isFirstTurn = recentHistory.length === 0;
          const memoryUpdateForced = isFirstTurn || memoryPrioritySignal !== "normal";
          const shouldRunMemoryUpdate = currentMemoryUpdateTurnsUntilRefresh === 0 || memoryUpdateForced;
      
          let rawNewMemory;
          if (shouldRunMemoryUpdate) {
            rawNewMemory = await updateMemory(
              previousMemory,
              [
                ...recentHistory,
                { role: "user", content: message },
                { role: "assistant", content: reply }
              ],
              activePromptRegistry,
              memoryPrioritySignal,
              intersessionMemoryForThisTurn,
            );
          } else {
            rawNewMemory = previousMemory;
          }
          throwIfCanceled();
      
          let memoryCandidate = rawNewMemory;
      
          // Points 1+4: r�gle d�terministe � Lecture bot doit �tre "-" pour tout �tat non-exploration, non-info
          const _memoryBaseState = baseStateOf(postureDecision.conversationState || "exploration_open");
          const lectureBotForcedReset = _memoryBaseState !== "exploration" && _memoryBaseState !== "info";
          if (lectureBotForcedReset) {
            memoryCandidate = forceLectureBotReset(memoryCandidate);
          }
      
          const memoryBeforeCompression = memoryCandidate;
          const memoryNeedsCompression = shouldCompressMemoryCandidate(memoryCandidate, previousMemory);
          const memoryRewriteIntent = {
            compressionRequested: memoryNeedsCompression === true,
            interpretationRejectionActive: safeInterpretationRejection.isInterpretationRejection === true,
            rejectsUnderlyingPhenomenon: safeInterpretationRejection.rejectsUnderlyingPhenomenon === true,
            soberReadjustmentActive: postureDecision.needsSoberReadjustment === true,
            lectureBotForcedReset: lectureBotForcedReset === true
          };
          const finalizedMemoryCandidate = await finalizeMemoryCandidate({
            previousMemory,
            candidateMemory: memoryCandidate,
            interpretationRejection: {
              ...safeInterpretationRejection,
              needsSoberReadjustment: postureDecision.needsSoberReadjustment,
              tensionHoldLevel: postureDecision.tensionHoldLevel
            },
            needsCompression: memoryNeedsCompression,
            promptRegistry: activePromptRegistry
          });
          const memoryWasCompressed = memoryNeedsCompression && finalizedMemoryCandidate !== memoryCandidate;
          const newMemory = finalizedMemoryCandidate;
      
          // Mise à jour du compteur de périodicité mémoire.
          // Si compression ce tour : forcer recalcul au tour suivant (compteur = 0).
          if (shouldRunMemoryUpdate) {
            newFlags.memoryUpdateTurnsUntilRefresh = memoryWasCompressed ? 0 : 3;
          } else {
            newFlags.memoryUpdateTurnsUntilRefresh = Math.max(0, currentMemoryUpdateTurnsUntilRefresh - 1);
          }
          const memoryAge = 3 - newFlags.memoryUpdateTurnsUntilRefresh;
          
          if (logsEnabled) {
            debug.push(`trace.memoryCompressed: ${memoryWasCompressed ? "true" : "false"}`);
          }
      newMemory = finalizedMemoryCandidate;
    } else {
      // Async fire-and-forget for non-private: compute and write to Firebase.
      // We capture needed variables in a closure.
      const _prevMem = previousMemory;
      const _reply = reply;
      const _message = message;
      const _history = recentHistory;
      const _registry = activePromptRegistry;
      const _prioritySignal = postureDecision.memoryPrioritySignal || "normal";
      const _isFirstTurn = recentHistory.length === 0;
      const _updateForced = _isFirstTurn || _prioritySignal !== "normal";
      const _shouldRun = currentMemoryUpdateTurnsUntilRefresh === 0 || _updateForced;
      // Update the periodicity counter synchronously so next turns get the right shouldRun value.
      if (_shouldRun) {
        newFlags.memoryUpdateTurnsUntilRefresh = 3; // will be refined to 0 if compression detected in bg
      } else {
        newFlags.memoryUpdateTurnsUntilRefresh = Math.max(0, currentMemoryUpdateTurnsUntilRefresh - 1);
      }
      memoryAge = 3 - newFlags.memoryUpdateTurnsUntilRefresh;
      const _interSession = intersessionMemoryForThisTurn;
      const _postureSnap = { conversationState: postureDecision.conversationState, needsSoberReadjustment: postureDecision.needsSoberReadjustment, tensionHoldLevel: postureDecision.tensionHoldLevel };
      const _rejectionSnap = { ...safeInterpretationRejection };
      (async () => {
        try {
          let rawMem;
          if (_shouldRun) {
            rawMem = await updateMemory(_prevMem, [..._history, { role: "user", content: _message }, { role: "assistant", content: _reply }], _registry, _prioritySignal, _interSession);
          } else {
            rawMem = _prevMem;
          }
          const _memBaseState = baseStateOf(_postureSnap.conversationState || "exploration_open");
          if (_memBaseState !== "exploration" && _memBaseState !== "info") {
            rawMem = forceLectureBotReset(rawMem);
          }
          const _needsCompression = shouldCompressMemoryCandidate(rawMem, _prevMem);
          const _finalized = await finalizeMemoryCandidate({
            previousMemory: _prevMem,
            candidateMemory: rawMem,
            interpretationRejection: { ..._rejectionSnap, needsSoberReadjustment: _postureSnap.needsSoberReadjustment, tensionHoldLevel: _postureSnap.tensionHoldLevel },
            needsCompression: _needsCompression,
            promptRegistry: _registry
          });
          // convRef.update is already handled by persistAssistantMessageAsync which runs in bg too.
          // We just need to overwrite the memory field in the conversation document.
          if (convRef) {
            await convRef.update({ memory: normalizeMemory(_finalized, _registry), updatedAt: new Date().toISOString() });
          }
        } catch (e) {
          console.warn("[CHAT][MEMORY_BG_FAILED]", e && e.message);
        }
      })();
    }
    const responseDebugMeta = buildResponseDebugMeta({
      memory: newMemory,
      suicideLevel: suicide.suicideLevel,
      conversationState: postureDecision.conversationState,
      consecutiveNonExplorationTurns: newFlags.consecutiveNonExplorationTurns,
      interpretationRejection: safeInterpretationRejection.isInterpretationRejection,
      needsSoberReadjustment: postureDecision.needsSoberReadjustment,
      relationalAdjustmentActive: relationalAdjustmentAnalysis?.needsRelationalAdjustment === true,
      isRecallRequest: recallRouting.isRecallAttempt === true,
      explorationCalibrationLevel: newFlags.explorationCalibrationLevel,
      explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
      explorationRelanceWindow: newFlags.explorationRelanceWindow,
      explorationSignal: finalExplorationSignal,
      memoryRewriteIntent,
      memoryCompressed: memoryWasCompressed,
      memoryBeforeCompression,
      memoryAge,
      criticTriggered,
      criticIssues,
      criticOriginalReply,
      criticTriggerReasons,
      humanFieldRisk,
      contractLengthExceeded,
      // Posture contract fields (V3)
      conversationState: postureDecision.conversationState,
      intent: postureDecision.intent,
      forbidden: postureDecision.forbidden,
      confidenceSignal: postureDecision.confidenceSignal,
      responseRegister: postureDecision.responseRegister,
      phraseLengthPolicy: postureDecision.phraseLengthPolicy,
      relancePolicy: postureDecision.relancePolicy,
      somaticFocusPolicy: postureDecision.somaticFocusPolicy,
      actionCollapseGuardActive: postureDecision.actionCollapseGuardActive,
      stateTransitionFrom: postureDecision.previousConversationState,
      stateTransitionValid: postureDecision.stateTransitionValid,
      stateTransitionRequested: postureDecision.stateTransitionValid === false
        ? postureDecision.requestedConversationState
        : null,
      // Phase B structural flags
      allianceSignal: newFlags.allianceSignal,
      engagementLevel: newFlags.engagementLevel,
      stagnationTurns: newFlags.stagnationTurns,
      processingWindow: newFlags.processingWindow,
      dependencyRiskScore: newFlags.dependencyRiskScore,
      dependencyRiskLevel: newFlags.dependencyRiskLevel,
      externalSupportMode: newFlags.externalSupportMode,
      closureIntent: newFlags.closureIntent,
      infoRoutingSource,
      promptRegistry: activePromptRegistry,
      // Lot 8 fields
      affiliationScore: affiliationScore,
      affiliationWindow: newAffiliationWindow,
      affiliationEstablished,
      emotionalDecentering: emotionalDecenteringAnalysis?.emotionalDecentering === true,
      formalAddress: postureDecision.formalAddress === true,
      // Writer hints from posture decision
      writerIntentHints: postureDecision.writerIntentHints,
      // Contact analyzer sub-fields
      contactInsightMoment: contactAnalysis?.insightMoment === true,
      contactSelfCriticismLevel: typeof contactAnalysis?.selfCriticismLevel === "string" ? contactAnalysis.selfCriticismLevel : "low",
      contactMeaningCrisis: contactAnalysis?.meaningCrisis === true,
      // C3 limiting_belief gate
      aggressiveDischargeDetected: postureDecision.aggressiveDischargeDetected === true,
      postDischargeTransitionActive: postureDecision.postDischargeTransitionActive === true,
    });

    if (logsEnabled) {
      console.log("[PIPELINE]", {
        conversationId,
        traceId,
        requestId: requestId || null,
        elapsedMs: Date.now() - chatStartTime,
        suicideLevel: suicide.suicideLevel,
        detectedState: detectedState,
        conversationState: responseDebugMeta.conversationState,
        interpretationRejection: responseDebugMeta.interpretationRejection === true,
        needsSoberReadjustment: responseDebugMeta.needsSoberReadjustment === true,
        relationalAdjustmentActive: responseDebugMeta.relationalAdjustmentActive === true,
        criticTriggered: responseDebugMeta.criticTriggered === true,
        criticIssues: Array.isArray(responseDebugMeta.criticIssues) ? responseDebugMeta.criticIssues : [],
        confidenceSignal: responseDebugMeta.confidenceSignal,
        explorationCalibrationLevel: responseDebugMeta.explorationCalibrationLevel,
        explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
        rewriteSource: responseDebugMeta.rewriteSource,
        stageTimings: chatStageTimings
      });
    }
    

    markChatStage("persist_response");
    throwIfCanceled();

    const botMessageId = persistAssistantMessageAsync(reply, debug, responseDebugMeta, { memory: newMemory, flags: newFlags });
    maybeGenerateConversationTitle();
    publishChatProgressTerminal(requestId, "done");
    
    return res.json({
      conversationId,
      reply,
      memory: newMemory,
      flags: newFlags,
      debug,
      debugMeta: responseDebugMeta,
      botMessageId
    });
  } catch (err) {
    if (err && err.code === "chat_request_canceled") {
      publishChatProgressTerminal(requestId, "canceled");
      // Mark the user message with [ENVOI STOPPE] if it was persisted
      if (userMessageRefForCatch && userMessagePersistedForCatch) {
        try {
          const snapshot = await userMessageRefForCatch.once("value");
          const messageData = snapshot.val();
          if (messageData && typeof messageData.content === "string") {
            let newContent = messageData.content;
            // Replace [MODIFIÉ] with [ENVOI STOPPE] if present, otherwise append it
            if (newContent.includes("[MODIFIÉ]") || newContent.includes("[MODIFI�]")) {
              newContent = newContent.replace(/\n?\[MODIFI[É�]\]$/, "\n[ENVOI STOPPE]");
            } else {
              newContent = newContent.trim() + "\n[ENVOI STOPPE]";
            }
            await userMessageRefForCatch.update({ content: newContent });
          }
        } catch (markErr) {
          console.warn("[CHAT][STOP_MARKING_FAILED]", markErr && markErr.message);
        }
      }

      return res.status(499).json({
        error: "Chat request canceled",
        canceled: true,
        requestId: requestId || null
      });
    }

    console.error("Erreur /chat:", err);
    publishChatProgressTerminal(requestId, "error");
    console.error("[CHAT][ERROR_CONTEXT]", {
      conversationId: requestData.conversationId,
      lastStage: chatLastStage,
      elapsedMs: Date.now() - chatStartTime,
      stageTimings: chatStageTimings
    });

    const isQuotaExhausted = err && (err.code === "insufficient_quota" || err.type === "insufficient_quota");
    const fallbackReply = isQuotaExhausted
      ? "Le service est temporairement indisponible car le quota API est epuise. Je ne peux pas traiter de nouveau message tant que ce quota n'est pas retabli."
      : suicideLevelForCatch === "N1"
        ? n1Fallback()
        : modeForCatch === "discharge"
          ? "Je suis la."
          : "Desole, reformule.";
    const fallbackDebugMeta = buildFallbackResponseDebugMeta({
      memory: previousMemoryForCatch,
      suicideLevel: "N0",
      conversationState: modeForCatch,
      isRecallRequest: false,
      explorationCalibrationLevel: flagsForCatch.explorationCalibrationLevel,
      explorationDirectivityLevel: flagsForCatch.explorationDirectivityLevel || 0,
      explorationRelanceWindow: flagsForCatch.explorationRelanceWindow || [],
      rewriteSource: null,
      memoryRewriteSource: null,
      modelConflict: false,
      promptRegistry: promptRegistryForCatch
    });

    if (!isQuotaExhausted && userMessagePersistedForCatch && !assistantMessagePersistedForCatch) {
      try {
        await persistFallbackAssistantMessage(fallbackReply, ["error"], fallbackDebugMeta);
        console.warn("[CHAT][FALLBACK_PERSISTED]", {
          conversationId: conversationIdForCatch,
          lastStage: chatLastStage
        });
      } catch (persistErr) {
        console.error("[CHAT][FALLBACK_PERSIST_FAILED]", {
          conversationId: conversationIdForCatch,
          lastStage: chatLastStage,
          error: persistErr && persistErr.message ? persistErr.message : String(persistErr)
        });
      }
    }
    if (isQuotaExhausted) {
      return res.status(503).json({
        error: "OpenAI quota exhausted",
        code: "insufficient_quota",
        status: "service_unavailable",
        serviceUnavailable: true,
        serviceUnavailableReason: "quota_exhausted",
        userMessage: "Le service est temporairement indisponible car le quota API est epuise. Aucun nouveau message ne peut etre traite tant que ce quota n'est pas retabli. Recharge la page apres retablissement du quota.",
        memory: previousMemoryForCatch,
        flags: flagsForCatch,
        debug: ["error"],
        debugMeta: fallbackDebugMeta
      });
    }
    
    // Fallback path: if any part of the /chat pipeline throws, return a safe
    // generic reply plus preserved memory/flags instead of crashing the server.
    return res.json({
      reply: fallbackReply,
      memory: previousMemoryForCatch,
      flags: flagsForCatch,
      debug: ["error"],
      debugMeta: fallbackDebugMeta
    });
  } finally {
    if (requestId) {
      finalizeActiveChatRequest(requestId);
    }

    if (logsEnabledForCatch) {
      console.log("[CHAT][TRACE]", {
        conversationId: requestData.conversationId,
        totalMs: Date.now() - chatStartTime,
        lastStage: chatLastStage,
        stageTimings: chatStageTimings
      });
    }
  }
});

// Start the HTTP server after all routes and middleware are configured.
app.listen(port, () => {
  console.log(`Serveur lance sur http://localhost:${port}`);

  bootstrapAdminSettingsCache();
  startAdminSettingsListener();

  // Auto-refresh for emergency numbers via Wikidata.
  // Boot refresh is opt-in via REFRESH_EMERGENCY_ON_BOOT=true.
  if (REFRESH_EMERGENCY_ON_BOOT) {
    setTimeout(() => {
      safeRefreshEmergencyNumbers("boot");
    }, EMERGENCY_REFRESH_INITIAL_DELAY_MS);
  }

  // Node.js setInterval overflows for values > 2^31-1 ms (~24.8 days), firing immediately in a loop.
  // Cap at 24h; the guard inside safeRefreshEmergencyNumbers (EMERGENCY_REFRESH_MIN_INTERVAL_MS)
  // prevents actual refresh from running more than once per 24h anyway.
  setInterval(() => {
    safeRefreshEmergencyNumbers("interval");
  }, EMERGENCY_REFRESH_MIN_INTERVAL_MS);
});
