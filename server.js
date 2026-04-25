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
const {
  clampDependencyRiskScore,
  clampExplorationDirectivityLevel,
  computeExplorationDirectivityLevel,
  getExplorationStructureInstruction,
  normalizeAllianceState,
  normalizeContactState,
  normalizeContactSubmode,
  normalizeConversationStateKey,
  normalizeConsecutiveNonExplorationTurns,
  normalizeDependencyRiskLevel,
  normalizeEngagementLevel,
  normalizeExplorationRelanceWindow,
  normalizeExternalSupportMode,
  normalizeFlags,
  normalizeInfoSubmode,
  normalizeProcessingWindow,
  normalizeSessionFlags,
  normalizeStagnationTurns,
  registerExplorationRelance
} = require("./lib/flags");
const { createAnalyzers } = require("./lib/analyzers");
const { createMemoryHelpers } = require("./lib/memory");
const {
  buildAdvancedDebugTrace,
  buildDebug,
  buildPostureDecision,
  normalizeGuardText,
  shouldForceExplorationForSituatedImpasse
} = require("./lib/pipeline");
const { buildDefaultPromptRegistry } = require("./lib/prompts");

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

const app = express();
const port = process.env.PORT || 3000;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
const RELANCE_WINDOW_SIZE = 4;

// --------------------------------------------------
// 1) OUTILS MINIMAUX
// --------------------------------------------------

function enableAdminUI() {
  localStorage.setItem(ADMIN_UI_KEY, "1");
  location.reload();
}

function disableAdminUI() {
  localStorage.removeItem(ADMIN_UI_KEY);
  location.reload();
}

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

// Merge the base prompt registry with optional override files.
// Only known targets from the base registry are replaced.
// Only known targets from the base registry are replaced.
function resolvePromptRegistry(overrideFiles = []) {
  return buildDefaultPromptRegistry();
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

  const mentionsApp = /\b(app|application|outil|plateforme|assistant)\b/.test(text);
  const asksUsage = /comment (utiliser|fonctionne|ca marche)|que fait l'app|quoi faire dans l'app|mode d'emploi|etapes|fonctionnalites|plan d'urgence|dans l'app/.test(text);

  return mentionsApp && asksUsage;
}

function isProceduralInstrumentalReply(reply = "") {
  const text = normalizeGuardText(reply);

  const hasProceduralTone = /voici quelques pistes|pour avancer|si ce n'est pas possible|tu peux aussi|tu peux |on peut |il existe|commence par|essaie de|reviens en arriere|decris brievement|cibler ensemble|copier-coller|isoler|extraire|utilise|ouvre|voir comment|contourner|repartir de|sans passer par|sans repasser par/.test(text);
  const hasInstrumentalObjects = /outil|interface|plateforme|systeme|procedure|manipulation|parametr|reglage|historique|version|fichier|document|section|portion|partie|support|editeur|application/.test(text);
  const hasListStructure = /^\s*[-â€¢]\s/m.test(reply) || /^\s*\d+\.\s/m.test(reply);

  return (hasProceduralTone && hasInstrumentalObjects) || (hasListStructure && hasInstrumentalObjects);
}

// Phase 4: Detect agency injunctions in a reply (sync check).
function hasAgencyInjectionInReply(reply = "") {
  const text = (reply || "").toLowerCase();
  const patterns = [
    "tu pourrais", "essaie de", "il faudrait", "tu devrais",
    "pourquoi ne pas", "je t'encourage", "je te conseille",
    "n'hesite pas a", "n'hÃ©site pas Ã ", "tu devrais peut-etre",
    "tu devrais peut-Ãªtre"
  ];
  return patterns.some(p => text.includes(p));
}


// Heuristic pre-check for theoretical violations to decide if CRITIC_PASS should be triggered.
// This avoids an unnecessary LLM call when the reply is clearly clean.
function hasTheoreticalViolationHeuristic(reply = "") {
  const text = (reply || "").toLowerCase();
  const patterns = [
    "inconscient", "subconscient", "non-conscient",
    "mecanisme de defense", "m\u00e9canisme de d\u00e9fense",
    "psychopathologie", "sant\u00e9 mentale", "sante mentale",
    "tu \u00e9vites", "tu evites", "tu r\u00e9sistes", "tu resistes",
    "il y a une r\u00e9sistance", "il y a une resistance",
    "tu refuses de", "tu fais tout pour ne pas"
  ];
  return patterns.some(p => text.includes(p));
}
// Phase 5: Estimate confidence level for an exploration reply (rule-based, no LLM).
function estimateReplyConfidence(message = "", history = []) {
  const text = (message || "").toLowerCase();
  const hasExplicitAmbiguity = /je sais pas|c'est mÃ©langÃ©|c'est melange|je ne sais pas trop|je suis perdu|pas sur de|pas sÃ»r de/.test(text);
  const hasRecentRejection = (history || []).slice(-4).some(m => {
    if (m.role !== "user") return false;
    const c = (m.content || "").toLowerCase();
    return /c'est pas Ã§a|c'est pas ca|pas vraiment|pas du tout|t'as rate|t'as ratÃ©|c'est faux|pas ce que je veux dire|non,? pas /.test(c);
  });
  const contextLength = (history || []).filter(m => m.role === "user").length;
  if (hasExplicitAmbiguity && (hasRecentRejection || contextLength <= 1)) return "low";
  if (hasExplicitAmbiguity || (hasRecentRejection && contextLength <= 2)) return "low";
  if (hasRecentRejection || contextLength <= 1) return "medium";
  return "high";
}

function buildHumanFieldFallback(message = "") {
  const text = normalizeGuardText(message);

  if (/trop grand|impossible|je n'arrive pas|je peux pas/.test(text)) {
    return "Je vois surtout l'impasse concrete dans laquelle tu te retrouves. Tu voudrais juste faire passer ce qu'il faut pour avancer, et ca bute deja sur la forme meme de ce que tu dois transmettre. Je recois bien a quel point ca peut couper net l'elan.";
  }

  if (/frustr|soule|decourag|perdu du temps|galer/.test(text)) {
    return "Je sens surtout l'usure que ca rajoute pour toi. Tu essaies d'avancer, et au lieu de ca tu te retrouves repris par quelque chose de pratique qui te coupe dans ton mouvement. Je recois bien le melange de blocage et d'agacement que ca laisse.";
  }

  return "Je vois surtout le blocage concret dans lequel tu te retrouves. La, ca ne parle pas seulement d'un probleme pratique : ca vient taper exactement a l'endroit ou tu essaies d'avancer, et je recois bien la tension que ca remet.";
}

function applyHumanFieldReplyGuard({
  message = "",
  mode = "exploration",
  infoSubmode = null,
  reply = ""
} = {}) {
  const proceduralRisk = isProceduralInstrumentalReply(reply);
  const guardApplies = mode === "exploration" || (mode === "info" && ["app_features", "psychoeducation"].includes(normalizeInfoSubmode(infoSubmode)));

  if (!guardApplies) {
    return { reply, overridden: false, proceduralRisk, source: null };
  }

  if (!shouldForceExplorationForSituatedImpasse(message)) {
    return { reply, overridden: false, proceduralRisk, source: null };
  }

  if (!proceduralRisk) {
    return { reply, overridden: false, proceduralRisk, source: null };
  }

  return {
    reply: buildHumanFieldFallback(message),
    overridden: true,
    proceduralRisk: true,
    source: "human_field_guard"
  };
}

// ----------------------------------------
// 2) SUICIDE RISK
// ----------------------------------------

// Analyze the user's message for suicidal risk using the prompt registry.
// The result drives immediate override responses and clarification flows.
async function analyzeSuicideRisk(
  message = "",
  history = [],
  sessionFlags = {},
  promptRegistry = buildDefaultPromptRegistry()
) {
  const safeFlags = normalizeSessionFlags(sessionFlags);
  
  const system = String(promptRegistry.ANALYZE_SUICIDE_RISK || "")
    .replace("{{acuteCrisis}}", safeFlags.acuteCrisis ? "oui" : "non");
  
  const context = trimSuicideAnalysisHistory(history);
  
  const r = await client.chat.completions.create({
    model: MODEL_IDS.analysis,
    temperature: 0,
    max_tokens: 240,
    messages: [
      { role: "system", content: system },
      ...context.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message }
    ]
  });
  
  const raw = (r.choices?.[0]?.message?.content || "").trim();
  
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(cleaned);
    
    let suicideLevel = ["N0", "N1", "N2"].includes(obj.suicideLevel) ?
      obj.suicideLevel :
      "N0";
    
    const idiomaticDeathExpression = obj.idiomaticDeathExpression === true;
    
    if (idiomaticDeathExpression) {
      suicideLevel = "N0";
    }
    
    let needsClarification =
      suicideLevel === "N1" || suicideLevel === "N2" ?
      obj.needsClarification === true :
      false;
    
    if (idiomaticDeathExpression) {
      needsClarification = false;
    }
    
    return {
      suicideLevel,
      needsClarification,
      isQuote: obj.isQuote === true,
      idiomaticDeathExpression,
      crisisResolved: obj.crisisResolved === true
    };
  } catch {
    return {
      suicideLevel: "N0",
      needsClarification: false,
      isQuote: false,
      idiomaticDeathExpression: false,
      crisisResolved: false
    };
  }
}

function n1Fallback() {
  return "Quand tu dis ca, est-ce que tu parles d'une envie de mourir, de disparaitre au sens vital, ou d'autre chose ?";
}

// Generate a clarification response for N1/ambiguous suicide risk.
// Falls back to a safe canned response if LLM output is too long or missing.
async function n1ResponseLLM(
  message,
  promptRegistry = buildDefaultPromptRegistry()
) {
  const system = promptRegistry.N1_RESPONSE_LLM;
  
  const r = await client.chat.completions.create({
    model: MODEL_IDS.generation,
    temperature: 0,
    max_tokens: 50,
    messages: [
      { role: "system", content: system },
      { role: "user", content: message }
    ]
  });
  
  const out = (r.choices?.[0]?.message?.content || "").trim();
  if (!out || out.length > 220) return n1Fallback();
  return out;
}

// Predefined crisis response used for N2 or unresolved acute crisis.
function n2Response() {
  return "Je t'entends, et la c'est urgent. Si tu es en danger immediat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
}

// Predefined follow-up response while remaining in acute crisis handling.
function acuteCrisisFollowupResponse() {
  return "Je reste sur quelque chose de tres simple la. Si le danger est immediat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
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
  analyzeContactState,
  analyzeExplorationCalibration,
  analyzeExplorationRelance,
  analyzeInfoRequest,
  analyzeInfoSubmode,
  analyzeInterpretationRejection,
  analyzeRecallRouting,
  analyzeRelationalAdjustmentNeed,
  detectMode
} = createAnalyzers({
  client,
  MODEL_IDS,
  isExplicitAppFeatureRequest,
  llmInfoAnalysis,
  normalizeMemory,
  shouldForceExplorationForSituatedImpasse,
  trimHistory,
  trimInfoAnalysisHistory,
  trimRecallAnalysisHistory
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
      { role: "system", content: promptRegistry.REWRITE_CONFLICT_MODEL },
      { role: "user", content: user }
    ]
  });
  
  return (r.choices?.[0]?.message?.content || "").trim() || originalContent;
}

// Phase 4: Selective critic - detects and corrects agency injunctions, over-clinicalization,
// and hollow presence formulas when triggered by a strong signal.
// Receives postureDecision to enforce the active contract (writerMode + forbidden).
async function applySelectiveCritic({
  reply = "",
  message = "",
  history = [],
  postureDecision = {},
  promptRegistry = buildDefaultPromptRegistry()
}) {
  const writerMode = postureDecision.writerMode || null;
  const forbidden = Array.isArray(postureDecision.forbidden) && postureDecision.forbidden.length > 0
    ? postureDecision.forbidden
    : [];
  const maxSentences = Number.isFinite(postureDecision.maxSentences) && postureDecision.maxSentences > 0
    ? postureDecision.maxSentences
    : null;
  const humanFieldGuardActive = postureDecision.humanFieldGuardActive === true;

  const contractLine = writerMode
    ? `Contrat actif : mode ${writerMode}${forbidden.length ? `, interdit ce tour : ${forbidden.join(", ")}` : ""}`
    : null;
  const contractLengthLine = maxSentences ? `Longueur contractuelle : max ${maxSentences} phrases` : null;
  const contractHumanFieldLine = humanFieldGuardActive ? "Human field guard actif : eviter tout ton procedural/instrumental" : null;

  const userParts = [
    contractLine,
    contractLengthLine,
    contractHumanFieldLine,
    `Message utilisateur :\n${message}`,
    `Contexte recent :\n${(history || []).map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}`,
    `Reponse a relire et corriger si necessaire :\n${reply}`
  ].filter(Boolean);
  const user = userParts.join("\n\n");

  const r = await client.chat.completions.create({
    model: MODEL_IDS.analysis,
    temperature: 0,
    max_tokens: 600,
    messages: [
      { role: "system", content: promptRegistry.CRITIC_PASS },
      { role: "user", content: user }
    ]
  });
  try {
    const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    return {
      reply: typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : reply,
      criticIssues: Array.isArray(parsed.issues) ? parsed.issues.filter(i => typeof i === "string") : []
    };
  } catch {
    return { reply, criticIssues: [] };
  }
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

// --------------------------------------------------
// 6) PROMPT
// --------------------------------------------------

// Wrap a prompt block with clear start/end markers to keep the prompt structure explicit.
function wrapPromptBlock(marker, content) {
  return `[[${marker}_START]]
${String(content || "").trim()}
[[${marker}_END]]`;
}

// Build the explicit posture contract block injected at the top of every writer system prompt.
// This is the single source of policy for the current turn â€” the writer does not need to infer it.
function buildPostureContractBlock(postureDecision = {}) {
  const writerMode = postureDecision.writerMode || "exploration_open";
  const intent = postureDecision.intent || "explorer librement";
  const forbidden = Array.isArray(postureDecision.forbidden) && postureDecision.forbidden.length > 0
    ? postureDecision.forbidden.join(", ")
    : "aucune contrainte specifique";
  const confidenceSignal = postureDecision.confidenceSignal || "high";
  const maxSentences = postureDecision.maxSentences || null;
  const toneConstraint = postureDecision.toneConstraint || null;
  const criticalGuardrails = Array.isArray(postureDecision.criticalGuardrails) && postureDecision.criticalGuardrails.length > 0
    ? postureDecision.criticalGuardrails.join(", ")
    : "no_unconscious, no_psychopathology, no_defense_mechanisms, no_implicit_agency";

  const lines = [
    `Etat : ${writerMode}`,
    `Intention : ${intent}`,
    `Interdit ce tour : ${forbidden}`,
    `Signalement d'incertitude : ${confidenceSignal === "low" ? "oui â€” signale explicitement que tu n'es pas certain de ta lecture" : "non"}`,
    `Garde-fous critiques actifs : ${criticalGuardrails}`,
    "Contraintes theoriques actives : no_unconscious (ne jamais mobiliser inconscient/subconscient comme instance explicative), no_psychopathology (ne jamais cadrer via pathologie/sante mentale), no_defense_mechanisms (ne pas parler de mecanismes de defense), no_implicit_agency (ne pas attribuer d'agentivite implicite au sujet â€” 'tu evites', 'tu resistes')",
  ];
  if (maxSentences) lines.push(`Longueur : max ${maxSentences} phrases`);
  if (toneConstraint) lines.push(`Ton : ${toneConstraint}`);
  if (postureDecision.interpretationRejectionDetected === true || postureDecision.needsSoberReadjustment === true) {
    lines.push("Reajustement d'interpretation actif : n'ajoute pas de justification ni de meta-discours, repars du plus concret.");
  }
  if (postureDecision.humanFieldGuardActive === true) {
    lines.push("Human field guard actif : interdit de basculer en mode procedural/instrumental (mode d'emploi, check-list, manipulation d'outil).");
  }

  // Inject operational definitions only for terms that are actually forbidden this turn
  if (Array.isArray(postureDecision.forbidden) && postureDecision.forbidden.length > 0) {
    const forbiddenDefs = {
      relance: "toute invite explicite ou implicite a continuer/approfondir/preciser",
      interpretive_hypothesis: 'toute formulation du type "peut-etre que", "il semblerait que", "quelque chose comme"',
      open_question: "toute question ouverte (quoi, comment, qu est-ce qui...)",
      prescriptive_language: "toute instruction ou suggestion d action a l utilisateur (essaie de, tu pourrais)",
      list: "enumeration ou bullet points dans la reponse",
      recap: "synthese ou recapitulatif de ce qui a ete dit avant",
      self_justification: "explication ou defense de la reponse precedente du bot"
    };
    const defs = postureDecision.forbidden
      .filter(term => forbiddenDefs[term])
      .map(term => `  - ${term} : ${forbiddenDefs[term]}`)
      .join("\n");
    if (defs) lines.splice(3, 0, `Definitions des termes interdits :\n${defs}`);
  }

  return wrapPromptBlock("POSTURE_CONTRACT", lines.join("\n"));
}

// Build the identity prompt block containing the assistant's persona and behavior rules.
function getIdentityPrompt(promptRegistry = buildDefaultPromptRegistry()) {
  const identityBlock = String(promptRegistry.IDENTITY_BLOCK || "").trim();
  return wrapPromptBlock("IDENTITY_BLOCK", identityBlock);
}

// Build the contact mode prompt block for explicit contact-style responses.
function getContactPrompt(promptRegistry = buildDefaultPromptRegistry()) {
  const contactBlock = String(promptRegistry.MODE_CONTACT || "").trim();
  return wrapPromptBlock("MODE_CONTACT", contactBlock);
}

// Build the relational adjustment prompt block.
function getRelationalAdjustmentPrompt(promptRegistry = buildDefaultPromptRegistry()) {
  const adjustmentBlock = String(promptRegistry.MODE_RELATIONAL_ADJUSTMENT || "").trim();
  return wrapPromptBlock("MODE_RELATIONAL_ADJUSTMENT", adjustmentBlock);
}

// Build the info mode prompt block, injecting the current normalized memory.
function getInfoPrompt(memory, infoSubmode = null, promptRegistry = buildDefaultPromptRegistry()) {
  const normalizedMemory = normalizeMemory(memory, promptRegistry);
  const normalizedInfoSubmode = normalizeInfoSubmode(infoSubmode);
  const infoBlockContent = normalizedInfoSubmode === "pure" ?
    String(promptRegistry.MODE_INFORMATION_PURE || promptRegistry.MODE_INFORMATION || "").trim() :
    normalizedInfoSubmode === "psychoeducation" ?
      String(promptRegistry.MODE_INFORMATION_PSYCHOEDUCATION || promptRegistry.MODE_INFORMATION_APP_THEORETICAL_MODEL || promptRegistry.MODE_INFORMATION_APP || promptRegistry.MODE_INFORMATION || "").trim() :
      String(promptRegistry.MODE_INFORMATION_APP_FEATURES || promptRegistry.MODE_INFORMATION_APP || promptRegistry.MODE_INFORMATION || "").trim();
  const infoBlock = [
    infoBlockContent,
    `Memoire :
${normalizedMemory}`
  ].filter(Boolean).join("\n\n").trim();

  return wrapPromptBlock("MODE_INFORMATION", infoBlock);
}

// Build the exploration prompt block, injecting memory and directivity instructions.
function getExplorationPrompt(memory, explorationDirectivityLevel = 0, promptRegistry = buildDefaultPromptRegistry()) {
  const normalizedMemory = normalizeMemory(memory, promptRegistry);
  const commonExplorationBlock = String(promptRegistry.COMMON_EXPLORATION || "")
    .replace("{{MEMORY}}", normalizedMemory)
    .trim();
  const explorationStructureBlock = String(
    getExplorationStructureInstruction(explorationDirectivityLevel, promptRegistry) || ""
  ).trim();

  const explorationBlock = [
    commonExplorationBlock,
    explorationStructureBlock
  ].filter(Boolean).join("\n\n").trim();

  return wrapPromptBlock("MODE_EXPLORATION", explorationBlock);
}

function buildExplorationSubmodePromptBlock(explorationSubmode = "interpretation", promptRegistry = buildDefaultPromptRegistry()) {
  const safeExplorationSubmode = ["interpretation", "phenomenological_follow"].includes(explorationSubmode) ?
    explorationSubmode :
    "interpretation";

  const content = safeExplorationSubmode === "phenomenological_follow" ?
    String(promptRegistry.EXPLORATION_SUBMODE_PHENOMENOLOGICAL_FOLLOW || "").trim() :
    String(promptRegistry.EXPLORATION_SUBMODE_INTERPRETATION || "").trim();

  return wrapPromptBlock("EXPLORATION_SUBMODE", content);
}

function buildPostContactLandingPromptBlock(conversationStateKey, promptRegistry = buildDefaultPromptRegistry()) {
  if (conversationStateKey !== "post_contact") return "";
  const content = String(promptRegistry.POST_CONTACT_LANDING || "").trim();
  return content ? wrapPromptBlock("POST_CONTACT_LANDING", content) : "";
}

// Phase C state prompt blocks
function buildStabilizationPromptBlock(conversationStateKey, promptRegistry = buildDefaultPromptRegistry()) {
  if (conversationStateKey !== "stabilization") return "";
  const content = String(promptRegistry.STABILIZATION_MODE || "").trim();
  return content ? wrapPromptBlock("STABILIZATION_MODE", content) : "";
}

function buildAllianceRupturePromptBlock(conversationStateKey, promptRegistry = buildDefaultPromptRegistry()) {
  if (conversationStateKey !== "alliance_rupture") return "";
  const content = String(promptRegistry.ALLIANCE_RUPTURE_REPAIR || "").trim();
  return content ? wrapPromptBlock("ALLIANCE_RUPTURE_REPAIR", content) : "";
}

function buildDependencyRiskGuardrailBlock(dependencyRiskLevel = "low", promptRegistry = buildDefaultPromptRegistry()) {
  if (normalizeDependencyRiskLevel(dependencyRiskLevel) !== "high") return "";
  const content = String(promptRegistry.DEPENDENCY_RISK_GUARDRAIL || "").trim();
  return content ? wrapPromptBlock("DEPENDENCY_RISK_GUARDRAIL", content) : "";
}

function buildClosurePromptBlock(conversationStateKey, promptRegistry = buildDefaultPromptRegistry()) {
  if (conversationStateKey !== "closure") return "";
  const content = String(promptRegistry.CLOSURE_MODE || "").trim();
  return content ? wrapPromptBlock("CLOSURE_MODE", content) : "";
}

function buildRelationalAdjustmentPromptBlock(relationalAdjustmentTriggered = false, promptRegistry = buildDefaultPromptRegistry()) {
  if (relationalAdjustmentTriggered !== true) {
    return "";
  }

  const adjustmentBlock = String(promptRegistry.MODE_RELATIONAL_ADJUSTMENT || "").trim();
  return wrapPromptBlock("RELATIONAL_ADJUSTMENT", adjustmentBlock);
}

function buildContactSubmodePromptBlock(contactSubmode = null, promptRegistry = buildDefaultPromptRegistry()) {
  const safeContactSubmode = normalizeContactSubmode(contactSubmode);

  if (!safeContactSubmode) {
    return "";
  }

  const content = safeContactSubmode === "dysregulated" ?
    String(promptRegistry.CONTACT_SUBMODE_DYSREGULATED || "").trim() :
    String(promptRegistry.CONTACT_SUBMODE_REGULATED || "").trim();

  return content ? wrapPromptBlock("CONTACT_SUBMODE", content) : "";
}

function buildInterpretationRejectionPromptBlock(interpretationRejection = null) {
  if (
    !interpretationRejection ||
    (
      interpretationRejection.isInterpretationRejection !== true &&
      interpretationRejection.needsSoberReadjustment !== true
    )
  ) {
    return "";
  }

  const lines = [
    "Rejet d'interpretation detecte sur le tour actuel.",
    "- n'essaie pas de defendre la lecture precedente",
    "- n'ajoute aucun meta-discours sur le fait de t'etre trompe",
    interpretationRejection.rejectsUnderlyingPhenomenon === true ?
      "- le phenomene de fond semble lui aussi rejete : repars du plus observable" :
      "- seul l'angle precedent semble rejete : garde le phenomene de fond seulement s'il reste tres concret",
    interpretationRejection.needsSoberReadjustment === true ?
      "- reajuste l'axe dans la reponse presente, de maniere sobre et concrete" :
      "- reste sobre et n'exagere pas le reajustement",
    interpretationRejection.tensionHoldLevel === "high" ?
      "- garde une tension ferme apres reajustement" :
      interpretationRejection.tensionHoldLevel === "low" ?
      "- reduis nettement la tension apres reajustement" :
      "- garde une tension calme apres reajustement"
  ];

  return wrapPromptBlock("INTERPRETATION_REJECTION", lines.join("\n"));
}

// Construct the full system prompt for the selected mode before calling the LLM.
// postureDecision carries the full contract (writerMode, forbidden, intent, etc.).
// The contract block is always injected first so the writer receives the policy
// before any identity or style instructions.
function buildSystemPrompt(postureDecision, memory, promptRegistry = buildDefaultPromptRegistry(), infoSubmode = null, interpretationRejection = null, contactSubmode = null) {
  const mode = postureDecision.finalDetectedMode;
  const writerMode = postureDecision.writerMode || "exploration_open";
  const explorationDirectivityLevel = postureDecision.finalDirectivityLevel;
  const explorationSubmode = postureDecision.finalExplorationSubmode || "interpretation";
  const relationalAdjustmentTriggered = postureDecision.relationalAdjustmentTriggered;

  const contractWrapped = buildPostureContractBlock(postureDecision);
  const identityWrapped = getIdentityPrompt(promptRegistry);
  const relationalAdjustmentWrapped = buildRelationalAdjustmentPromptBlock(relationalAdjustmentTriggered, promptRegistry);
  const interpretationSignal = {
    isInterpretationRejection: postureDecision.interpretationRejectionDetected === true || interpretationRejection?.isInterpretationRejection === true,
    needsSoberReadjustment: postureDecision.needsSoberReadjustment === true || interpretationRejection?.needsSoberReadjustment === true,
    rejectsUnderlyingPhenomenon: postureDecision.rejectsUnderlyingPhenomenon === true || interpretationRejection?.rejectsUnderlyingPhenomenon === true,
    tensionHoldLevel: postureDecision.tensionHoldLevel || interpretationRejection?.tensionHoldLevel || "medium"
  };
  const interpretationRejectionWrapped = buildInterpretationRejectionPromptBlock(interpretationSignal);

  // Single style block selected by writerMode
  let styleBlock = "";
  const PHASE_C_STATES = ["stabilization", "alliance_rupture", "closure", "post_contact"];
  if (mode === "contact") {
    const contactWrapped = getContactPrompt(promptRegistry);
    const contactSubmodeWrapped = buildContactSubmodePromptBlock(contactSubmode, promptRegistry);
    styleBlock = [contactWrapped, contactSubmodeWrapped].filter(Boolean).join("\n\n");
  } else if (mode === "info") {
    styleBlock = getInfoPrompt(memory, infoSubmode, promptRegistry);
  } else if (PHASE_C_STATES.includes(writerMode)) {
    // Phase C states: contract block is the sole policy source.
    // COMMON_EXPLORATION would introduce contradictory invitations (open questions, hypotheses).
    // No style block injected — identity + contract is sufficient.
    styleBlock = "";
  } else {
    // exploration_open and exploration_guided
    const explorationWrapped = getExplorationPrompt(memory, explorationDirectivityLevel, promptRegistry);
    const explorationSubmodeWrapped = buildExplorationSubmodePromptBlock(explorationSubmode, promptRegistry);
    styleBlock = [explorationWrapped, explorationSubmodeWrapped].filter(Boolean).join("\n\n");
  }

  return [
    contractWrapped,
    identityWrapped,
    styleBlock,
    relationalAdjustmentWrapped,
    interpretationRejectionWrapped
  ].filter(Boolean).join("\n\n").trim();
}

// Generate the assistant reply using the assembled system prompt and conversation history.
async function generateReply({
  message,
  history,
  memory,
  postureDecision,
  infoSubmode = null,
  contactSubmode = null,
  interpretationRejection = null,
  promptRegistry = buildDefaultPromptRegistry(),
}) {
  const systemPrompt = buildSystemPrompt(
    postureDecision,
    memory,
    promptRegistry,
    infoSubmode,
    interpretationRejection,
    contactSubmode,
  );
  
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: message }
  ];
  
  // Send the assembled prompt and conversation history to the LLM.
  const r = await client.chat.completions.create({
    model: MODEL_IDS.generation,
    temperature: 0.7,
    top_p: 1,
    presence_penalty: 0.5,
    frequency_penalty: 0.3,
    messages
  });
  
  return {
    reply: (r.choices?.[0]?.message?.content || "").trim() || "Je t'ecoute."
  };
}

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
        contactState: { wasContact: false },
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

// Generate a short, clean title for a conversation from the first user messages.
// Uses the LLM when possible, with fallback rules to keep titles safe and concise.
async function generateConversationTitle(messages) {
  try {
    const userMessages = messages
      .filter(m => m && m.role === "user" && typeof m.content === "string")
      .slice(0, 3)
      .map(m => m.content.trim())
      .filter(Boolean);
    
    if (userMessages.length === 0) return null;
    
    const sourceText = userMessages.join("\n\n");
    
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
          "- ne commence pas par Verbatim de type Je, J, Tu, Mon, Ma sauf si c'est indispensable"
        ].join("\n")
      }, {
        role: "user",
        content: sourceText
      }]
    });
    
    let title = completion.choices?.[0]?.message?.content?.trim() || "";
    
    title = title
      .replace(/^["'Â«]+|["'Â»]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    
    if (!title) {
      const merged = userMessages.join(" ");
      const words = merged
        .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5);
      
      title = words.length ? words.join(" ") : "Conversation";
    }
    
    if (title.length > 40) {
      title = title.slice(0, 40).trim();
    }
    
    if (!title) {
      title = "Conversation";
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
      
      title = String(title || "")
        .replace(/^["'Â«]+|["'Â»]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      
      if (title.length > 40) {
        title = title.slice(0, 40).trim();
      }
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
          .replace(/^["'Â«]+|["'Â»]+$/g, "")
          .replace(/\s+/g, " ")
          .trim();
        
        if (fallbackTitle.length > 40) {
          fallbackTitle = fallbackTitle.slice(0, 40).trim();
        }
      }
    } catch (rewriteErr) {
      console.error("Erreur rewrite titre:", rewriteErr.message);
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

    const settingsSnap = await adminSettingsRef.once("value");
    const settings = settingsSnap.val() || {};

    return res.json({
      authenticated: true,
      settings: {
        mailsEnabled: settings.mailsEnabled !== false
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

    const now = new Date().toISOString();
    const userId = `u_${crypto.randomBytes(12).toString("hex")}`;
    const userRecord = {
      email,
      passwordHash: hashPassword(password),
      privateConversationsByDefault: false,
      createdAt: now,
      updatedAt: now
    };

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

    const conversations = req.body.conversations.slice(0, 50);
    const importedConversationIds = [];
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
          alreadyOwnedCount += 1;
          continue;
        }

        skippedCount += 1;
        continue;
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
              infoSubmode: normalizeInfoSubmode(debugMeta.infoSubmode),
              contactSubmode: normalizeContactSubmode(debugMeta.contactSubmode),
              interpretationRejection: debugMeta.interpretationRejection === true,
              needsSoberReadjustment: debugMeta.needsSoberReadjustment === true,
              relationalAdjustmentTriggered: debugMeta.relationalAdjustmentTriggered === true,
              explorationCalibrationLevel: Number.isInteger(debugMeta.explorationCalibrationLevel) ? debugMeta.explorationCalibrationLevel : null,
              therapeuticAllianceSource: typeof debugMeta.therapeuticAllianceSource === "string" ? debugMeta.therapeuticAllianceSource : null,
              rewriteSource: typeof debugMeta.rewriteSource === "string" ? debugMeta.rewriteSource : null,
              memoryRewriteSource: typeof debugMeta.memoryRewriteSource === "string" ? debugMeta.memoryRewriteSource : null,
              modelConflict: debugMeta.modelConflict === true,
              humanFieldRisk: debugMeta.humanFieldRisk === true,
              humanFieldOriginalReply: typeof debugMeta.humanFieldOriginalReply === "string" ? debugMeta.humanFieldOriginalReply : null,
              soberReadjustmentOriginalReply: typeof debugMeta.soberReadjustmentOriginalReply === "string" ? debugMeta.soberReadjustmentOriginalReply : null
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

      for (const message of sanitizedMessages) {
        await messagesRef.push({
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
          userId: session.userId,
          conversationId,
          debug: message.debug,
          debugMeta: message.debugMeta,
          stateSnapshot: message.stateSnapshot
        });
      }

      importedConversationIds.push(conversationId);
    }

    return res.json({
      success: true,
      importedConversationIds,
      importedCount: importedConversationIds.length,
      alreadyOwnedCount,
      skippedCount
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
// If devShare is false, the call should not reach this endpoint â€” frontend handles locally only.
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
    const snap = await usersRef.child(session.userId).child("intersessionMemory").once("value");
    const memory = snap.val();
    return res.json({
      memory: typeof memory === "string" && memory.trim() ? memory : null
    });
  } catch (err) {
    console.error("Erreur GET /api/intersession-memory:", err.message);
    return res.status(500).json({ error: "Intersession memory read failed" });
  }
});

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
    const previousSnap = await usersRef.child(session.userId).child("intersessionMemory").once("value");
    const previousIntersessionMemory = typeof previousSnap.val() === "string" ? previousSnap.val() : "";
    const memory = await updateIntersessionMemory(
      previousIntersessionMemory,
      sessionMemory,
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

function registerActiveChatRequest(requestId, userId) {
  const safeId = String(requestId || "").trim();
  if (!safeId) return;

  activeChatRequests.set(safeId, {
    userId: String(userId || "").trim(),
    canceled: false,
    updatedAt: Date.now()
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
      activeChatRequests.delete(requestId);
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
  return res.json({ success: true, requestId, canceled });
});

// Resolve the prompt registry for the current request.
function resolvePromptRegistryVariants() {
  const basePromptRegistry = resolvePromptRegistry([]);

  return {
    basePromptRegistry,
    activePromptRegistry: basePromptRegistry
  };
}

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
  console.log("CHAT INPUT conversationId:", requestData.conversationId);
  const requestId = String(requestData.requestId || "").trim();

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
  let modeForCatch = "exploration";
  let infoSubmodeForCatch = null;
  let contactSubmodeForCatch = null;
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
      conversationStateKey: normalizeConversationStateKey(safe.conversationStateKey),
      consecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(safe.consecutiveNonExplorationTurns),
      infoSubmode: normalizeInfoSubmode(safe.infoSubmode),
      contactSubmode: normalizeContactSubmode(safe.contactSubmode),
      interpretationRejection: safe.interpretationRejection === true,
      needsSoberReadjustment: safe.needsSoberReadjustment === true,
      relationalAdjustmentTriggered: safe.relationalAdjustmentTriggered === true,
      pipelineStages: normalizePipelineStagesForStorage(safe.pipelineStages),
      explorationCalibrationLevel: Number.isInteger(safe.explorationCalibrationLevel) ? clampExplorationDirectivityLevel(safe.explorationCalibrationLevel) : null,
      explorationSubmode: typeof safe.explorationSubmode === "string" ? safe.explorationSubmode : null,
      therapeuticAllianceSource: typeof safe.therapeuticAllianceSource === "string" ? safe.therapeuticAllianceSource : null,
      rewriteSource: typeof safe.rewriteSource === "string" ? safe.rewriteSource : null,
      memoryRewriteSource: typeof safe.memoryRewriteSource === "string" ? safe.memoryRewriteSource : null,
      memoryCompressed: safe.memoryCompressed === true,
      memoryBeforeCompression:
        safe.memoryCompressed === true && typeof safe.memoryBeforeCompression === "string" ?
          normalizeMemory(safe.memoryBeforeCompression, promptRegistry) :
          null,
      soberReadjustmentOriginalReply: typeof safe.soberReadjustmentOriginalReply === "string" ? safe.soberReadjustmentOriginalReply : null,
      criticTriggered: safe.criticTriggered === true,
      criticIssues: Array.isArray(safe.criticIssues) ? safe.criticIssues : [],
      // Posture contract (V3)
      writerMode: typeof safe.writerMode === "string" ? safe.writerMode : null,
      intent: typeof safe.intent === "string" ? safe.intent : null,
      forbidden: Array.isArray(safe.forbidden) ? safe.forbidden : [],
      confidenceSignal: typeof safe.confidenceSignal === "string" ? safe.confidenceSignal : "high",
      allianceState: normalizeAllianceState(safe.allianceState),
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
      content: isEditedForCatch ? reply + "\n[MODIFIÃ‰]" : reply,
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
    mode = null,
    infoSubmode = null,
    contactSubmode = null,
    interpretationRejection = false,
    needsSoberReadjustment = false,
    relationalAdjustmentTriggered = false,
    isRecallRequest = false,
    explorationCalibrationLevel = null,
    explorationDirectivityLevel = 0,
    explorationRelanceWindow = [],
    explorationSubmode = null,
    therapeuticAllianceSource = null,
    rewriteSource = null,
    memoryRewriteSource = null,
    modelConflict = false,
    promptRegistry = buildDefaultPromptRegistry()
  } = {}) {
    function buildTopChips({
      suicideLevel = "N0",
      mode = null,
      infoSubmode = null,
      contactSubmode = null,
      explorationSubmode = null,
      interpretationRejection = false,
      isRecallRequest = false,
      needsSoberReadjustment = false,
      relationalAdjustmentTriggered = false
    } = {}) {
      const chips = [];

      function buildExplorationSubmodeChipLabel(submode = null) {
        if (submode === "interpretation") return "EXPLORATION : interprÃ©tation";
        if (submode === "phenomenological_follow") return "EXPLORATION : accompagnement";
        return "EXPLORATION";
      }
      
      if (suicideLevel === "N2") {
        chips.push("URGENCE : risque suicidaire");
      } else if (suicideLevel === "N1") {
        chips.push("Risque suicidaire Ã  clarifier");
      } else if (mode === "exploration") {
        chips.push(buildExplorationSubmodeChipLabel(explorationSubmode));
      } else if (mode === "info") {
        const safeInfoSubmode = normalizeInfoSubmode(infoSubmode);
        chips.push(
          safeInfoSubmode === "psychoeducation" ? "PSYCHOEDUCATION" :
          safeInfoSubmode === "app_features" ? "INFO APP : fonctionnalitÃ©s" :
          safeInfoSubmode === "pure" ? "INFO PURE" :
          "INFO"
        );
      } else if (mode === "contact") {
        const safeContactSubmode = normalizeContactSubmode(contactSubmode);
        chips.push(
          safeContactSubmode === "dysregulated" ? "CONTACT : dÃ©rÃ©gulÃ©" :
          safeContactSubmode === "regulated" ? "CONTACT : rÃ©gulÃ©" :
          "CONTACT"
        );
      }

      if (interpretationRejection === true) {
        chips.push("Rejet d'interprÃ©tation");
      }
      
      if (isRecallRequest === true) {
        chips.push("Demande de rappel mÃ©moire");
      }
      
      if (needsSoberReadjustment === true) {
        chips.push("RÃ©ajustement sobre");
      }
      
      if (relationalAdjustmentTriggered === true) {
        chips.push("Ajustement relationnel");
      }
      
      return chips;
    }
    
    function buildDirectivityText({
      mode = null,
      explorationCalibrationLevel = null,
      explorationDirectivityLevel = 0,
      explorationRelanceWindow = []
    } = {}) {
      if (mode !== "exploration") {
        return "";
      }
      
      const safeWindow = normalizeExplorationRelanceWindow(explorationRelanceWindow);
      const safeNextLevel = clampExplorationDirectivityLevel(explorationDirectivityLevel);
      const safeRetainedLevel = explorationCalibrationLevel !== null && explorationCalibrationLevel !== undefined ?
        clampExplorationDirectivityLevel(explorationCalibrationLevel) :
        null;

      if (safeRetainedLevel === null && safeNextLevel <= 0) {
        return "";
      }
      
      return [
        safeRetainedLevel !== null ? `Niveau de structuration retenu : ${safeRetainedLevel}/4` : null,
        `Fenetre de relance : [${safeWindow.map(v => (v ? "1" : "0")).join("-")}]`,
        `Niveau de directivite (tour suivant) : ${safeNextLevel}/4`
      ].filter(Boolean).join("\n");
    }
    
    return {
      topChips: buildTopChips({
        suicideLevel,
        mode,
        infoSubmode,
        contactSubmode,
        explorationSubmode,
        interpretationRejection,
        isRecallRequest,
        needsSoberReadjustment,
        relationalAdjustmentTriggered
      }),
      memory: normalizeMemory(memory, promptRegistry),
      directivityText: buildDirectivityText({
        mode,
        explorationCalibrationLevel,
        explorationDirectivityLevel,
        explorationRelanceWindow
      }),
      infoSubmode: normalizeInfoSubmode(infoSubmode),
      contactSubmode: normalizeContactSubmode(contactSubmode),
      interpretationRejection: interpretationRejection === true,
      needsSoberReadjustment: needsSoberReadjustment === true,
      relationalAdjustmentTriggered: relationalAdjustmentTriggered === true,
      pipelineStages: chatStageTimings.map((entry) => ({
        stage: typeof entry?.stage === "string" ? entry.stage : null,
        deltaMs: Number.isFinite(entry?.deltaMs) ? entry.deltaMs : null
      })).filter((entry) => entry.stage),
      explorationCalibrationLevel: explorationCalibrationLevel !== null && explorationCalibrationLevel !== undefined ?
        clampExplorationDirectivityLevel(explorationCalibrationLevel) :
        null,
      therapeuticAllianceSource: typeof therapeuticAllianceSource === "string" ? therapeuticAllianceSource : null,
      rewriteSource: typeof rewriteSource === "string" ? rewriteSource : null,
      memoryRewriteSource: typeof memoryRewriteSource === "string" ? memoryRewriteSource : null,
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
    
    // Resolve prompt registry variants before generation logic.
    const {
      activePromptRegistry
    } = resolvePromptRegistryVariants();
    
    // Normalize memory and flags with the active registry so all later steps use the same rules.
    const {
      previousMemory,
      rawFlags,
      flags
    } = normalizeChatMemoryAndFlags(req, activePromptRegistry);
    markChatStage("request_normalized");
    throwIfCanceled();
    
    previousMemoryForCatch = previousMemory;
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
        
        const generatedTitle = await generateConversationTitle(conversationMessages);
        
        if (!generatedTitle || !generatedTitle.trim()) {
          return;
        }
        
        await convRef.update({
          title: generatedTitle.trim(),
          updatedAt: new Date().toISOString()
        });
        
        console.log("AUTO TITLE UPDATED:", conversationId, "->", generatedTitle.trim());
      } catch (titleErr) {
        console.error("Erreur auto-title /chat:", titleErr.message);
      }
    }
    
    if (!isPrivateConversation) {
      const pushedRef = await messagesRef.push({
        role: "user",
        content: isEdited ? message + "\n[MODIFIÃ‰]" : message,
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

    let effectiveMailsEnabled = mailsEnabled !== false;

    try {
      const adminMailsSnap = await adminSettingsRef.child("mailsEnabled").once("value");
      if (adminMailsSnap.exists()) {
        effectiveMailsEnabled = adminMailsSnap.val() !== false;
      }
    } catch (err) {
      console.error("Erreur lecture adminSettings.mailsEnabled:", err.message);
      // Fail-safe: if settings are temporarily unavailable (e.g. during deploy), avoid sending alerts.
      effectiveMailsEnabled = false;
    }

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
        content: isEdited ? reply + "\n[MODIFIÃ‰]" : reply,
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
    
    function buildTopChips({
      suicideLevel = "N0",
      mode = null,
      infoSubmode = null,
      contactSubmode = null,
      explorationSubmode = null,
      interpretationRejection = false,
      isRecallRequest = false,
      needsSoberReadjustment = false,
      relationalAdjustmentTriggered = false
    } = {}) {
      const chips = [];

      function buildExplorationSubmodeChipLabel(submode = null) {
        if (submode === "interpretation") return "EXPLORATION : interprÃ©tation";
        if (submode === "phenomenological_follow") return "EXPLORATION : accompagnement";
        return "EXPLORATION";
      }
      
      if (suicideLevel === "N2") {
        chips.push("URGENCE : risque suicidaire");
      } else if (suicideLevel === "N1") {
        chips.push("Risque suicidaire Ã  clarifier");
      } else if (mode === "exploration") {
        chips.push(buildExplorationSubmodeChipLabel(explorationSubmode));
      } else if (mode === "info") {
        const safeInfoSubmode = normalizeInfoSubmode(infoSubmode);
        chips.push(
          safeInfoSubmode === "psychoeducation" ? "PSYCHOEDUCATION" :
          safeInfoSubmode === "app_features" ? "INFO APP : fonctionnalitÃ©s" :
          safeInfoSubmode === "pure" ? "INFO PURE" :
          "INFO"
        );
      } else if (mode === "contact") {
        const safeContactSubmode = normalizeContactSubmode(contactSubmode);
        chips.push(
          safeContactSubmode === "dysregulated" ? "CONTACT : dÃ©rÃ©gulÃ©" :
          safeContactSubmode === "regulated" ? "CONTACT : rÃ©gulÃ©" :
          "CONTACT"
        );
      }

      if (interpretationRejection === true) {
        chips.push("Rejet d'interprÃ©tation");
      }
      
      if (isRecallRequest === true) {
        chips.push("Demande de rappel mÃ©moire");
      }
      
      if (needsSoberReadjustment === true) {
        chips.push("RÃ©ajustement sobre");
      }
      
      if (relationalAdjustmentTriggered === true) {
        chips.push("Ajustement relationnel");
      }
      
      return chips;
    }
    
    function buildDirectivityText({
      mode = null,
      explorationCalibrationLevel = null,
      explorationDirectivityLevel = 0,
      explorationRelanceWindow = []
    } = {}) {
      if (mode !== "exploration") {
        return "";
      }
      
      const safeWindow = normalizeExplorationRelanceWindow(explorationRelanceWindow);
      const safeNextLevel = clampExplorationDirectivityLevel(explorationDirectivityLevel);
      const safeRetainedLevel = explorationCalibrationLevel !== null && explorationCalibrationLevel !== undefined ?
        clampExplorationDirectivityLevel(explorationCalibrationLevel) :
        null;

      if (safeRetainedLevel === null && safeNextLevel <= 0) {
        return "";
      }
      
      return [
        safeRetainedLevel !== null ? `Niveau de structuration retenu : ${safeRetainedLevel}/4` : null,
        `Fenetre de relance : [${safeWindow.map(v => (v ? "1" : "0")).join("-")}]`,
        `Niveau de directivite (tour suivant) : ${safeNextLevel}/4`
      ].filter(Boolean).join("\n");
    }
    
    function buildResponseDebugMeta({
      memory = "",
      suicideLevel = "N0",
      mode = null,
      conversationStateKey = "exploration",
      consecutiveNonExplorationTurns = 0,
      infoSubmode = null,
      contactSubmode = null,
      interpretationRejection = false,
      needsSoberReadjustment = false,
      relationalAdjustmentTriggered = false,
      isRecallRequest = false,
      explorationCalibrationLevel = null,
      explorationDirectivityLevel = 0,
      explorationRelanceWindow = [],
      explorationSubmode = null,
      therapeuticAllianceSource = null,
      rewriteSource = null,
      memoryRewriteSource = null,
      memoryCompressed = false,
      memoryBeforeCompression = null,
      soberReadjustmentOriginalReply = null,
      criticTriggered = false,
      criticIssues = [],
      // Posture contract (V3)
      writerMode = null,
      intent = null,
      forbidden = [],
      confidenceSignal = "high",
      // Phase B structural flags
      allianceState = "good",
      engagementLevel = "active",
      stagnationTurns = 0,
      processingWindow = "open",
      dependencyRiskScore = 0,
      dependencyRiskLevel = "low",
      externalSupportMode = "none",
      closureIntent = false,
      promptRegistry = activePromptRegistry
    } = {}) {
      return {
        topChips: buildTopChips({
          suicideLevel,
          mode,
          infoSubmode,
          contactSubmode,
          explorationSubmode,
          interpretationRejection,
          isRecallRequest,
          needsSoberReadjustment,
          relationalAdjustmentTriggered
        }),
        memory: normalizeMemory(memory, promptRegistry),
        directivityText: buildDirectivityText({
          mode,
          explorationCalibrationLevel,
          explorationDirectivityLevel,
          explorationRelanceWindow
        }),
        conversationStateKey: normalizeConversationStateKey(conversationStateKey),
        consecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(consecutiveNonExplorationTurns),
        infoSubmode: normalizeInfoSubmode(infoSubmode),
        contactSubmode: normalizeContactSubmode(contactSubmode),
        interpretationRejection: interpretationRejection === true,
        needsSoberReadjustment: needsSoberReadjustment === true,
        relationalAdjustmentTriggered: relationalAdjustmentTriggered === true,
        pipelineStages: chatStageTimings.map((entry) => ({
          stage: typeof entry?.stage === "string" ? entry.stage : null,
          deltaMs: Number.isFinite(entry?.deltaMs) ? entry.deltaMs : null
        })).filter((entry) => entry.stage),
        explorationCalibrationLevel: explorationCalibrationLevel !== null && explorationCalibrationLevel !== undefined ?
          clampExplorationDirectivityLevel(explorationCalibrationLevel) :
          null,
        explorationSubmode: mode === "exploration" && typeof explorationSubmode === "string" ? explorationSubmode : null,
        therapeuticAllianceSource: typeof therapeuticAllianceSource === "string" ? therapeuticAllianceSource : null,
        rewriteSource: typeof rewriteSource === "string" ? rewriteSource : null,
        memoryRewriteSource: typeof memoryRewriteSource === "string" ? memoryRewriteSource : null,
        memoryCompressed: memoryCompressed === true,
        memoryBeforeCompression:
          memoryCompressed === true && typeof memoryBeforeCompression === "string" ?
            normalizeMemory(memoryBeforeCompression, promptRegistry) :
            null,
        soberReadjustmentOriginalReply: typeof soberReadjustmentOriginalReply === "string" ? soberReadjustmentOriginalReply : null,
        criticTriggered: criticTriggered === true,
        criticIssues: Array.isArray(criticIssues) ? criticIssues : [],
        // Posture contract (V3)
        writerMode: typeof writerMode === "string" ? writerMode : null,
        intent: typeof intent === "string" ? intent : null,
        forbidden: Array.isArray(forbidden) ? forbidden : [],
        confidenceSignal: typeof confidenceSignal === "string" ? confidenceSignal : "high",
        // Phase B structural flags
        allianceState: normalizeAllianceState(allianceState),
        engagementLevel: normalizeEngagementLevel(engagementLevel),
        stagnationTurns: normalizeStagnationTurns(stagnationTurns),
        processingWindow: normalizeProcessingWindow(processingWindow),
        dependencyRiskScore: clampDependencyRiskScore(dependencyRiskScore),
        dependencyRiskLevel: normalizeDependencyRiskLevel(dependencyRiskLevel),
        externalSupportMode: normalizeExternalSupportMode(externalSupportMode),
        closureIntent: closureIntent === true
      };
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
    
    // 1) Analyse suicide : risque immÃ©diat et clarification possible.
    // Cette Ã©tape peut dÃ©clencher des rÃ©ponses priorisÃ©es sans aller plus loin.
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
    
    let newFlags = normalizeSessionFlags(flags);
    newFlags.infoSubmode = null;
    newFlags.explorationCalibrationLevel = 0;
    
    // Severe suicide risk override path.
    // If the analysis returns N2, we bypass normal generation and reply with a crisis response.
    if (suicide.suicideLevel === "N2") {
      newFlags.acuteCrisis = true;
      newFlags.contactState = { wasContact: false };
      flagsForCatch = normalizeSessionFlags(newFlags);

      logChatDecision("override_n2", {
        acuteCrisisAfter: true
      });
      
      const debug = buildDebug("override", {
        suicideLevel: "N2"
      });
      
      const reply = n2Response();
      const responseMemory = previousMemory;
      
      const responseDebugMeta = buildResponseDebugMeta({
        memory: responseMemory,
        suicideLevel: "N2",
        mode: null,
        isRecallRequest: false,
        explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
        explorationRelanceWindow: newFlags.explorationRelanceWindow,
        rewriteSource: null,
        memoryRewriteSource: null,
        modelConflict: false,
        promptRegistry: activePromptRegistry
      });
      
      const botMessageId = await persistAssistantMessage(reply, debug, responseDebugMeta, { memory: responseMemory, flags: newFlags });
      await maybeGenerateConversationTitle();
      
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
      if (suicide.crisisResolved !== true) {
        newFlags.acuteCrisis = true;
        newFlags.contactState = { wasContact: false };
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
        
        const botMessageId = await persistAssistantMessage(reply, debug, responseDebugMeta, { memory: responseMemory, flags: newFlags });
        await maybeGenerateConversationTitle();
        
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
    
    // 3) Clarification path for less severe suicidal risk or ambiguous intent.
    if (suicide.suicideLevel === "N1" || suicide.needsClarification) {
      logChatDecision("override_clarification", {
        suicideLevel: suicide.suicideLevel,
        needsClarification: suicide.needsClarification === true
      });

      const rawReply = await n1ResponseLLM(message, activePromptRegistry);
      
      const replyPipeline = await applyModelConflictPipeline({
        content: rawReply,
        message,
        history: recentHistory,
        memory: previousMemory,
        promptRegistry: activePromptRegistry
      });
      
      newFlags.contactState = { wasContact: false };
      flagsForCatch = normalizeSessionFlags(newFlags);
      
      const debug = buildDebug("clarification", {
        suicideLevel: "N1",
        modelConflict: replyPipeline.modelConflict
      });
      
      if (logsEnabled && replyPipeline.rewriteSource) {
        debug.push(`rewriteSource: ${replyPipeline.rewriteSource}`);
      }
      
      const responseMemory = previousMemory;
      const responseDebugMeta = buildResponseDebugMeta({
        memory: responseMemory,
        suicideLevel: "N1",
        mode: null,
        isRecallRequest: false,
        explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
        explorationRelanceWindow: newFlags.explorationRelanceWindow,
        rewriteSource: replyPipeline.rewriteSource,
        memoryRewriteSource: null,
        modelConflict: replyPipeline.modelConflict,
        promptRegistry: activePromptRegistry
      });
      
      const botMessageId = await persistAssistantMessage(replyPipeline.content, debug, responseDebugMeta, { memory: responseMemory, flags: newFlags });
      await maybeGenerateConversationTitle();
      
      return res.json({
        conversationId,
        reply: replyPipeline.content,
        memory: responseMemory,
        flags: newFlags,
        debug,
        debugMeta: responseDebugMeta,
        botMessageId
      });
    }
    
    // 2) Analyse de rappel mÃ©moire : identifier si l'utilisateur demande
    // explicitement un rappel de la mÃ©moire Ã  long terme.
    markChatStage("recall_analysis");
    const [recallRouting, precomputedContactAnalysis] = await Promise.all([
      analyzeRecallRouting(
        message,
        recentHistory,
        previousMemory,
        activePromptRegistry
      ),
      analyzeContactState(
        message,
        recentHistory,
        newFlags.contactState,
        activePromptRegistry
      )
    ]);
    throwIfCanceled();

    logChatDecision("recall_routing", {
      isRecallAttempt: recallRouting.isRecallAttempt === true,
      isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall === true,
      calledMemory: recallRouting.calledMemory || "none"
    });
    
    if (recallRouting.isLongTermMemoryRecall) {
      const recallConversationBranchHistory = await loadConversationBranchHistoryForRecall({
        conversationId,
        isPrivateConversation,
        conversationBranchHistory,
        recentHistory
      });

      const rawReply = await buildLongTermMemoryRecallResponse({
        memory: previousMemory,
        conversationBranchHistory: recallConversationBranchHistory,
        promptRegistry: activePromptRegistry
      });
      
      const replyPipeline = await applyModelConflictPipeline({
        content: rawReply,
        message,
        history: recentHistory,
        memory: previousMemory,
        promptRegistry: activePromptRegistry
      });
      
      const debug = buildDebug("memoryRecall", {
        calledMemory: "longTermMemory",
        modelConflict: replyPipeline.modelConflict
      });
      
      if (logsEnabled && replyPipeline.rewriteSource) {
        debug.push(`rewriteSource: ${replyPipeline.rewriteSource}`);
      }
      
      const responseMemory = previousMemory;
      const responseDebugMeta = buildResponseDebugMeta({
        memory: responseMemory,
        suicideLevel: "N0",
        mode: null,
        isRecallRequest: true,
        explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
        explorationRelanceWindow: newFlags.explorationRelanceWindow,
        rewriteSource: replyPipeline.rewriteSource,
        memoryRewriteSource: null,
        modelConflict: replyPipeline.modelConflict,
        promptRegistry: activePromptRegistry
      });
      
      const botMessageId = await persistAssistantMessage(replyPipeline.content, debug, responseDebugMeta, { memory: responseMemory, flags: newFlags });
      await maybeGenerateConversationTitle();
      
      return res.json({
        conversationId,
        reply: replyPipeline.content,
        memory: responseMemory,
        flags: newFlags,
        debug,
        debugMeta: responseDebugMeta,
        botMessageId
      });
    }
    
    // 5) Memory recall attempted, but no recallable memory was found.
    if (recallRouting.isRecallAttempt && recallRouting.calledMemory === "none") {
      const reply = buildNoMemoryRecallResponse();
      const debug = buildDebug("memoryRecall", {});
      const responseMemory = previousMemory;
      const responseDebugMeta = buildResponseDebugMeta({
        memory: responseMemory,
        suicideLevel: "N0",
        mode: null,
        isRecallRequest: true,
        explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
        explorationRelanceWindow: newFlags.explorationRelanceWindow,
        rewriteSource: null,
        memoryRewriteSource: null,
        modelConflict: false,
        promptRegistry: activePromptRegistry
      });
      
      const botMessageId = await persistAssistantMessage(reply, debug, responseDebugMeta, { memory: responseMemory, flags: newFlags });
      await maybeGenerateConversationTitle();
      
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
    
    // Determine whether the current message should be handled as a contact-style interaction.
    // This influences mode detection and the choice between contact, info, or exploration flows.
    // 3) Passage par le mode contact / exploration / info.
    // Cette Ã©tape dÃ©termine le style gÃ©nÃ©ral de la rÃ©ponse.
    markChatStage("contact_mode_analysis");
    let contactAnalysis = precomputedContactAnalysis;
    throwIfCanceled();
    
    newFlags.contactState = {
      wasContact: contactAnalysis.isContact === true
    };
    
    const effectiveExplorationDirectivityLevel = newFlags.explorationDirectivityLevel;
    
    let finalDirectivityLevel = effectiveExplorationDirectivityLevel;
    let finalExplorationSubmode = "interpretation";

    // Phase 2: run independent analyzers in parallel, including detectMode.
    const shouldRunNonContactAnalyzers = contactAnalysis.isContact !== true;
    const [
      detectedModeResult,
      relationalAdjustmentAnalysis,
      calibrationAnalysis,
      interpretationRejection
    ] = await Promise.all([
      contactAnalysis.isContact
        ? Promise.resolve({
            mode: "contact",
            infoSource: null,
            infoSubmode: null,
            infoSubmodeSource: null,
            contactSubmode: normalizeContactSubmode(contactAnalysis.contactSubmode) || "regulated"
          })
        : detectMode(message, recentHistory, activePromptRegistry),
      shouldRunNonContactAnalyzers
        ? analyzeRelationalAdjustmentNeed(message, recentHistory, previousMemory, false, activePromptRegistry)
        : Promise.resolve(null),
      shouldRunNonContactAnalyzers
        ? analyzeExplorationCalibration({
            message,
            history: recentHistory,
            memory: previousMemory,
            explorationDirectivityLevel: effectiveExplorationDirectivityLevel,
            explorationRelanceWindow: newFlags.explorationRelanceWindow,
            promptRegistry: activePromptRegistry
          })
        : Promise.resolve(null),
      shouldRunNonContactAnalyzers
        ? analyzeInterpretationRejection({
            message,
            history: recentHistory,
            memory: previousMemory,
            promptRegistry: activePromptRegistry
          })
        : Promise.resolve({ isInterpretationRejection: false, needsSoberReadjustment: false })
    ]);
    throwIfCanceled();

    const detectedMode = detectedModeResult.mode;
    const detectedInfoSubmode = detectedMode === "info" ? normalizeInfoSubmode(detectedModeResult.infoSubmode) : null;
    const detectedContactSubmode = detectedMode === "contact" ? normalizeContactSubmode(detectedModeResult.contactSubmode) : null;
    const safeInterpretationRejection = detectedMode === "exploration"
      ? (interpretationRejection || { isInterpretationRejection: false, needsSoberReadjustment: false })
      : { isInterpretationRejection: false, needsSoberReadjustment: false };

    modeForCatch = detectedMode;
    infoSubmodeForCatch = detectedInfoSubmode;
    contactSubmodeForCatch = detectedContactSubmode;

    // Phase 3: Deterministic arbitrator â€” consolidate all analyzer outputs into a
    // PostureDecision struct. No LLM calls, no side effects outside this block.
    const previousConversationStateKey = normalizeConversationStateKey(flags.conversationStateKey);
    const postureDecision = buildPostureDecision({
      detectedMode,
      detectedInfoSubmode,
      contactAnalysis,
      relationalAdjustmentAnalysis,
      calibrationAnalysis,
      interpretationRejection: safeInterpretationRejection,
      effectiveExplorationDirectivityLevel,
      previousConversationStateKey,
      currentConsecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(newFlags.consecutiveNonExplorationTurns),
      currentExplorationRelanceWindow: newFlags.explorationRelanceWindow,
      // Phase B structural flags passed in for Phase C state transitions
      allianceState: newFlags.allianceState,
      engagementLevel: newFlags.engagementLevel,
      stagnationTurns: newFlags.stagnationTurns,
      processingWindow: newFlags.processingWindow,
      closureIntent: newFlags.closureIntent,
      // Contract inputs for confidenceSignal computation
      message,
      recentHistory,
    });

    const finalDetectedMode = postureDecision.finalDetectedMode;
    finalDirectivityLevel = postureDecision.finalDirectivityLevel;
    finalExplorationSubmode = postureDecision.finalExplorationSubmode;
    const { conversationStateKey, consecutiveNonExplorationTurns } = postureDecision;

    Object.assign(newFlags, postureDecision.flagUpdates);
    flagsForCatch = normalizeSessionFlags(newFlags);

    if (postureDecision.relationalAdjustmentTriggered) {
      logChatDecision("relational_adjustment_caps_directivity", {
        previousLevel: postureDecision.preAdjustmentDirectivityLevel,
        cappedLevel: postureDecision.finalDirectivityLevel,
        relationalAdjustmentTriggered: true
      });
    }

    logChatDecision("mode_detected", {
      detectedMode,
      finalDetectedMode,
      infoSubmode: detectedInfoSubmode,
      contactSubmode: detectedContactSubmode,
      isContact: contactAnalysis.isContact === true,
      relationalAdjustmentTriggered: postureDecision.relationalAdjustmentTriggered,
      previousWasContact: flags.contactState?.wasContact === true,
      currentWasContact: newFlags.contactState?.wasContact === true,
      previousConversationStateKey,
      conversationStateKey,
      consecutiveNonExplorationTurns,
      finalDirectivityLevel,
      finalExplorationSubmode
    });
    
    // 4) GÃ©nÃ©ration principale de la rÃ©ponse selon le mode dÃ©tectÃ©,
    // puis application d'un pipeline de correction si le contenu est en conflit modÃ¨le.
    markChatStage("reply_generation");

    const generatedBase = await generateReply({
      message,
      history: recentHistory,
      memory: previousMemory,
      postureDecision,
      infoSubmode: detectedInfoSubmode,
      contactSubmode: detectedContactSubmode,
      interpretationRejection: safeInterpretationRejection,
      promptRegistry: activePromptRegistry,
    });
    throwIfCanceled();

    let reply = generatedBase.reply;
    let soberReadjustmentOriginalReply = null;

    let relanceAnalysis = null;
    const finalReplyRewriteSources = [];

    // Phase 4: Selective critic - single guardrail for exploration, contact, and info.
    // CRITIC_PASS now covers theoretical violations. No separate conflict-model or uncertainty passes.
    let criticTriggered = false;
    let criticIssues = [];
    let humanFieldRisk = false;
    let contractLengthExceeded = false;
    const criticModes = ["exploration", "contact", "info"];
    const criticApplies = criticModes.includes(finalDetectedMode);
    if (criticApplies) {
      const sentenceCount = String(reply || "")
        .split(/[.!?]+/)
        .map(chunk => chunk.trim())
        .filter(Boolean).length;
      contractLengthExceeded = Number.isFinite(postureDecision.maxSentences)
        && postureDecision.maxSentences > 0
        && sentenceCount > postureDecision.maxSentences;
      humanFieldRisk = postureDecision.humanFieldGuardActive === true && isProceduralInstrumentalReply(reply);
      const criticShouldTrigger =
        contractLengthExceeded ||
        humanFieldRisk ||
        hasAgencyInjectionInReply(reply) ||
        hasTheoreticalViolationHeuristic(reply);
      if (criticShouldTrigger) {
        const criticResult = await applySelectiveCritic({
          reply,
          message,
          history: recentHistory,
          postureDecision,
          promptRegistry: activePromptRegistry
        });
        throwIfCanceled();
        criticTriggered = true;
        criticIssues = criticResult.criticIssues;
        if (criticResult.criticIssues.length > 0) {
          reply = criticResult.reply;
          finalReplyRewriteSources.push("critic_pass");
        }
      }
    }

    const finalReplyRewriteSource = finalReplyRewriteSources.join("+") || null;
    const therapeuticAllianceSource = null;
    
    if (finalDetectedMode === "exploration") {
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
    
    const debug = buildDebug(finalDetectedMode, {
      suicideLevel: suicide.suicideLevel,
      calledMemory: recallRouting.calledMemory,
      modelConflict,
      infoSubmode: detectedInfoSubmode,
      contactSubmode: detectedContactSubmode,
      interpretationRejection: safeInterpretationRejection.isInterpretationRejection,
      needsSoberReadjustment: safeInterpretationRejection.needsSoberReadjustment,
      relationalAdjustmentTriggered: relationalAdjustmentAnalysis?.needsRelationalAdjustment === true,
      explorationCalibrationLevel: newFlags.explorationCalibrationLevel,
      explorationDirectivityLevel: finalDirectivityLevel,
      explorationRelanceWindow: newFlags.explorationRelanceWindow,
    });
    
    if (logsEnabled && finalReplyRewriteSource) {
      debug.push(`rewriteSource: ${finalReplyRewriteSource}`);
    }

    if (logsEnabled) {
      debug.push(
        ...buildAdvancedDebugTrace({
          suicide,
          recallRouting,
          contactAnalysis,
          contactSubmode: detectedContactSubmode,
          detectedMode: finalDetectedMode,
          relationalAdjustmentAnalysis,
          infoSubmode: detectedInfoSubmode,
          interpretationRejection: safeInterpretationRejection,
          explorationCalibrationLevel: newFlags.explorationCalibrationLevel,
          flagsBefore: flags,
          flagsAfter: newFlags,
          generatedBase,
          relanceAnalysis
        })
      );

      debug.push(`trace.explorationSubmode: ${finalExplorationSubmode}`);
    }
    

    // 5) Mise Ã  jour de la mÃ©moire interne aprÃ¨s la rÃ©ponse finale.
    markChatStage("memory_update");
    const rawNewMemory = await updateMemory(
      previousMemory,
      [
        ...recentHistory,
        { role: "user", content: message },
        { role: "assistant", content: reply }
      ],
      activePromptRegistry
    );
    throwIfCanceled();

    let memoryCandidate = rawNewMemory;
    const memoryBeforeCompression = memoryCandidate;
    const memoryNeedsCompression = shouldCompressMemoryCandidate(memoryCandidate);
    const finalizedMemoryCandidate = await finalizeMemoryCandidate({
      previousMemory,
      candidateMemory: memoryCandidate,
      interpretationRejection: safeInterpretationRejection,
      needsCompression: memoryNeedsCompression,
      promptRegistry: activePromptRegistry
    });
    const memoryWasCompressed = memoryNeedsCompression && finalizedMemoryCandidate !== memoryCandidate;
    const memoryRewriteSource = finalizedMemoryCandidate !== memoryCandidate ? memoryCandidate : null;
    const newMemory = finalizedMemoryCandidate;
    
    if (logsEnabled && memoryRewriteSource) {
      debug.push(`memoryRewriteSource: ${memoryRewriteSource}`);
    }
    if (logsEnabled) {
      debug.push(`trace.memoryCompressed: ${memoryWasCompressed ? "true" : "false"}`);
    }
    
    console.log("[COMPARE][MAIN]", {
      activeUpdateMemoryPreview: String(activePromptRegistry?.UPDATE_MEMORY || "").slice(0, 160),
      newMemory
    });
    
    const responseDebugMeta = buildResponseDebugMeta({
      memory: newMemory,
      suicideLevel: suicide.suicideLevel,
      mode: finalDetectedMode,
      conversationStateKey: newFlags.conversationStateKey,
      consecutiveNonExplorationTurns: newFlags.consecutiveNonExplorationTurns,
      infoSubmode: detectedInfoSubmode,
      contactSubmode: detectedContactSubmode,
      interpretationRejection: safeInterpretationRejection.isInterpretationRejection,
      needsSoberReadjustment: safeInterpretationRejection.needsSoberReadjustment,
      relationalAdjustmentTriggered: relationalAdjustmentAnalysis?.needsRelationalAdjustment === true,
      isRecallRequest: recallRouting.isRecallAttempt === true,
      explorationCalibrationLevel: newFlags.explorationCalibrationLevel,
      explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
      explorationRelanceWindow: newFlags.explorationRelanceWindow,
      explorationSubmode: finalExplorationSubmode,
      therapeuticAllianceSource,
      rewriteSource: finalReplyRewriteSource,
      memoryRewriteSource,
      memoryCompressed: memoryWasCompressed,
      memoryBeforeCompression,
      soberReadjustmentOriginalReply,
      criticTriggered,
      criticIssues,
      humanFieldRisk,
      contractLengthExceeded,
      // Posture contract fields (V3)
      writerMode: postureDecision.writerMode,
      intent: postureDecision.intent,
      forbidden: postureDecision.forbidden,
      confidenceSignal: postureDecision.confidenceSignal,
      // Phase B structural flags
      allianceState: newFlags.allianceState,
      engagementLevel: newFlags.engagementLevel,
      stagnationTurns: newFlags.stagnationTurns,
      processingWindow: newFlags.processingWindow,
      dependencyRiskScore: newFlags.dependencyRiskScore,
      dependencyRiskLevel: newFlags.dependencyRiskLevel,
      externalSupportMode: newFlags.externalSupportMode,
      closureIntent: newFlags.closureIntent,
      promptRegistry: activePromptRegistry
    });

    if (logsEnabled) {
      console.log("[PIPELINE]", {
        conversationId,
        requestId: requestId || null,
        elapsedMs: Date.now() - chatStartTime,
        suicideLevel: suicide.suicideLevel,
        mode: finalDetectedMode,
        conversationStateKey: responseDebugMeta.conversationStateKey,
        infoSubmode: responseDebugMeta.infoSubmode,
        interpretationRejection: responseDebugMeta.interpretationRejection === true,
        needsSoberReadjustment: responseDebugMeta.needsSoberReadjustment === true,
        relationalAdjustmentTriggered: responseDebugMeta.relationalAdjustmentTriggered === true,
        criticTriggered: responseDebugMeta.criticTriggered === true,
        criticIssues: Array.isArray(responseDebugMeta.criticIssues) ? responseDebugMeta.criticIssues : [],
        writerMode: responseDebugMeta.writerMode,
        confidenceSignal: responseDebugMeta.confidenceSignal,
        explorationCalibrationLevel: responseDebugMeta.explorationCalibrationLevel,
        explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
        rewriteSource: responseDebugMeta.rewriteSource,
        stageTimings: chatStageTimings
      });
    }
    

    markChatStage("persist_response");
    throwIfCanceled();

    const botMessageId = await persistAssistantMessage(reply, debug, responseDebugMeta, { memory: newMemory, flags: newFlags });
    await maybeGenerateConversationTitle();
    
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
      // Mark the user message with [ENVOI STOPPE] if it was persisted
      if (userMessageRefForCatch && userMessagePersistedForCatch) {
        try {
          const snapshot = await userMessageRefForCatch.once("value");
          const messageData = snapshot.val();
          if (messageData && typeof messageData.content === "string") {
            let newContent = messageData.content;
            // Replace [MODIFIÃ‰] with [ENVOI STOPPE] if present, otherwise append it
            if (newContent.includes("[MODIFIÃ‰]")) {
              newContent = newContent.replace(/\n?\[MODIFIÃ‰\]$/, "\n[ENVOI STOPPE]");
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
    console.error("[CHAT][ERROR_CONTEXT]", {
      conversationId: requestData.conversationId,
      lastStage: chatLastStage,
      elapsedMs: Date.now() - chatStartTime,
      stageTimings: chatStageTimings
    });

    const isQuotaExhausted = err && (err.code === "insufficient_quota" || err.type === "insufficient_quota");
    const fallbackReply = isQuotaExhausted
      ? "Le service est temporairement indisponible car le quota API est epuise. Je ne peux pas traiter de nouveau message tant que ce quota n'est pas retabli."
      : modeForCatch === "contact"
        ? "Je suis la."
        : "Desole, reformule.";
    const fallbackDebugMeta = buildFallbackResponseDebugMeta({
      memory: previousMemoryForCatch,
      suicideLevel: "N0",
      mode: modeForCatch,
      infoSubmode: infoSubmodeForCatch,
      contactSubmode: contactSubmodeForCatch,
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
});
