require('dotenv').config();

// Main server entry point.
// - initialize Firebase admin with credentials
// - configure Express, static asset headers, and chat pipeline
// - preserve existing behavior while making the code easier to follow
const admin = require('firebase-admin');
const { parseAppConfig, resolveServiceAccount } = require('./lib/config');
const { childLogger } = require('./lib/logger');
const {
  chatRequestSchema,
  stateProposalSchema,
  postureDecisionSchema,
  debugMetaSchema,
  validateShape
} = require('./lib/runtime-schemas');
const {
  MONTHLY_CAPACITY,
  RESERVE_CAPACITY,
  getEnvelopeState,
  consumeEnvelope,
  applyMonthlyRenewal
} = require('./lib/usage-envelope');

const appConfig = parseAppConfig(process.env);
const serviceAccount = resolveServiceAccount(appConfig);
const logger = childLogger({ scope: 'server' });

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: appConfig.firebaseDatabaseUrl
});
const db = admin.database();
const messagesRef = db.ref('messages');
const userLabelsRef = db.ref('userLabels');
const usersRef = db.ref('users');
const privateConversationMemoryRef = db.ref('privateConversationMemory');
const accountArchivesRef = db.ref('accountArchives');
const accountResetAuditsRef = db.ref('accountResetAudits');
const adminSettingsRef = db.ref('adminSettings');
const branchRecordsRef = db.ref('branches');
const branchSeedSnapshotsRef = db.ref('branchSeeds');
const crypto = require('crypto');
const ADMIN_PASSWORD = appConfig.adminPassword;
const ADMIN_REVIEW_PASSWORD = 'Review.615243';
const ADMIN_PASSWORD_SET = new Set(
  [ADMIN_PASSWORD, ADMIN_REVIEW_PASSWORD]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
);
const SESSION_SECRET = appConfig.sessionSecret;
const adminSessions = new Map(); // sessionId -> { isAdmin: true, createdAt }
const ADMIN_SESSION_DURATION = 24 * 60 * 60 * 1000; // 24h
const ADMIN_SESSION_SIGNING_SECRET =
  appConfig.adminSessionSecret ||
  SESSION_SECRET ||
  ADMIN_PASSWORD ||
  'dev-admin-session-secret';
const userSessions = new Map(); // sessionToken -> { userId, createdAt }
const USER_SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30d
const ACCOUNT_RESET_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const USER_SESSION_SIGNING_SECRET =
  appConfig.userSessionSecret ||
  SESSION_SECRET ||
  ADMIN_PASSWORD ||
  'dev-user-session-secret';
const USAGE_SIMULATION_FROZEN_MODEL = 'gpt-4.1';
const USAGE_SIMULATION_PHASE_LABEL = 'phase de test';
const USAGE_SIMULATION_PAYMENT_ACTIVE = false;
const USAGE_SIMULATION_GPT41_EUR_PER_1M_TOKENS = 4;
const USAGE_SIMULATION_MARGIN_MULTIPLIER = 2;
// Biometric unlock tokens: sessionToken -> { userId, expiresAt }
const biometricUnlockTokens = new Map();
const BIOMETRIC_UNLOCK_TOKEN_DURATION = 10 * 60 * 1000; // 10 minutes

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// --- Emergency numbers --------------------------------------------------------
const EMERGENCY_NUMBERS_FILE = path.join(
  __dirname,
  'data/emergency-numbers.json'
);
const {
  updateEmergencyNumbers: runEmergencyNumbersUpdate
} = require('./lib/emergency-updater');
let emergencyNumbers = {};
try {
  const raw = fs.readFileSync(EMERGENCY_NUMBERS_FILE, 'utf-8');
  const parsed = JSON.parse(raw);
  // Strip internal _meta key
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.startsWith('_')) emergencyNumbers[k] = v;
  }
} catch {
  // Non-blocking: fallback text will be used if file is missing
}

let emergencyRefreshInProgress = false;
let lastEmergencyRefreshAt = 0;

const EMERGENCY_REFRESH_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const EMERGENCY_REFRESH_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REFRESH_EMERGENCY_ON_BOOT = appConfig.refreshEmergencyOnBoot;

async function safeRefreshEmergencyNumbers(reason = 'interval') {
  const now = Date.now();

  if (emergencyRefreshInProgress) {
    logger.info({
      event: 'emergency_refresh_skipped',
      reason,
      detail: 'already_in_progress'
    });
    return;
  }

  if (
    lastEmergencyRefreshAt > 0 &&
    now - lastEmergencyRefreshAt < EMERGENCY_REFRESH_MIN_INTERVAL_MS
  ) {
    logger.info({
      event: 'emergency_refresh_skipped',
      reason,
      detail: 'too_recent'
    });
    return;
  }

  emergencyRefreshInProgress = true;
  lastEmergencyRefreshAt = now;

  try {
    const updated = await runEmergencyNumbersUpdate(
      EMERGENCY_NUMBERS_FILE,
      '[server][emergency-refresh]'
    );
    emergencyNumbers = updated;
    logger.info({ event: 'emergency_refresh_updated' });
  } catch (err) {
    logger.error({ event: 'emergency_refresh_failed', error: err.message });
  } finally {
    emergencyRefreshInProgress = false;
  }
}

function normalizeCountryCode(value) {
  const code = String(value || '')
    .trim()
    .toUpperCase();
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
  if (emergencyInfo.emergency)
    parts.push(`urgences : ${emergencyInfo.emergency}`);
  if (emergencyInfo.suicide)
    parts.push(`prévention suicide : ${emergencyInfo.suicide}`);
  return parts.join(' | ') || null;
}

function buildEmergencyFallbackGuidance() {
  return "Si ces numéros ne sont pas disponibles pour votre pays, appelez le numéro d'urgence local de votre opérateur téléphonique ou recherchez 'numéro urgence + votre pays' et 'ligne prévention suicide + votre pays'.";
}
// -----------------------------------------------------------------------------
const {
  clampDependencyRiskScore,
  clampExplorationDirectivityLevel,
  normalizeAllianceState,
  normalizeAffiliationWindow,
  normalizeConversationState,
  normalizeConsecutiveNonExplorationTurns,
  normalizeDependencyRiskLevel,
  normalizeEngagementLevel,
  normalizeExternalSupportMode,
  normalizeFlags,
  normalizeAttentionWindow,
  normalizeSessionFlags,
  registerExplorationRelance
} = require('./lib/flags');
const { createAnalyzers } = require('./lib/analyzers');
const { createMemoryHelpers } = require('./lib/memory');
const {
  buildAdvancedDebugTrace,
  buildDebug,
  buildPostureDecision,
  computeAffiliationTurnDetails,
  computeAffiliationFinalScore,
  computeAffiliationEstablished,
  electActiveStateFromCandidates,
  hasShortAffiliationMarker,
  normalizeGuardText,
  shouldForceExplorationForSituatedImpasse
} = require('./lib/pipeline');
const { buildDefaultPromptRegistry } = require('./lib/prompts');
const {
  buildTopChips,
  buildDirectivityText,
  buildResponseDebugMeta: _buildResponseDebugMeta
} = require('./lib/debugmeta');
const {
  resolveChatPriorityRule,
  buildCrisisRoutingDecision,
  buildSafetyRoutingDecision
} = require('./lib/chat-routing');
const { resolveBranchSeedPayload } = require('./lib/branching');
const { createWriter } = require('./lib/writer');

const express = require('express');
const OpenAI = require('openai');
const http = require('http');
const https = require('https');
const { AsyncLocalStorage } = require('async_hooks');

const app = express();
const port = appConfig.port;

function buildRequestId(prefix = 'req') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function getClientIpAddress(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').trim();
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim() || req.ip || req.socket?.remoteAddress || 'unknown';
  }

  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createInMemoryRateLimiter({ windowMs, max }) {
  const buckets = new Map();

  function readBucket(key, now = Date.now()) {
    const safeKey = String(key || '').trim();
    if (!safeKey) return null;

    const existing = buckets.get(safeKey);
    if (!existing || existing.resetAt <= now) {
      const fresh = { count: 0, resetAt: now + windowMs };
      buckets.set(safeKey, fresh);
      return fresh;
    }

    return existing;
  }

  return {
    check(key) {
      const now = Date.now();
      const bucket = readBucket(key, now);
      if (!bucket) {
        return { allowed: true, remaining: max, resetAt: now + windowMs };
      }

      if (bucket.count >= max) {
        return {
          allowed: false,
          remaining: 0,
          resetAt: bucket.resetAt
        };
      }

      bucket.count += 1;
      buckets.set(String(key || '').trim(), bucket);

      return {
        allowed: true,
        remaining: Math.max(0, max - bucket.count),
        resetAt: bucket.resetAt
      };
    },
    reset(key) {
      buckets.delete(String(key || '').trim());
    }
  };
}

const authRateLimiters = {
  login: createInMemoryRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 }),
  register: createInMemoryRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 })
};

function buildAuthRateLimitKey(req, scope, extra = '') {
  const ip = getClientIpAddress(req);
  const normalizedExtra = String(extra || '').trim().toLowerCase();
  return [scope, ip, normalizedExtra].filter(Boolean).join('|');
}

function enforceAuthRateLimit(req, res, scope, extra = '') {
  const limiter = authRateLimiters[scope];
  if (!limiter) return true;

  const key = buildAuthRateLimitKey(req, scope, extra);
  const result = limiter.check(key);
  if (result.allowed) return true;

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((result.resetAt - Date.now()) / 1000)
  );
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    error: 'Too many attempts. Please wait before trying again.'
  });
}

function isStrongPassword(value = '') {
  const password = String(value || '');
  return password.length >= 10 && /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(password) && /\d/.test(password);
}

function buildPrivateConversationMemoryPayload({
  memory = '',
  memoryState = {},
  memoryRewriteDebug = null,
  updatedAt = new Date().toISOString()
} = {}) {
  return {
    memory: typeof memory === 'string' ? memory : '',
    memoryState:
      memoryState && typeof memoryState === 'object' && !Array.isArray(memoryState)
        ? memoryState
        : {},
    memoryRewriteDebug:
      memoryRewriteDebug && typeof memoryRewriteDebug === 'object'
        ? memoryRewriteDebug
        : null,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : new Date().toISOString()
  };
}

async function readPrivateConversationMemory(conversationId = '') {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) return null;

  try {
    const snap = await privateConversationMemoryRef
      .child(safeConversationId)
      .once('value');
    const data = snap.val();
    if (!data || typeof data !== 'object') return null;

    return buildPrivateConversationMemoryPayload({
      memory: typeof data.memory === 'string' ? data.memory : '',
      memoryState:
        data.memoryState && typeof data.memoryState === 'object'
          ? data.memoryState
          : {},
      memoryRewriteDebug:
        data.memoryRewriteDebug && typeof data.memoryRewriteDebug === 'object'
          ? data.memoryRewriteDebug
          : null,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString()
    });
  } catch {
    return null;
  }
}

async function persistPrivateConversationMemory(conversationId = '', payload = {}) {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) return;

  await privateConversationMemoryRef
    .child(safeConversationId)
    .set(buildPrivateConversationMemoryPayload(payload));
}

function normalizeSuperId(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^sup_[a-f0-9]{12,}$/i.test(raw) ? raw.toLowerCase() : '';
}

function buildSuperId() {
  return `sup_${crypto.randomBytes(10).toString('hex')}`;
}

function resolveStableSuperId(userId = '', userData = null) {
  const safeUserData = userData && typeof userData === 'object' ? userData : {};
  const fromUser = normalizeSuperId(safeUserData.superId);
  if (fromUser) return fromUser;

  const fallbackSeed = String(userId || '').trim();
  if (fallbackSeed) {
    return `sup_${buildAccountResetAuditHash(fallbackSeed)}`;
  }

  return buildSuperId();
}

app.use((req, res, next) => {
  const headerRequestId =
    typeof req.headers['x-request-id'] === 'string'
      ? String(req.headers['x-request-id']).trim()
      : '';
  const requestId = headerRequestId || buildRequestId('req');

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

const _httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20 });
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 0,
  timeout: 55000,
  httpAgent: _httpsAgent,
  fetchOptions: {
    agent: (url) => (url.startsWith('https') ? _httpsAgent : _httpAgent)
  }
});

const llmUsageContext = new AsyncLocalStorage();

function createLlmUsageAccumulator() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    chargedTokens: 0
  };
}

function normalizeLlmUsage(rawUsage = null) {
  const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage : null;
  if (!usage) return null;

  const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens);
  const completionTokens = Number(
    usage.completion_tokens ?? usage.completionTokens
  );
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens);

  const safePromptTokens =
    Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  const safeCompletionTokens =
    Number.isFinite(completionTokens) && completionTokens > 0
      ? completionTokens
      : 0;
  const safeTotalTokens =
    Number.isFinite(totalTokens) && totalTokens > 0
      ? totalTokens
      : safePromptTokens + safeCompletionTokens;

  if (!(safeTotalTokens > 0)) {
    return null;
  }

  return {
    promptTokens: safePromptTokens,
    completionTokens: safeCompletionTokens,
    totalTokens: safeTotalTokens
  };
}

function appendLlmUsageToCurrentRequest(rawUsage = null) {
  const accumulator = llmUsageContext.getStore();
  if (!accumulator || typeof accumulator !== 'object') {
    return;
  }

  const usage = normalizeLlmUsage(rawUsage);
  if (!usage) {
    return;
  }

  accumulator.promptTokens += usage.promptTokens;
  accumulator.completionTokens += usage.completionTokens;
  accumulator.totalTokens += usage.totalTokens;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableOpenAIError(err) {
  return Boolean(
    err &&
    (err.status === 429 ||
      err.code === 'rate_limit_exceeded' ||
      err.type === 'tokens')
  );
}

function readRetryDelayMs(err, attempt) {
  const retryAfterMsHeader = err?.headers?.get?.('retry-after-ms');
  const retryAfterSecondsHeader = err?.headers?.get?.('retry-after');
  const retryAfterMs = Number.parseInt(String(retryAfterMsHeader || ''), 10);

  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs + 150, 2500);
  }

  const retryAfterSeconds = Number.parseFloat(
    String(retryAfterSecondsHeader || '')
  );
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(Math.ceil(retryAfterSeconds * 1000) + 150, 2500);
  }

  return Math.min(400 * (attempt + 1), 2500);
}

const originalCreateChatCompletion = client.chat.completions.create.bind(
  client.chat.completions
);
client.chat.completions.create = async function createChatCompletionWithRetry(
  ...args
) {
  let attempt = 0;

  while (true) {
    try {
      const response = await originalCreateChatCompletion(...args);
      appendLlmUsageToCurrentRequest(
        response && typeof response === 'object' ? response.usage : null
      );
      return response;
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
  const configuredValue = String(process.env[envKey] || '').trim();
  return configuredValue || fallback;
}

const MODEL_IDS = {
  analysis: readModelId('OPENAI_MODEL_ANALYSIS', 'gpt-4.1-mini'),
  memoryUpdate: readModelId('OPENAI_MODEL_MEMORY_UPDATE', 'gpt-5'),
  memoryUpdateFallback: readModelId(
    'OPENAI_MODEL_MEMORY_UPDATE_FALLBACK',
    'gpt-4.1'
  ),
  generation: readModelId('OPENAI_MODEL_GENERATION', 'gpt-4.1'),
  title: readModelId('OPENAI_MODEL_TITLE', 'gpt-4o-mini')
};

function createEmailNotifier() {
  const notifyTo = String(process.env.NOTIFY_EMAIL_TO || '').trim();
  const smtpHost = String(process.env.NOTIFY_SMTP_HOST || '').trim();
  const smtpPort = Number(process.env.NOTIFY_SMTP_PORT || 587);
  const smtpSecure =
    String(process.env.NOTIFY_SMTP_SECURE || 'false')
      .trim()
      .toLowerCase() === 'true';
  const smtpUser = String(process.env.NOTIFY_SMTP_USER || '').trim();
  const smtpPass = String(process.env.NOTIFY_SMTP_PASSWORD || '').trim();
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
      logger.error({ event: 'notify_email_error', error: err.message });
    }
  }

  return {
    enabled: true,
    async sendNewMessageAlert() {
      await send(
        '[Facilitat.io] Nouveau message utilisateur',
        [
          'Il y a un ou plusieurs nouveaux messages enregistr\u00e9s dans Firebase.',
          "Rappel: une seule alerte est envoy\u00e9e tant que l'admin n'est pas revenue sur /admin.html"
        ].join('\n')
      );
    }
  };
}

const emailNotifier = createEmailNotifier();
const REVIEW_USER_IDS = new Set([
  'u_be427bb5b738c711b0726703',
  'u_ed6c766b0b8666541bf999ed',
  'u_d3d39850658034a1492e9e5f'
]);
const EMAIL_ALERT_EXCLUDED_USER_EMAILS = new Set([
  normalizeEmail('arnaud.connan@gmail.com'),
  normalizeEmail('review@facilitat.io')
]);
let adminVisitedSinceLastAlert = true;
let cachedAdminMailsEnabled = false;
let adminMailsCacheReady = false;

async function shouldSuppressAdminEmailAlertForUser(req, userId = '') {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) {
    return false;
  }

  if (REVIEW_USER_IDS.has(safeUserId)) {
    return true;
  }

  try {
    const session = req && req.userSession ? req.userSession : await getUserSession(req);
    if (session && String(session.userId || '').trim() === safeUserId) {
      const sessionEmail = normalizeEmail(session.user && session.user.email);
      if (sessionEmail) {
        return EMAIL_ALERT_EXCLUDED_USER_EMAILS.has(sessionEmail);
      }
    }

    const userSnap = await usersRef.child(safeUserId).once('value');
    const userData = userSnap.val();
    const userEmail = normalizeEmail(userData && userData.email);
    return userEmail ? EMAIL_ALERT_EXCLUDED_USER_EMAILS.has(userEmail) : false;
  } catch (err) {
    logger.error({
      event: 'admin_email_alert_exclusion_lookup_failed',
      userId: safeUserId,
      error: err.message
    });
    return false;
  }
}

function normalizeMailsEnabledSetting(value) {
  return value !== false;
}

function getCachedAdminMailsEnabled() {
  return cachedAdminMailsEnabled === true;
}

async function bootstrapAdminSettingsCache() {
  try {
    const snap = await adminSettingsRef.child('mailsEnabled').once('value');
    cachedAdminMailsEnabled = normalizeMailsEnabledSetting(snap.val());
    adminMailsCacheReady = true;
    logger.info({
      event: 'admin_settings_cache_initialized',
      mailsEnabled: cachedAdminMailsEnabled
    });
  } catch (err) {
    cachedAdminMailsEnabled = false;
    adminMailsCacheReady = false;
    logger.error({
      event: 'admin_settings_cache_init_failed',
      error: err.message
    });
  }
}

function startAdminSettingsListener() {
  adminSettingsRef.child('mailsEnabled').on(
    'value',
    (snap) => {
      cachedAdminMailsEnabled = normalizeMailsEnabledSetting(snap.val());
      adminMailsCacheReady = true;
    },
    (err) => {
      logger.error({
        event: 'admin_settings_listener_error',
        error: err.message
      });
    }
  );
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/admin.html', requireAdminAuth, (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(__dirname + '/public/admin.html');
});

// Android TWA verification endpoint.
// Serve the same file that ships with the build so the live origin always matches the repo.
app.use((req, res, next) => {
  if (req.path !== '/.well-known/assetlinks.json') {
    next();
    return;
  }

  const assetLinksPath = __dirname + '/public/.well-known/assetlinks.json';
  const fallbackAssetLinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'io.facilitat.mobile',
        sha256_cert_fingerprints: [
          'CA:94:27:7C:7A:66:3C:9A:98:59:6C:C4:7E:54:52:1E:FB:31:E1:6B:42:56:77:4E:22:26:B2:F3:3F:67:89:09',
          '2F:3F:1F:23:48:E5:9F:CE:78:FA:23:9F:3A:86:B4:5A:C8:C7:9E:08:74:0D:22:BB:E1:9B:40:F6:D6:FC:FD:B9'
        ]
      }
    }
  ];

  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.type('application/json');

  try {
    const assetLinksRaw = fs.readFileSync(assetLinksPath, 'utf8');
    const assetLinks = JSON.parse(assetLinksRaw);
    res.status(200).json(assetLinks);
  } catch (error) {
    logger.warn({ event: 'assetlinks_fallback_used', error: error.message });
    res.status(200).json(fallbackAssetLinks);
  }
});

// Serve the public folder with cache headers tuned for SPA/PWA behavior.
// HTML and manifest files are always revalidated, while static assets are cached.
app.get('/telecharger', (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'telecharger.html'));
});

app.get('/privacy-policy', (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
});

app.get('/account-deletion', (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'account-deletion.html'));
});

app.use(
  express.static('public', {
    etag: false,
    lastModified: false,
    setHeaders: (res, filePath) => {
      const normalized = String(filePath).replace(/\\/g, '/');

      if (normalized.endsWith('.html')) {
        res.setHeader(
          'Cache-Control',
          'no-store, no-cache, must-revalidate, proxy-revalidate'
        );
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return;
      }

      if (
        normalized.endsWith('/manifest.json') ||
        normalized.endsWith('.webmanifest')
      ) {
        res.setHeader(
          'Cache-Control',
          'no-store, no-cache, must-revalidate, proxy-revalidate'
        );
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return;
      }

      if (normalized.endsWith('.js') || normalized.endsWith('.css')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        return;
      }

      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  })
);

app.use(express.json());

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.warn('[HTTP][INVALID_JSON]', {
      method: req.method,
      path: req.originalUrl
    });

    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  return next(err);
});

const MAX_RECENT_TURNS = 8;
const MAX_INFO_ANALYSIS_TURNS = 6;
const MAX_SUICIDE_ANALYSIS_TURNS = 10;
const MAX_RECALL_ANALYSIS_TURNS = 6;

function signAdminSessionPayload(payload) {
  return crypto
    .createHmac('sha256', ADMIN_SESSION_SIGNING_SECRET)
    .update(payload)
    .digest('hex');
}

function normalizeAdminScope(scope = 'full') {
  return scope === 'review' ? 'review' : 'full';
}

function buildAdminSessionToken(options = {}) {
  const createdAt = Number(options.createdAt || Date.now());
  const scope = normalizeAdminScope(options.scope);
  const payload = `${createdAt}:${scope}`;
  const signature = signAdminSessionPayload(payload);
  return `${payload}.${signature}`;
}

function parseAndValidateAdminSessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const payload = String(parts[0] || '').trim();
  const signature = String(parts[1] || '').trim();

  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = signAdminSessionPayload(payload);

  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const payloadParts = payload.split(':');
  const createdAt = Number(payloadParts[0] || 0);
  const scope = normalizeAdminScope(payloadParts[1] || 'full');
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }

  if (Date.now() - createdAt > ADMIN_SESSION_DURATION) {
    return null;
  }

  return {
    isAdmin: true,
    createdAt,
    scope,
    canBypassPhoneGate: true,
    canUseAdminUi: scope !== 'review'
  };
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;

  if (!rc) return list;

  rc.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const key = parts.shift()?.trim();
    if (!key) return;

    try {
      list[key] = decodeURIComponent(parts.join('='));
    } catch {
      list[key] = parts.join('=');
    }
  });

  return list;
}

function signUserSessionPayload(payload) {
  return crypto
    .createHmac('sha256', USER_SESSION_SIGNING_SECRET)
    .update(payload)
    .digest('hex');
}

function buildUserSessionToken(userId, createdAt = Date.now()) {
  const payload = `${String(userId || '').trim()}:${createdAt}`;
  const signature = signUserSessionPayload(payload);
  return `${payload}.${signature}`;
}

function parseAndValidateUserSessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const payload = String(parts[0] || '').trim();
  const signature = String(parts[1] || '').trim();

  if (!payload || !signature || !payload.includes(':')) {
    return null;
  }

  const expectedSignature = signUserSessionPayload(payload);
  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const separatorIndex = payload.lastIndexOf(':');
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
  return String(value || '')
    .trim()
    .toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .scryptSync(String(password || ''), salt, 64)
    .toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }

  const salt = parts[1];
  const expectedHashHex = parts[2];
  if (!salt || !expectedHashHex) {
    return false;
  }

  const passwordHashHex = crypto
    .scryptSync(String(password || ''), salt, 64)
    .toString('hex');
  const passwordBuffer = Buffer.from(passwordHashHex, 'hex');
  const expectedBuffer = Buffer.from(expectedHashHex, 'hex');

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
    .orderByChild('email')
    .equalTo(normalizedEmail)
    .limitToFirst(1)
    .once('value');

  const users = snapshot.val() || null;
  if (!users || typeof users !== 'object') {
    return null;
  }

  const entries = Object.entries(users);
  if (!entries.length) {
    return null;
  }

  const [userId, userData] = entries[0];
  return {
    userId,
    user: userData && typeof userData === 'object' ? userData : null
  };
}

function normalizeBiometricRelockSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const allowed = new Set([0, 30, 120, 300]);
  return allowed.has(n) ? n : null;
}

function buildDefaultUsageEnvelope() {
  const nowIso = new Date().toISOString();
  return {
    monthly: {
      remaining: MONTHLY_CAPACITY
    },
    rollover: {
      startedWith: 0,
      remaining: 0
    },
    reserve: {
      remaining: RESERVE_CAPACITY
    },
    lastRenewalAt: nowIso
  };
}

function toUsageEnvelopeStorageShape(state) {
  const safe = getEnvelopeState(
    state && typeof state === 'object' ? state : buildDefaultUsageEnvelope()
  );
  return {
    monthly: {
      remaining: safe.monthly.remaining
    },
    rollover: {
      startedWith: safe.rollover.startedWith,
      remaining: safe.rollover.remaining
    },
    reserve: {
      remaining: safe.reserve.remaining
    },
    lastRenewalAt: safe.lastRenewalAt || null
  };
}

function resolveUsageEnvelopeForRead(rawUsageEnvelope) {
  const fallback = buildDefaultUsageEnvelope();
  const source =
    rawUsageEnvelope && typeof rawUsageEnvelope === 'object'
      ? rawUsageEnvelope
      : fallback;
  return toUsageEnvelopeStorageShape(source);
}

function tokensToSimulatedEur(totalTokens = 0) {
  const safeTokens = Number(totalTokens);
  if (!Number.isFinite(safeTokens) || safeTokens <= 0) return 0;
  const eurPerToken =
    (USAGE_SIMULATION_GPT41_EUR_PER_1M_TOKENS / 1_000_000) *
    USAGE_SIMULATION_MARGIN_MULTIPLIER;
  return safeTokens * eurPerToken;
}

function normalizeUsageMeter(rawMeter = {}) {
  const safe = rawMeter && typeof rawMeter === 'object' ? rawMeter : {};
  const totalTokens = Number(safe.totalTokens);
  const totalSimulatedEur = Number(safe.totalSimulatedEur);
  return {
    totalTokens:
      Number.isFinite(totalTokens) && totalTokens > 0
        ? Math.round(totalTokens)
        : 0,
    totalSimulatedEur:
      Number.isFinite(totalSimulatedEur) && totalSimulatedEur > 0
        ? totalSimulatedEur
        : 0,
    updatedAt: typeof safe.updatedAt === 'string' ? safe.updatedAt : null
  };
}

function normalizeUsageMonthlyHistory(rawHistory = {}) {
  const safe =
    rawHistory && typeof rawHistory === 'object' && !Array.isArray(rawHistory)
      ? rawHistory
      : {};

  const out = {};
  for (const [key, value] of Object.entries(safe)) {
    const monthKey = String(key || '').trim();
    if (!/^\d{4}-\d{2}$/.test(monthKey)) continue;

    const entry = value && typeof value === 'object' ? value : {};
    const tokens = Number(entry.tokens);
    const totalSimulatedEur = Number(entry.totalSimulatedEur);

    out[monthKey] = {
      tokens: Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0,
      totalSimulatedEur:
        Number.isFinite(totalSimulatedEur) && totalSimulatedEur > 0
          ? totalSimulatedEur
          : 0,
      updatedAt:
        typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
          ? entry.updatedAt
          : null
    };
  }

  return out;
}

function getUsageMonthKey(now = new Date()) {
  const safeNow = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(safeNow.getTime())) {
    return null;
  }

  const year = safeNow.getUTCFullYear();
  const month = String(safeNow.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

async function ensureUserUsageEnvelopeFresh(userId = '', userData = null) {
  const safeUserId = String(userId || '').trim();
  const safeUserData = userData && typeof userData === 'object' ? userData : {};

  if (!safeUserId) {
    return safeUserData;
  }

  const currentEnvelope =
    safeUserData.usageEnvelope && typeof safeUserData.usageEnvelope === 'object'
      ? safeUserData.usageEnvelope
      : buildDefaultUsageEnvelope();
  const renewal = applyMonthlyRenewal(currentEnvelope, new Date());
  const normalizedEnvelope = toUsageEnvelopeStorageShape(renewal.state);
  const normalizedMeter = normalizeUsageMeter(safeUserData.usageMeter);

  const shouldPersistEnvelope =
    renewal.renewed === true ||
    !(
      safeUserData.usageEnvelope &&
      typeof safeUserData.usageEnvelope === 'object'
    );
  const shouldPersistMeter = !(
    safeUserData.usageMeter && typeof safeUserData.usageMeter === 'object'
  );

  if (shouldPersistEnvelope || shouldPersistMeter) {
    const patch = {
      updatedAt: new Date().toISOString()
    };

    if (shouldPersistEnvelope) {
      patch.usageEnvelope = normalizedEnvelope;
    }

    if (shouldPersistMeter) {
      patch.usageMeter = normalizedMeter;
    }

    await usersRef.child(safeUserId).update(patch);
  }

  return {
    ...safeUserData,
    usageEnvelope: normalizedEnvelope,
    usageMeter: normalizedMeter
  };
}

function buildUsageSimulationPublic() {
  return {
    paymentActive: USAGE_SIMULATION_PAYMENT_ACTIVE,
    modelReference: USAGE_SIMULATION_FROZEN_MODEL,
    phaseLabel: USAGE_SIMULATION_PHASE_LABEL
  };
}

function toPublicUser(userId, userData, _options = {}) {
  const safeUser = userData && typeof userData === 'object' ? userData : {};
  const normalizedRelock = normalizeBiometricRelockSeconds(
    safeUser.biometricRelockSeconds
  );

  return {
    id: String(userId || ''),
    email: normalizeEmail(safeUser.email),
    firstName:
      typeof safeUser.firstName === 'string' && safeUser.firstName.trim()
        ? safeUser.firstName.trim()
        : null,
    country: normalizeCountryCode(safeUser.country),
    createdAt:
      typeof safeUser.createdAt === 'string' ? safeUser.createdAt : null,
    updatedAt:
      typeof safeUser.updatedAt === 'string' ? safeUser.updatedAt : null,
    privateConversationsByDefault:
      safeUser.privateConversationsByDefault === true,
    biometricLockEnabled: safeUser.biometricLockEnabled === true,
    biometricRelockSeconds: normalizedRelock === null ? 120 : normalizedRelock,
    usageEnvelope: resolveUsageEnvelopeForRead(safeUser.usageEnvelope),
    usageSimulation: buildUsageSimulationPublic()
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

  const userSnap = await usersRef
    .child(String(session.userId || ''))
    .once('value');
  const userData = userSnap.val();

  if (!userData || typeof userData !== 'object') {
    userSessions.delete(sessionToken);
    return null;
  }

  return {
    token: sessionToken,
    userId: String(session.userId || ''),
    user: userData
  };
}

async function requireUserAuth(req, res, next) {
  try {
    const session = await getUserSession(req);

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.userSession = session;
    return next();
  } catch (err) {
    console.error('Erreur requireUserAuth:', err.message);
    return res.status(500).json({ error: 'Auth check failed' });
  }
}

function invalidateUserSessionsByUserId(userId = '') {
  const targetUserId = String(userId || '').trim();
  if (!targetUserId) return;

  for (const [token, data] of userSessions.entries()) {
    if (String(data?.userId || '').trim() === targetUserId) {
      userSessions.delete(token);
    }
  }

  for (const [token, data] of biometricUnlockTokens.entries()) {
    if (String(data?.userId || '').trim() === targetUserId) {
      biometricUnlockTokens.delete(token);
    }
  }
}

function buildAccountResetAuditHash(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  return crypto
    .createHmac('sha256', USER_SESSION_SIGNING_SECRET)
    .update(raw)
    .digest('hex')
    .slice(0, 24);
}

async function purgeExpiredAccountResetAudits(nowMs = Date.now()) {
  const snapshot = await accountResetAuditsRef
    .orderByChild('expiresAtMs')
    .endAt(nowMs)
    .once('value');

  const expiredEntries = snapshot.val();
  if (!expiredEntries || typeof expiredEntries !== 'object') {
    return 0;
  }

  const deletePatch = {};
  let deletedCount = 0;

  for (const auditId of Object.keys(expiredEntries)) {
    if (typeof auditId === 'string' && auditId.trim()) {
      deletePatch[auditId] = null;
      deletedCount += 1;
    }
  }

  if (deletedCount > 0) {
    await accountResetAuditsRef.update(deletePatch);
  }

  return deletedCount;
}

async function writeAccountResetAudit({
  oldUserId = '',
  newUserId = '',
  requestId = null,
  nowIso = new Date().toISOString()
} = {}) {
  const nowMs = Date.parse(nowIso) || Date.now();
  const expiresAtMs = nowMs + ACCOUNT_RESET_AUDIT_RETENTION_MS;

  await purgeExpiredAccountResetAudits(nowMs);
  await accountResetAuditsRef.push({
    action: 'account_reset',
    createdAt: nowIso,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    requestId:
      typeof requestId === 'string' && requestId.trim()
        ? requestId.trim()
        : null,
    oldUserIdHash: buildAccountResetAuditHash(oldUserId),
    newUserIdHash: buildAccountResetAuditHash(newUserId)
  });
}

// Validate biometric unlock token if biometric lock is enabled for the user
function validateBiometricTokenIfNeeded(req) {
  const session = req.userSession;

  if (!session?.user?.biometricLockEnabled) {
    return { valid: true, reason: 'biometric_not_enabled' };
  }

  const biometricToken =
    req.body?.biometricUnlockToken || req.headers['x-biometric-token'];

  if (!biometricToken || typeof biometricToken !== 'string') {
    return { valid: false, reason: 'missing_token' };
  }

  const tokenData = biometricUnlockTokens.get(biometricToken);

  if (!tokenData) {
    return { valid: false, reason: 'invalid_token' };
  }

  if (Date.now() > tokenData.expiresAt) {
    biometricUnlockTokens.delete(biometricToken);
    return { valid: false, reason: 'token_expired' };
  }

  if (tokenData.userId !== session.userId) {
    return { valid: false, reason: 'token_user_mismatch' };
  }

  return { valid: true, reason: 'token_valid' };
}

async function resolveBranchActorUserId(req) {
  try {
    const session = await getUserSession(req);

    if (
      session &&
      typeof session.userId === 'string' &&
      session.userId.trim()
    ) {
      return session.userId.trim();
    }
  } catch (err) {
    console.error('Erreur resolveBranchActorUserId:', err.message);
  }

  const bodyUserId =
    typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  if (bodyUserId) {
    return bodyUserId;
  }

  const queryUserId =
    typeof req.query?.userId === 'string' ? req.query.userId.trim() : '';
  return queryUserId;
}

const BRANCH_ROUTE_DEBUG = appConfig.branchRouteDebug;
const DEV_RUNTIME_GUARDS = appConfig.devRuntimeGuards;

function logBranchRouteEvent(level = 'info', event = '', payload = {}) {
  if (!event) return;
  if (level === 'info' && !BRANCH_ROUTE_DEBUG) return;

  const line = {
    event,
    ...payload
  };

  if (level === 'error') {
    logger.error(line, 'branch-route');
    return;
  }

  if (level === 'warn') {
    logger.warn(line, 'branch-route');
    return;
  }

  logger.info(line, 'branch-route');
}

function collectStateProposalIssues(stateProposal) {
  return validateShape(stateProposalSchema, stateProposal);
}

function collectPostureDecisionIssues(postureDecision) {
  return validateShape(postureDecisionSchema, postureDecision);
}

function collectDebugMetaIssues(debugMeta) {
  return validateShape(debugMetaSchema, debugMeta);
}

function warnRuntimeContract(label, issues, context = {}) {
  if (!DEV_RUNTIME_GUARDS) return;
  if (!Array.isArray(issues) || issues.length === 0) return;

  logger.warn(
    {
      label,
      issues,
      ...context
    },
    'runtime-guard'
  );
}

// Middleware protecting admin routes by redirecting unauthenticated users.
function requireAdminAuth(req, res, next) {
  const session = getAdminSession(req);

  if (!session || session.canUseAdminUi !== true) {
    const nextUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/admin-login.html?next=${nextUrl}`);
  }
  adminVisitedSinceLastAlert = true;
  next();
}

// Normalize the stored memory value.
// If there is no explicit memory text, fall back to the registry's default template.
function canonicalizeMemorySectionSpacing(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/(Contexte stable\s*:)[ \t]*\n+(?:[ \t]*\n+)*/i, '$1\n')
    .replace(/(Mouvements en cours\s*:)[ \t]*\n+(?:[ \t]*\n+)*/i, '$1\n')
    .replace(/(Anciens mouvements\s*:)[ \t]*\n+(?:[ \t]*\n+)*/i, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function _extractMemorySectionBullets(memoryText = '', sectionLabel = '') {
  const label = String(sectionLabel || '').trim();
  if (!label) return [];
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = String(memoryText || '');
  const match = text.match(
    new RegExp(`${escaped}\\s*:\\s*([\\s\\S]*?)(?:\\n[A-ZÀ-Ü][^:\\n]*:|$)`, 'i')
  );
  if (!match) return [];

  return String(match[1] || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => line.startsWith('-') && line.replace(/^[-\s]+/, '').trim()
    )
    .map((line) => line.replace(/^[-\s]+/, '').trim());
}

function extractIntersessionSection(memoryText = '') {
  const text = String(memoryText || '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) {
    return { hasHeader: false, items: [] };
  }

  const match = text.match(
    /m[ée]moire\s+inter-?session\s*:\s*([\s\S]*?)(?:\n[A-ZÀ-Ü][^:\n]*:|$)/i
  );
  if (!match) {
    return { hasHeader: false, items: [] };
  }

  const rawItems = String(match[1] || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => line.replace(/^[-\s]+/, '').trim())
    .filter(Boolean)
    .filter((item) => item !== '-');

  const seen = new Set();
  const items = [];
  for (const item of rawItems) {
    const key = item
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(item.replace(/\s+/g, ' '));
    if (items.length >= 10) break;
  }

  return { hasHeader: true, items };
}

function normalizeMemory(
  memory,
  promptRegistry = buildDefaultPromptRegistry()
) {
  const text = canonicalizeMemorySectionSpacing(String(memory || '').trim());
  if (text) return text;

  return (
    String(promptRegistry.NORMALIZE_MEMORY_TEMPLATE || '').trim() ||
    buildDefaultPromptRegistry().NORMALIZE_MEMORY_TEMPLATE
  );
}

function normalizeIntersessionMemory(
  memory,
  promptRegistry = buildDefaultPromptRegistry()
) {
  const text = String(memory || '').trim();
  if (text) {
    const section = extractIntersessionSection(text);
    if (section.hasHeader) {
      return [
        'Memoire inter-session:',
        ...(section.items.length > 0
          ? section.items.map((item) => `- ${item}`)
          : ['-'])
      ].join('\n');
    }
  }

  return (
    String(
      promptRegistry.NORMALIZE_INTERSESSION_MEMORY_TEMPLATE || ''
    ).trim() ||
    buildDefaultPromptRegistry().NORMALIZE_INTERSESSION_MEMORY_TEMPLATE
  );
}

function normalizeMemoryTraceText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildMemoryReactivationTrace({
  previousMemoryState = null,
  memoryUpdateContract = null,
  mergedMemoryState = null,
  currentUserMessage = '',
  memoryPrioritySignal = 'normal'
} = {}) {
  const previousOngoingTexts = Array.isArray(
    previousMemoryState?.onGoingMovements
  )
    ? previousMemoryState.onGoingMovements
        .map((item) => String(item?.text || '').trim())
        .filter(Boolean)
    : [];

  const previousAncientTexts = Array.isArray(
    previousMemoryState?.ancientMovements
  )
    ? previousMemoryState.ancientMovements
        .map((item) => String(item?.text || '').trim())
        .filter(Boolean)
    : [];

  const ancientKeys = new Set(
    previousAncientTexts
      .map((text) => normalizeMemoryTraceText(text))
      .filter(Boolean)
  );

  const contractOngoingTexts = Array.isArray(
    memoryUpdateContract?.ongoingMovements
  )
    ? memoryUpdateContract.ongoingMovements
        .map((item) => String(item?.text || item || '').trim())
        .filter(Boolean)
    : [];

  const mergedOngoingTexts = Array.isArray(mergedMemoryState?.onGoingMovements)
    ? mergedMemoryState.onGoingMovements
        .map((item) => String(item?.text || '').trim())
        .filter(Boolean)
    : [];

  const overlapContractWithAncient = contractOngoingTexts
    .filter((text) => ancientKeys.has(normalizeMemoryTraceText(text)))
    .slice(0, 3);

  const overlapMergedWithAncient = mergedOngoingTexts
    .filter((text) => ancientKeys.has(normalizeMemoryTraceText(text)))
    .slice(0, 3);

  const normalizedUserMessage = normalizeMemoryTraceText(currentUserMessage);
  const mergedOutsideCurrentUser = mergedOngoingTexts
    .filter((text) => {
      const key = normalizeMemoryTraceText(text);
      if (!key || !normalizedUserMessage) return false;
      return !normalizedUserMessage.includes(key);
    })
    .slice(0, 3);

  const likelySource =
    overlapContractWithAncient.length > 0
      ? 'updateMemory_contract'
      : overlapMergedWithAncient.length > 0
        ? 'merge'
        : 'none';

  return {
    reactivationDetected: overlapMergedWithAncient.length > 0,
    likelySource,
    memoryPrioritySignal: String(memoryPrioritySignal || 'normal'),
    previousCounts: {
      ancient: previousAncientTexts.length,
      ongoing: previousOngoingTexts.length
    },
    contractOngoingCount: contractOngoingTexts.length,
    mergedOngoingCount: mergedOngoingTexts.length,
    overlapContractWithAncient,
    overlapMergedWithAncient,
    mergedOutsideCurrentUser
  };
}

function normalizeIntersessionSourceFromUserData(
  userData,
  _promptRegistry = buildDefaultPromptRegistry()
) {
  if (!userData || typeof userData !== 'object') {
    return '';
  }

  const source =
    typeof userData.intersessionMemorySource === 'string'
      ? userData.intersessionMemorySource
      : typeof userData.intersessionMemory === 'string'
        ? userData.intersessionMemory
        : '';

  const raw = String(source || '').trim();
  if (!raw) {
    return '';
  }

  // Backward compatibility with legacy stored values that included a technical header.
  return raw.replace(/^m[ée]moire\s+inter-?session\s*:\s*/i, '').trim();
}

const INTERSESSION_COMPACT_FAILURE_NOTE =
  '- Derniere mise a jour memoire echouee.';
const INTERSESSION_COMPACT_EMPTY_NOTE =
  '- Aucun repere intersession disponible';

function parseLooseJsonObject(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    const repaired = candidate
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)'([^'\\]+?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^'\\]*?)'(\s*[,}])/g, ': "$1"$2');
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

function extractRuntimeCompactItems(raw = '') {
  const parsed = parseLooseJsonObject(
    String(raw || '')
      .replace(/```json|```/gi, '')
      .trim()
  );
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  if (!Array.isArray(parsed.items)) return [];

  const seen = new Set();
  const items = [];
  for (const value of parsed.items) {
    if (typeof value !== 'string') continue;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }
  return items;
}

function formatRuntimeCompactMemory(items = []) {
  const safeItems = Array.isArray(items)
    ? items
        .map((item) =>
          String(item || '')
            .replace(/\s+/g, ' ')
            .trim()
        )
        .filter(Boolean)
    : [];
  if (safeItems.length === 0) {
    return INTERSESSION_COMPACT_EMPTY_NOTE;
  }
  return safeItems.map((item) => `- ${item}`).join('\n');
}

function buildIntersessionCompactRuntime(
  memorySource = '',
  maxItems = 10,
  maxChars = 1200
) {
  const source = String(memorySource || '').trim();
  if (!source) {
    return '';
  }
  const lines = String(source || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = [];
  for (const line of lines) {
    if (/^m[ée]moire\s+inter-?session\s*:/i.test(line)) continue;
    const cleaned = line.replace(/^[-*\s]+/, '').trim();
    if (!cleaned || cleaned === '-') continue;
    candidates.push(cleaned.replace(/\s+/g, ' '));
  }

  const seen = new Set();
  const compactItems = [];
  for (const item of candidates) {
    const key = item
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    compactItems.push(item);
    if (compactItems.length >= maxItems) break;
  }

  if (compactItems.length === 0) {
    return '';
  }

  const rendered = [
    'Memoire inter-session compacte (runtime):',
    ...compactItems.map((item) => `- ${item}`)
  ].join('\n');

  return rendered.slice(0, Math.max(100, maxChars));
}

// Keep only the last valid user/assistant turns from history.
function trimHistoryWithLimit(history, maxTurns) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    )
    .slice(-maxTurns);
}

function normalizeConversationBranchHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    )
    .map((m) => ({ role: m.role, content: m.content }));
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

function isExplicitAppFeatureRequest(message = '') {
  const text = normalizeGuardText(message);

  // Questions de decouverte generale : pas besoin de mentionner "app" explicitement
  const isGenericDiscovery =
    /^(comment (ca|cela|tu) (marche|fonctionnes?)|c'est quoi (cette app|ca|cela)\??|(tu peux|vous pouvez) faire quoi|qu'est-ce que (tu peux|vous pouvez) faire|a quoi (tu sers|vous servez))[\s?!.]*$/.test(
      text
    );
  if (isGenericDiscovery) return true;

  const mentionsApp = /\b(app|application|outil|plateforme|assistant)\b/.test(
    text
  );
  const asksUsage =
    /comment (utiliser|fonctionne|ca marche)|que fait l'app|quoi faire dans l'app|mode d'emploi|etapes|fonctionnalites|plan d'urgence|dans l'app/.test(
      text
    );

  return mentionsApp && asksUsage;
}

// --------------------------------------------------
// 3) ANALYSE INFO + CONTACT + RECALL + CONFLIT MODELE + RELANCE
// --------------------------------------------------

// Detect whether the user is asking an information request.
async function llmInfoAnalysis(
  message = '',
  history = [],
  promptRegistry = buildDefaultPromptRegistry()
) {
  const context = trimInfoAnalysisHistory(history);

  const r = await client.chat.completions.create({
    model: MODEL_IDS.analysis,
    temperature: 0,
    max_completion_tokens: 60,
    messages: [
      { role: 'system', content: promptRegistry.ANALYZE_INFO },
      ...context.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message }
    ]
  });

  try {
    const raw = (r.choices?.[0]?.message?.content || '')
      .replace(/```json|```/g, '')
      .trim();
    const parsed = JSON.parse(raw);

    return {
      isInfoRequest: parsed.isInfoRequest === true,
      source: 'llm'
    };
  } catch {
    return {
      isInfoRequest: false,
      source: 'llm_fallback'
    };
  }
}

const {
  analyzeExplorationCalibration,
  analyzeExplorationRelance,
  analyzeEmotionalDecentering,
  analyzeAttentionQuality,
  analyzeDependencyRisk,
  analyzeClosureIntent,
  analyzeAllianceRupture,
  analyzeInterpretationRejection,
  analyzeTechnicalContext,
  analyzeUserRegister,
  analyzeRecallRouting,
  analyzeRelationalAdjustmentNeed,
  analyzeSuicideRisk,
  analyzeImminentMajorHarmRisk,
  acuteCrisisFollowupResponse,
  acuteCrisisFollowupResponseLLM,
  classifyN2TurnType,
  imminentMajorHarmResponseLLM,
  n1Fallback,
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

async function loadConversationBranchHistoryForRecall({
  conversationId = '',
  isPrivateConversation = false,
  conversationBranchHistory = [],
  recentHistory = []
} = {}) {
  const normalizedLocalBranchHistory = normalizeConversationBranchHistory(
    conversationBranchHistory
  );

  if (isPrivateConversation === true || !conversationId) {
    return normalizedLocalBranchHistory.length > 0
      ? normalizedLocalBranchHistory
      : normalizeConversationBranchHistory(recentHistory);
  }

  try {
    const messagesSnap = await messagesRef
      .orderByChild('conversationId')
      .equalTo(conversationId)
      .once('value');

    const branchHistory = Object.values(messagesSnap.val() || {})
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string'
      )
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      .map((m) => ({ role: m.role, content: m.content }));

    if (branchHistory.length > 0) {
      return normalizedLocalBranchHistory.length > branchHistory.length
        ? normalizedLocalBranchHistory
        : branchHistory;
    }
  } catch (err) {
    console.warn('[RECALL][BRANCH_LOAD_FAILED]', {
      conversationId,
      error: err && err.message ? err.message : String(err)
    });
  }

  if (normalizedLocalBranchHistory.length > 0) {
    return normalizedLocalBranchHistory;
  }

  return normalizeConversationBranchHistory(recentHistory);
}

// Ask the LLM whether the generated content appears to violate the model conflict policy.
async function analyzeModelConflict(
  content = '',
  promptRegistry = buildDefaultPromptRegistry()
) {
  const r = await client.chat.completions.create({
    model: MODEL_IDS.analysis,
    temperature: 0,
    max_completion_tokens: 40,
    messages: [
      { role: 'system', content: promptRegistry.ANALYZE_CONFLICT_MODEL },
      { role: 'user', content: content }
    ]
  });

  try {
    const raw = (r.choices?.[0]?.message?.content || '')
      .replace(/```json|```/g, '')
      .trim();
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
  message = '',
  history = [],
  memory = '',
  originalContent,
  promptRegistry = buildDefaultPromptRegistry()
}) {
  const user = `
Message utilisateur :
${message}

Contexte recent :
${history.map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.content}`).join('\n')}

Memoire :
${normalizeMemory(memory, promptRegistry)}

Contenu initial a reformuler :
${originalContent}
`;

  const r = await client.chat.completions.create({
    model: MODEL_IDS.generation,
    temperature: 0.3,
    max_completion_tokens: 500,
    messages: [
      { role: 'system', content: promptRegistry.REWRITE_TITLE_CONFLICT_MODEL },
      { role: 'user', content: user }
    ]
  });

  return (r.choices?.[0]?.message?.content || '').trim() || originalContent;
}

// --------------------------------------------------
// 4) MODE + DEBUG
// --------------------------------------------------

// --------------------------------------------------
// 5) MEMOIRE
// --------------------------------------------------

const {
  MEMORY_INACTIVITY_TTL_MS,
  mergeMemoryStateWithFinalizedText,
  normalizeMemoryStateShape,
  updateIntersessionMemory,
  updateMemory
} = createMemoryHelpers({
  client,
  MODEL_IDS,
  normalizeIntersessionMemory,
  normalizeMemory
});

const { generateReply } = createWriter({ client, MODEL_IDS, normalizeMemory });

// --------------------------------------------------
// 8) SESSION CLOSE
// --------------------------------------------------

function validateSessionCloseRequestShape(body = {}) {
  const issues = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    issues.push('body_not_object');
    return issues;
  }

  if (body.memory !== undefined && typeof body.memory !== 'string') {
    issues.push('memory_not_string');
  }

  if (
    body.flags !== undefined &&
    (typeof body.flags !== 'object' ||
      body.flags === null ||
      Array.isArray(body.flags))
  ) {
    issues.push('flags_not_object');
  }

  return issues;
}

// Reset session flags and return the normalized memory/flags state when the session ends.
app.post('/session/close', async (req, res) => {
  try {
    const requestIssues = validateSessionCloseRequestShape(req.body);

    if (requestIssues.length > 0) {
      console.warn('[SESSION_CLOSE][REQUEST_SHAPE]', {
        issues: requestIssues
      });

      return res.status(400).json({
        error: 'Invalid session close request',
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
    console.error('Erreur /session/close:', err);
    return res.status(500).json({
      error: 'Erreur session close',
      memory: normalizeMemory(req.body?.memory, buildDefaultPromptRegistry()),
      flags: normalizeSessionFlags({})
    });
  }
});

// ------------------------------
// GENERATION TITRE AUTO
// ------------------------------

function normalizeTitleDenyKey(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeGeneratedTitleCandidate(value = '') {
  let title = String(value || '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ')
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
    ? options.forbiddenTitles
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    : [];
  const forbiddenTitleKeys = new Set(
    forbiddenTitles.map(normalizeTitleDenyKey).filter(Boolean)
  );
  const promptRegistry = buildDefaultPromptRegistry();

  function isForbiddenTitle(title = '') {
    const key = normalizeTitleDenyKey(title);
    return !!key && forbiddenTitleKeys.has(key);
  }

  function buildIncrementedDuplicateTitle(baseTitle = '') {
    const sanitizedBase = sanitizeGeneratedTitleCandidate(baseTitle);
    if (!sanitizedBase) return null;

    if (!isForbiddenTitle(sanitizedBase)) {
      return sanitizedBase;
    }

    for (let i = 2; i <= 99; i += 1) {
      const candidate = sanitizeGeneratedTitleCandidate(
        `${sanitizedBase} (${i})`
      );
      if (candidate && !isForbiddenTitle(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function buildRecentTitleHistory() {
    return messages
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string'
      )
      .slice(-MAX_RECENT_TURNS)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  async function requestTitleFromLlm(
    sourceText = '',
    extraForbiddenTitles = []
  ) {
    const effectiveForbidden = Array.from(
      new Set([
        ...forbiddenTitles,
        ...extraForbiddenTitles
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      ])
    ).slice(0, 80);

    const avoidBlock =
      effectiveForbidden.length > 0
        ? [
            'Titres interdits (ne pas proposer ces formulations exactes, meme avec ponctuation/casse differente) :',
            ...effectiveForbidden.map((title) => `- ${title}`)
          ].join('\n')
        : 'Aucun titre interdit fourni.';

    const completion = await client.chat.completions.create({
      model: MODEL_IDS.title,
      temperature: 0.2,
      max_completion_tokens: 30,
      messages: [
        {
          role: 'system',
          content: [
            'Tu generes un titre tres court en francais pour une conversation.',
            'Contraintes :',
            '- 2 a 6 mots',
            '- pas de guillemets',
            "- pas d'emoji",
            '- pas de point final',
            '- formulation naturelle et specifique',
            '- ne recopie pas simplement le premier message',
            "- ne commence pas par Verbatim de type Je, J, Tu, Mon, Ma sauf si c'est indispensable",
            '- respecte strictement la liste des titres interdits'
          ].join('\n')
        },
        {
          role: 'user',
          content: `${sourceText}\n\n${avoidBlock}`
        }
      ]
    });

    return sanitizeGeneratedTitleCandidate(
      completion.choices?.[0]?.message?.content || ''
    );
  }

  async function applyTitleConflictGuard(
    title,
    sourceText,
    { allowRetry = true } = {}
  ) {
    const titleConflict = await analyzeModelConflict(title, promptRegistry);

    if (titleConflict.modelConflict !== true) {
      return sanitizeGeneratedTitleCandidate(title);
    }

    let nextTitle = await rewriteConflictModelContent({
      message: sourceText,
      history: buildRecentTitleHistory(),
      memory: '',
      originalContent: title,
      promptRegistry
    });

    nextTitle = sanitizeGeneratedTitleCandidate(nextTitle);

    if (allowRetry && (!nextTitle || isForbiddenTitle(nextTitle))) {
      const retriedTitle = await requestTitleFromLlm(sourceText, [nextTitle]);
      if (retriedTitle && !isForbiddenTitle(retriedTitle)) {
        nextTitle = retriedTitle;
      }
    }

    return sanitizeGeneratedTitleCandidate(nextTitle);
  }

  try {
    const userMessages = messages
      .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
      .slice(0, 3)
      .map((m) => m.content.trim())
      .filter(Boolean);

    if (userMessages.length === 0) return null;

    const sourceText = userMessages.join('\n\n');

    let title = await requestTitleFromLlm(sourceText);

    if (!title) {
      const merged = userMessages.join(' ');
      const words = merged
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5);

      title = words.length ? words.join(' ') : 'Conversation';
    }

    title = sanitizeGeneratedTitleCandidate(title);

    if (!title) {
      title = 'Conversation';
    }

    if (isForbiddenTitle(title)) {
      const retriedTitle = await requestTitleFromLlm(sourceText, [title]);
      if (retriedTitle && !isForbiddenTitle(retriedTitle)) {
        title = retriedTitle;
      }
    }

    title = await applyTitleConflictGuard(title, sourceText);

    if (isForbiddenTitle(title)) {
      const incrementedDuplicate = buildIncrementedDuplicateTitle(title);
      if (incrementedDuplicate) {
        return incrementedDuplicate;
      }
      return null;
    }

    return title || 'Conversation';
  } catch (err) {
    console.error('Erreur generation titre:', err.message);

    const fallbackMessages = messages
      .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
      .slice(0, 3)
      .map((m) => m.content.trim())
      .filter(Boolean);

    const merged = fallbackMessages.join(' ');
    const words = merged
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);

    let fallbackTitle = words.length ? words.join(' ') : 'Conversation';

    try {
      fallbackTitle = await applyTitleConflictGuard(fallbackTitle, merged, {
        allowRetry: false
      });
    } catch (rewriteErr) {
      console.error('Erreur rewrite titre:', rewriteErr.message);
    }

    if (isForbiddenTitle(fallbackTitle)) {
      const incrementedDuplicate =
        buildIncrementedDuplicateTitle(fallbackTitle);
      if (incrementedDuplicate) {
        return incrementedDuplicate;
      }
      return null;
    }

    return fallbackTitle || 'Conversation';
  }
}

// --------------------------------------------------
// 9) ROUTE
// --------------------------------------------------

// Admin login route that creates a time-limited session cookie.
app.get('/api/admin/session', async (req, res) => {
  try {
    const session = getAdminSession(req);
    if (!session) {
      return res.json({ authenticated: false });
    }

    const canUseAdminUi = session.canUseAdminUi !== false;

    return res.json({
      authenticated: true,
      canBypassPhoneGate: session.canBypassPhoneGate === true,
      canUseAdminUi,
      settings: {
        mailsEnabled: canUseAdminUi ? getCachedAdminMailsEnabled() : false
      }
    });
  } catch (err) {
    console.error('Erreur /api/admin/session:', err.message);
    return res.status(500).json({ error: 'Admin session lookup failed' });
  }
});

app.put('/api/admin/settings', requireAdminAuth, async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      typeof req.body.mailsEnabled !== 'boolean'
    ) {
      return res.status(400).json({ error: 'Invalid admin settings payload' });
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
    console.error('Erreur PUT /api/admin/settings:', err.message);
    return res.status(500).json({ error: 'Admin settings update failed' });
  }
});

app.post('/api/admin/login', (req, res) => {
  if (
    !req.body ||
    typeof req.body !== 'object' ||
    Array.isArray(req.body) ||
    typeof req.body.password !== 'string'
  ) {
    return res.status(400).json({ error: 'Invalid admin login request' });
  }

  const safePassword = String(req.body.password || '').trim();
  const safePrimaryPassword = String(ADMIN_PASSWORD || '').trim();
  const isPrimaryAdminPassword =
    Boolean(safePrimaryPassword) && safePassword === safePrimaryPassword;
  const isReviewPassword = safePassword === ADMIN_REVIEW_PASSWORD;

  if (!safePassword || !ADMIN_PASSWORD_SET.has(safePassword)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sessionScope = isPrimaryAdminPassword
    ? 'full'
    : isReviewPassword
      ? 'review'
      : 'full';

  const sessionId = buildAdminSessionToken({ scope: sessionScope });

  adminSessions.set(sessionId, {
    isAdmin: true,
    createdAt: Date.now(),
    scope: sessionScope,
    canBypassPhoneGate: true,
    canUseAdminUi: sessionScope !== 'review'
  });

  res.setHeader(
    'Set-Cookie',
    `adminSessionId=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${Math.floor(ADMIN_SESSION_DURATION / 1000)}`
  );

  res.json({ success: true });
});

// Admin logout route that clears the session cookie and removes the session.
app.post('/api/admin/logout', (req, res) => {
  const cookies = parseCookies(req);
  const sessionId = cookies.adminSessionId;

  if (sessionId) {
    adminSessions.delete(sessionId);
  }

  res.setHeader(
    'Set-Cookie',
    'adminSessionId=; HttpOnly; Path=/; Secure; Max-Age=0'
  );

  res.json({ success: true });
});

app.get('/api/auth/session', async (req, res) => {
  try {
    const session = await getUserSession(req);
    const isAdmin = Boolean(getAdminSession(req));

    if (!session) {
      return res.json({ authenticated: false, user: null });
    }

    const refreshedUser = await ensureUserUsageEnvelopeFresh(
      session.userId,
      session.user
    );

    return res.json({
      authenticated: true,
      user: toPublicUser(session.userId, refreshedUser, { isAdmin })
    });
  } catch (err) {
    console.error('Erreur /api/auth/session:', err.message);
    return res.status(500).json({ error: 'Session lookup failed' });
  }
});

app.get('/api/emergency-support', (req, res) => {
  try {
    const requestedCountry = normalizeCountryCode(req.query.country);
    const fallbackCountry = normalizeCountryCode(req.query.fallbackCountry);
    const primaryInfo = lookupEmergencyNumbers(requestedCountry);
    const fallbackInfo = lookupEmergencyNumbers(fallbackCountry || 'FR');
    const emergencyInfo = primaryInfo || fallbackInfo || null;

    const hasStructuredNumbers = Boolean(
      emergencyInfo &&
        (String(emergencyInfo.emergency || '').trim() ||
          String(emergencyInfo.suicide || '').trim())
    );

    return res.json({
      requestedCountry: requestedCountry || null,
      country:
        hasStructuredNumbers && primaryInfo
          ? requestedCountry
          : hasStructuredNumbers && fallbackInfo
            ? fallbackCountry || 'FR'
            : null,
      label:
        hasStructuredNumbers && emergencyInfo
          ? String(emergencyInfo.label || '').trim() || null
          : null,
      emergency:
        hasStructuredNumbers && emergencyInfo
          ? String(emergencyInfo.emergency || '').trim() || null
          : null,
      suicide:
        hasStructuredNumbers && emergencyInfo
          ? String(emergencyInfo.suicide || '').trim() || null
          : null,
      hasStructuredNumbers,
      fallbackGuidance: buildEmergencyFallbackGuidance(),
      updatedPeriod: 'periodic'
    });
  } catch (err) {
    logger.error({ event: 'api_emergency_support_failed', error: err.message });
    return res.status(500).json({
      requestedCountry: null,
      country: null,
      label: null,
      emergency: null,
      suicide: null,
      hasStructuredNumbers: false,
      fallbackGuidance: buildEmergencyFallbackGuidance(),
      updatedPeriod: 'periodic'
    });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      typeof req.body.email !== 'string' ||
      typeof req.body.password !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid register request' });
    }

    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!enforceAuthRateLimit(req, res, 'register', email)) {
      return;
    }

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    if (!isStrongPassword(password)) {
      return res
        .status(400)
        .json({
          error:
            'Password must contain at least 10 characters, including at least one letter and one number'
        });
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Optional profile fields
    const firstName =
      typeof req.body.firstName === 'string'
        ? req.body.firstName.trim().slice(0, 50)
        : null;
    const country = normalizeCountryCode(req.body.country);

    const now = new Date().toISOString();
    const userId = `u_${crypto.randomBytes(12).toString('hex')}`;
    const userRecord = {
      email,
      passwordHash: hashPassword(password),
      superId: buildSuperId(),
      privateConversationsByDefault: false,
      biometricLockEnabled: false,
      biometricRelockSeconds: 120,
      usageEnvelope: buildDefaultUsageEnvelope(),
      usageMeter: normalizeUsageMeter(),
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
      'Set-Cookie',
      `userSessionId=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${Math.floor(USER_SESSION_DURATION / 1000)}`
    );

    return res.status(201).json({
      success: true,
      user: toPublicUser(userId, userRecord)
    });
  } catch (err) {
    console.error('Erreur /api/auth/register:', err.message);
    return res.status(500).json({ error: 'Register failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      typeof req.body.email !== 'string' ||
      typeof req.body.password !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid login request' });
    }

    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!enforceAuthRateLimit(req, res, 'login', email)) {
      return;
    }

    const found = await findUserByEmail(email);

    if (
      !found ||
      !found.user ||
      !verifyPassword(password, found.user.passwordHash)
    ) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const normalizedSuperId = normalizeSuperId(found.user.superId);
    if (!normalizedSuperId) {
      found.user.superId = buildSuperId();
      await usersRef
        .child(found.userId)
        .update({ superId: found.user.superId });
    }

    const sessionToken = buildUserSessionToken(found.userId);
    userSessions.set(sessionToken, {
      userId: found.userId,
      createdAt: Date.now()
    });

    authRateLimiters.login.reset(buildAuthRateLimitKey(req, 'login', email));

    res.setHeader(
      'Set-Cookie',
      `userSessionId=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${Math.floor(USER_SESSION_DURATION / 1000)}`
    );

    return res.json({
      success: true,
      user: toPublicUser(found.userId, found.user)
    });
  } catch (err) {
    console.error('Erreur /api/auth/login:', err.message);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const sessionToken = cookies.userSessionId;

  if (sessionToken) {
    userSessions.delete(sessionToken);
  }

  res.setHeader(
    'Set-Cookie',
    'userSessionId=; HttpOnly; Path=/; Secure; Max-Age=0'
  );

  return res.json({ success: true });
});

app.post('/api/auth/change-password', requireUserAuth, async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      typeof req.body.currentPassword !== 'string' ||
      typeof req.body.newPassword !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid change password request' });
    }

    const session = req.userSession;
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    if (!verifyPassword(currentPassword, session.user.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    if (!isStrongPassword(newPassword)) {
      return res
        .status(400)
        .json({
          error:
            'Password must contain at least 10 characters, including at least one letter and one number'
        });
    }

    const now = new Date().toISOString();
    await usersRef.child(session.userId).update({
      passwordHash: hashPassword(newPassword),
      updatedAt: now
    });

    return res.json({ success: true, updatedAt: now });
  } catch (err) {
    console.error('Erreur /api/auth/change-password:', err.message);
    return res.status(500).json({ error: 'Password change failed' });
  }
});

app.get('/api/account/preferences', requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const relock = normalizeBiometricRelockSeconds(
      session?.user?.biometricRelockSeconds
    );
    return res.json({
      privateConversationsByDefault:
        session?.user?.privateConversationsByDefault === true,
      biometricLockEnabled: session?.user?.biometricLockEnabled === true,
      biometricRelockSeconds: relock === null ? 120 : relock
    });
  } catch (err) {
    console.error('Erreur GET /api/account/preferences:', err.message);
    return res.status(500).json({ error: 'Preferences lookup failed' });
  }
});

app.put('/api/account/preferences', requireUserAuth, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid preferences payload' });
    }

    const session = req.userSession;
    const now = new Date().toISOString();
    const patch = { updatedAt: now };

    const hasPrivateDefault =
      typeof req.body.privateConversationsByDefault === 'boolean';
    const hasBiometricLockEnabled =
      typeof req.body.biometricLockEnabled === 'boolean';
    const hasBiometricRelockSeconds = Object.prototype.hasOwnProperty.call(
      req.body,
      'biometricRelockSeconds'
    );

    if (
      !hasPrivateDefault &&
      !hasBiometricLockEnabled &&
      !hasBiometricRelockSeconds
    ) {
      return res.status(400).json({ error: 'Invalid preferences payload' });
    }

    if (hasPrivateDefault) {
      patch.privateConversationsByDefault =
        req.body.privateConversationsByDefault === true;
    }

    if (hasBiometricLockEnabled) {
      patch.biometricLockEnabled = req.body.biometricLockEnabled === true;
    }

    if (hasBiometricRelockSeconds) {
      const normalizedRelock = normalizeBiometricRelockSeconds(
        req.body.biometricRelockSeconds
      );
      if (normalizedRelock === null) {
        return res
          .status(400)
          .json({ error: 'Invalid biometric relock timeout' });
      }
      patch.biometricRelockSeconds = normalizedRelock;
    }

    await usersRef.child(session.userId).update(patch);

    const safePrivateDefault = Object.prototype.hasOwnProperty.call(
      patch,
      'privateConversationsByDefault'
    )
      ? patch.privateConversationsByDefault === true
      : session?.user?.privateConversationsByDefault === true;
    const safeBiometricEnabled = Object.prototype.hasOwnProperty.call(
      patch,
      'biometricLockEnabled'
    )
      ? patch.biometricLockEnabled === true
      : session?.user?.biometricLockEnabled === true;
    const safeRelock = Object.prototype.hasOwnProperty.call(
      patch,
      'biometricRelockSeconds'
    )
      ? patch.biometricRelockSeconds
      : normalizeBiometricRelockSeconds(session?.user?.biometricRelockSeconds);

    return res.json({
      success: true,
      privateConversationsByDefault: safePrivateDefault,
      biometricLockEnabled: safeBiometricEnabled,
      biometricRelockSeconds: safeRelock === null ? 120 : safeRelock,
      updatedAt: now
    });
  } catch (err) {
    console.error('Erreur PUT /api/account/preferences:', err.message);
    return res.status(500).json({ error: 'Preferences update failed' });
  }
});

// Issue a short-lived biometric unlock token (valid for 10 minutes)
app.post('/api/biometric/unlock-token', requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const userId = session.userId;

    if (session?.user?.biometricLockEnabled !== true) {
      return res.status(403).json({ error: 'Biometric lock not enabled' });
    }

    const now = Date.now();
    const expiresAt = now + BIOMETRIC_UNLOCK_TOKEN_DURATION;
    const tokenValue = crypto.randomBytes(32).toString('hex');

    biometricUnlockTokens.set(tokenValue, {
      userId,
      expiresAt,
      issuedAt: now
    });

    // Clean up old tokens periodically
    if (biometricUnlockTokens.size > 1000) {
      for (const [key, val] of biometricUnlockTokens.entries()) {
        if (val.expiresAt < now) {
          biometricUnlockTokens.delete(key);
        }
      }
    }

    return res.json({
      success: true,
      token: tokenValue,
      expiresIn: BIOMETRIC_UNLOCK_TOKEN_DURATION / 1000
    });
  } catch (err) {
    console.error('Erreur POST /api/biometric/unlock-token:', err.message);
    return res.status(500).json({ error: 'Token issuance failed' });
  }
});

// Invalidate biometric unlock token (called when app enters background)
app.post('/api/biometric/lock', requireUserAuth, async (req, res) => {
  try {
    const biometricToken = req.body?.token;

    if (!biometricToken || typeof biometricToken !== 'string') {
      return res.status(400).json({ error: 'Invalid token' });
    }

    biometricUnlockTokens.delete(biometricToken);

    return res.json({
      success: true
    });
  } catch (err) {
    console.error('Erreur POST /api/biometric/lock:', err.message);
    return res.status(500).json({ error: 'Lock failed' });
  }
});

app.get('/api/account/profile', requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    return res.json({
      firstName:
        typeof session.user.firstName === 'string' &&
        session.user.firstName.trim()
          ? session.user.firstName.trim()
          : null,
      country: normalizeCountryCode(session.user.country)
    });
  } catch (err) {
    console.error('Erreur GET /api/account/profile:', err.message);
    return res.status(500).json({ error: 'Profile lookup failed' });
  }
});

app.put('/api/account/profile', requireUserAuth, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid profile payload' });
    }

    const session = req.userSession;
    const patch = {};

    if ('firstName' in req.body) {
      const raw =
        typeof req.body.firstName === 'string'
          ? req.body.firstName.trim().slice(0, 50)
          : '';
      patch.firstName = raw || null;
    }

    if ('country' in req.body) {
      const code = normalizeCountryCode(req.body.country);
      patch.country = code || null;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const now = new Date().toISOString();
    const update = { ...patch, updatedAt: now };
    // Firebase doesn't store null fields - remove them so they're deleted
    for (const [k, v] of Object.entries(update)) {
      if (v === null) update[k] = null; // Firebase treats null as delete
    }

    await usersRef.child(session.userId).update(update);

    return res.json({
      success: true,
      firstName:
        patch.firstName !== undefined
          ? patch.firstName
          : typeof session.user.firstName === 'string'
            ? session.user.firstName.trim()
            : null,
      country:
        patch.country !== undefined
          ? patch.country
          : normalizeCountryCode(session.user.country),
      updatedAt: now
    });
  } catch (err) {
    console.error('Erreur PUT /api/account/profile:', err.message);
    return res.status(500).json({ error: 'Profile update failed' });
  }
});

app.post('/api/account/reset', requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const oldUserId = String(session.userId || '').trim();
    const oldUser =
      session.user && typeof session.user === 'object' ? session.user : {};
    const now = new Date().toISOString();
    const requestId = String(req.headers['x-request-id'] || '').trim() || null;

    if (!oldUserId) {
      console.warn('[ACCOUNT_MEMORY_RESET]', {
        action: 'account_memory_reset',
        status: 'rejected_invalid_session',
        at: now,
        requestId
      });
      return res.status(400).json({ error: 'Invalid user session' });
    }

    const newUserId = `u_${crypto.randomBytes(12).toString('hex')}`;
    const nextUserRecord = {
      email: normalizeEmail(oldUser.email),
      passwordHash:
        typeof oldUser.passwordHash === 'string' ? oldUser.passwordHash : '',
      superId: resolveStableSuperId(oldUserId, oldUser),
      privateConversationsByDefault:
        oldUser.privateConversationsByDefault === true,
      biometricLockEnabled: oldUser.biometricLockEnabled === true,
      biometricRelockSeconds:
        normalizeBiometricRelockSeconds(oldUser.biometricRelockSeconds) ?? 120,
      usageEnvelope: resolveUsageEnvelopeForRead(oldUser.usageEnvelope),
      usageMeter: normalizeUsageMeter(oldUser.usageMeter),
      createdAt: now,
      updatedAt: now,
      firstName:
        typeof oldUser.firstName === 'string' && oldUser.firstName.trim()
          ? oldUser.firstName.trim()
          : null,
      country: normalizeCountryCode(oldUser.country)
    };

    if (!nextUserRecord.email || !nextUserRecord.passwordHash) {
      console.warn('[ACCOUNT_MEMORY_RESET]', {
        action: 'account_memory_reset',
        status: 'rejected_incomplete_account',
        at: now,
        requestId,
        oldUserId,
        hasEmail: !!nextUserRecord.email,
        hasPasswordHash: !!nextUserRecord.passwordHash
      });
      return res
        .status(400)
        .json({ error: 'Compte incomplet pour remise \u00e0 z\u00e9ro' });
    }

    await usersRef.child(newUserId).set(nextUserRecord);
    await usersRef.child(oldUserId).remove();

    const previousSessionToken = parseCookies(req).userSessionId;
    if (previousSessionToken) {
      userSessions.delete(previousSessionToken);
    }

    invalidateUserSessionsByUserId(oldUserId);

    const newSessionToken = buildUserSessionToken(newUserId);
    userSessions.set(newSessionToken, {
      userId: newUserId,
      createdAt: Date.now()
    });

    try {
      await writeAccountResetAudit({
        oldUserId,
        newUserId,
        requestId,
        nowIso: now
      });
    } catch (auditErr) {
      console.warn('[ACCOUNT_MEMORY_RESET_AUDIT_FAILED]', {
        action: 'account_memory_reset_audit',
        status: 'failed',
        at: now,
        requestId,
        error:
          auditErr && auditErr.message ? auditErr.message : String(auditErr)
      });
    }

    res.setHeader(
      'Set-Cookie',
      `userSessionId=${newSessionToken}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${Math.floor(USER_SESSION_DURATION / 1000)}`
    );

    console.info('[ACCOUNT_MEMORY_RESET]', {
      action: 'account_memory_reset',
      oldUserId,
      newUserId,
      status: 'success',
      at: now,
      requestId
    });

    return res.json({
      success: true,
      user: toPublicUser(newUserId, nextUserRecord)
    });
  } catch (err) {
    console.error('[ACCOUNT_MEMORY_RESET]', {
      action: 'account_memory_reset',
      status: 'failed',
      at: new Date().toISOString(),
      error: err && err.message ? err.message : String(err)
    });
    return res
      .status(500)
      .json({ error: 'Op\u00e9ration impossible pour le moment' });
  }
});

app.post('/api/account/close', requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const userId = String(session.userId || '').trim();
    const userRecord =
      session.user && typeof session.user === 'object' ? session.user : {};
    const now = new Date().toISOString();
    const requestId = String(req.headers['x-request-id'] || '').trim() || null;

    if (!userId) {
      return res.status(400).json({ error: 'Invalid user session' });
    }

    const conversationsSnap = await db
      .ref('conversations')
      .orderByChild('userId')
      .equalTo(userId)
      .once('value');

    const conversations = conversationsSnap.val() || {};
    const conversationEntries = Object.entries(conversations).filter(
      ([conversationId, value]) =>
        typeof conversationId === 'string' && value && typeof value === 'object'
    );

    const archivedConversations = {};
    const archivedMessagesByConversation = {};
    const conversationDeletePatch = {};
    const messageDeletePatch = {};

    for (const [conversationId, conversationData] of conversationEntries) {
      archivedConversations[conversationId] = conversationData;
      conversationDeletePatch[conversationId] = null;

      const messageSnap = await messagesRef
        .orderByChild('conversationId')
        .equalTo(conversationId)
        .once('value');
      const messageMap = messageSnap.val() || {};
      archivedMessagesByConversation[conversationId] = messageMap;

      Object.keys(messageMap).forEach((messageId) => {
        if (typeof messageId === 'string' && messageId.trim()) {
          messageDeletePatch[messageId] = null;
        }
      });
    }

    await accountArchivesRef.child(userId).set({
      userId,
      archivedAt: now,
      closeReason: 'user_requested_closure',
      requestId,
      user: userRecord,
      conversations: archivedConversations,
      messagesByConversation: archivedMessagesByConversation
    });

    if (Object.keys(messageDeletePatch).length > 0) {
      await messagesRef.update(messageDeletePatch);
    }
    if (Object.keys(conversationDeletePatch).length > 0) {
      await db.ref('conversations').update(conversationDeletePatch);
    }

    await usersRef.child(userId).remove();
    await userLabelsRef.child(userId).remove();

    const sessionToken = parseCookies(req).userSessionId;
    if (sessionToken) {
      userSessions.delete(sessionToken);
    }
    invalidateUserSessionsByUserId(userId);

    res.setHeader(
      'Set-Cookie',
      'userSessionId=; HttpOnly; Path=/; Secure; Max-Age=0'
    );

    console.info('[ACCOUNT_CLOSURE]', {
      action: 'account_closure',
      userId,
      status: 'success',
      at: now,
      requestId,
      archivedConversationCount: conversationEntries.length
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('[ACCOUNT_CLOSURE]', {
      action: 'account_closure',
      status: 'failed',
      at: new Date().toISOString(),
      error: err && err.message ? err.message : String(err)
    });
    return res
      .status(500)
      .json({ error: 'Op\u00e9ration impossible pour le moment' });
  }
});

app.get('/api/account/conversations', requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const snapshot = await db.ref('conversations').once('value');
    const raw = snapshot.val() || {};

    const conversations = Object.entries(raw)
      .filter(([, value]) => {
        if (String(value?.userId || '') !== session.userId) {
          return false;
        }

        if (typeof value?.deletedAt === 'string' && value.deletedAt.trim()) {
          return false;
        }

        if (value?.isBranch === true) {
          return false;
        }

        return true;
      })
      .map(([id, value]) => ({
        id,
        title: typeof value?.title === 'string' ? value.title : null,
        updatedAt: value?.updatedAt || value?.createdAt || null,
        createdAt: value?.createdAt || null,
        messageCount: Number(value?.messageCount || 0),
        titleLocked: value?.titleLocked === true,
        lastUserMessage:
          typeof value?.lastUserMessage === 'string'
            ? value.lastUserMessage
            : ''
      }))
      .sort((a, b) =>
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      );

    return res.json({ conversations });
  } catch (err) {
    console.error('Erreur /api/account/conversations:', err.message);
    return res.status(500).json({ error: 'Conversation lookup failed' });
  }
});

app.get('/api/account/conversations/:id', requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const conversationId = String(req.params?.id || '').trim();

    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation invalide' });
    }

    const convSnap = await db
      .ref('conversations')
      .child(conversationId)
      .once('value');
    const conversation = convSnap.val();

    if (!conversation || typeof conversation !== 'object') {
      return res.status(404).json({ error: 'Conversation introuvable' });
    }

    if (
      typeof conversation.deletedAt === 'string' &&
      conversation.deletedAt.trim()
    ) {
      return res.status(404).json({ error: 'Conversation introuvable' });
    }

    if (String(conversation.userId || '') !== session.userId) {
      return res.status(403).json({ error: 'Conversation ownership mismatch' });
    }

    const messagesSnap = await messagesRef
      .orderByChild('conversationId')
      .equalTo(conversationId)
      .once('value');

    const messagesRaw = messagesSnap.val() || {};
    const messages = Object.entries(messagesRaw)
      .map(([id, value]) => ({
        id,
        role: String(value?.role || ''),
        content: String(value?.content || ''),
        feedback: normalizeFeedbackForRead(
          value?.feedback && typeof value.feedback === 'object'
            ? value.feedback
            : null
        ),
        debug: Array.isArray(value?.debug) ? value.debug : [],
        debugMeta:
          value?.debugMeta && typeof value.debugMeta === 'object'
            ? value.debugMeta
            : null,
        stateSnapshot:
          value?.stateSnapshot && typeof value?.stateSnapshot === 'object'
            ? {
                memory:
                  typeof value.stateSnapshot.memory === 'string'
                    ? value.stateSnapshot.memory
                    : '',
                flags: normalizeSessionFlags(value.stateSnapshot.flags || {})
              }
            : null,
        timestamp: Number(value?.timestamp || 0)
      }))
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

    return res.json({
      conversation: {
        id: conversationId,
        title:
          typeof conversation.title === 'string' ? conversation.title : null,
        updatedAt: conversation.updatedAt || conversation.createdAt || null,
        createdAt: conversation.createdAt || null,
        memory: normalizeMemory(
          conversation.memory || '',
          buildDefaultPromptRegistry()
        ),
        flags: normalizeSessionFlags(conversation.flags || {})
      },
      messages
    });
  } catch (err) {
    console.error('Erreur /api/account/conversations/:id:', err.message);
    return res.status(500).json({ error: 'Conversation fetch failed' });
  }
});

app.patch(
  '/api/account/conversations/:id',
  requireUserAuth,
  async (req, res) => {
    try {
      const session = req.userSession;
      const conversationId = String(req.params?.id || '').trim();

      if (!conversationId) {
        return res.status(400).json({ error: 'Conversation invalide' });
      }

      if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body)
      ) {
        return res
          .status(400)
          .json({ error: 'Invalid conversation update request' });
      }

      const hasTitleField = Object.prototype.hasOwnProperty.call(
        req.body,
        'title'
      );
      if (!hasTitleField) {
        return res.status(400).json({ error: 'Missing title field' });
      }

      const rawTitle = req.body.title;
      if (rawTitle !== null && typeof rawTitle !== 'string') {
        return res.status(400).json({ error: 'Invalid title value' });
      }

      const convRef = db.ref('conversations').child(conversationId);
      const convSnap = await convRef.once('value');
      const conversation = convSnap.val();

      if (!conversation || typeof conversation !== 'object') {
        return res.status(404).json({ error: 'Conversation introuvable' });
      }

      if (
        typeof conversation.deletedAt === 'string' &&
        conversation.deletedAt.trim()
      ) {
        return res.status(404).json({ error: 'Conversation introuvable' });
      }

      if (String(conversation.userId || '') !== session.userId) {
        return res
          .status(403)
          .json({ error: 'Conversation ownership mismatch' });
      }

      const normalizedTitle =
        typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 60) : '';
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
      console.error(
        'Erreur PATCH /api/account/conversations/:id:',
        err.message
      );
      return res.status(500).json({ error: 'Conversation update failed' });
    }
  }
);

app.delete(
  '/api/account/conversations/:id',
  requireUserAuth,
  async (req, res) => {
    try {
      const session = req.userSession;
      const conversationId = String(req.params?.id || '').trim();

      if (!conversationId) {
        return res.status(400).json({ error: 'Conversation invalide' });
      }

      const convRef = db.ref('conversations').child(conversationId);
      const convSnap = await convRef.once('value');
      const conversation = convSnap.val();

      if (!conversation || typeof conversation !== 'object') {
        return res.status(404).json({ error: 'Conversation introuvable' });
      }

      if (
        typeof conversation.deletedAt === 'string' &&
        conversation.deletedAt.trim()
      ) {
        return res.json({ success: true, alreadyDeleted: true });
      }

      if (String(conversation.userId || '') !== session.userId) {
        return res
          .status(403)
          .json({ error: 'Conversation ownership mismatch' });
      }

      const now = new Date().toISOString();

      await convRef.update({
        deletedAt: now,
        updatedAt: now
      });

      return res.json({ success: true, deletedAt: now });
    } catch (err) {
      console.error(
        'Erreur DELETE /api/account/conversations/:id:',
        err.message
      );
      return res.status(500).json({ error: 'Conversation delete failed' });
    }
  }
);

app.post(
  '/api/account/conversations/claim',
  requireUserAuth,
  async (req, res) => {
    try {
      const session = req.userSession;

      if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body) ||
        typeof req.body.anonymousUserId !== 'string' ||
        !Array.isArray(req.body.conversationIds)
      ) {
        return res.status(400).json({ error: 'Invalid claim request' });
      }

      const anonymousUserId = String(req.body.anonymousUserId || '').trim();
      const conversationIds = req.body.conversationIds
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .slice(0, 100);

      if (!anonymousUserId || conversationIds.length === 0) {
        return res.status(400).json({ error: 'Claim payload incomplete' });
      }

      const uniqueConversationIds = Array.from(new Set(conversationIds));
      const claimedConversationIds = [];
      let alreadyOwnedCount = 0;
      let skippedCount = 0;

      for (const conversationId of uniqueConversationIds) {
        const convRef = db.ref('conversations').child(conversationId);
        const convSnap = await convRef.once('value');
        const conversation = convSnap.val();

        if (!conversation || typeof conversation !== 'object') {
          skippedCount += 1;
          continue;
        }

        const ownerId = String(conversation.userId || '').trim();

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
          .orderByChild('conversationId')
          .equalTo(conversationId)
          .once('value');

        const messages = messagesSnap.val() || {};
        const messageUpdates = {};

        Object.entries(messages).forEach(([messageId, value]) => {
          if (
            typeof messageId !== 'string' ||
            !value ||
            typeof value !== 'object'
          ) {
            return;
          }

          if (String(value.userId || '').trim() === anonymousUserId) {
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
      console.error('Erreur /api/account/conversations/claim:', err.message);
      return res.status(500).json({ error: 'Conversation claim failed' });
    }
  }
);

app.post(
  '/api/account/conversations/import-local',
  requireUserAuth,
  async (req, res) => {
    try {
      const session = req.userSession;

      if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body) ||
        !Array.isArray(req.body.conversations)
      ) {
        return res.status(400).json({ error: 'Invalid local import request' });
      }

      const forceOverwrite = req.body.forceOverwrite === true;
      const conversations = req.body.conversations.slice(0, 50);
      const importedConversationIds = [];
      const messageIdsByConversation = {};
      let alreadyOwnedCount = 0;
      let skippedCount = 0;

      for (const rawConversation of conversations) {
        const safeConversation =
          rawConversation &&
          typeof rawConversation === 'object' &&
          !Array.isArray(rawConversation)
            ? rawConversation
            : null;
        const conversationId = String(safeConversation?.id || '').trim();

        if (!conversationId) {
          skippedCount += 1;
          continue;
        }

        const convRef = db.ref('conversations').child(conversationId);
        const convSnap = await convRef.once('value');
        const existingConversation = convSnap.val();

        if (existingConversation && typeof existingConversation === 'object') {
          const ownerId = String(existingConversation.userId || '').trim();

          if (ownerId === session.userId) {
            if (!forceOverwrite) {
              alreadyOwnedCount += 1;
              continue;
            }
            // forceOverwrite: delete existing messages then re-import
            const existingMsgsSnap = await messagesRef
              .orderByChild('conversationId')
              .equalTo(conversationId)
              .once('value');
            const deleteOps = [];
            existingMsgsSnap.forEach((child) => {
              deleteOps.push(child.ref.remove());
            });
            await Promise.all(deleteOps);
          } else {
            skippedCount += 1;
            continue;
          }
        }

        const rawMessages = Array.isArray(safeConversation?.messages)
          ? safeConversation.messages
          : [];
        const sanitizedMessages = rawMessages
          .map((entry, index) => {
            const safeEntry =
              entry && typeof entry === 'object' && !Array.isArray(entry)
                ? entry
                : null;
            const role = String(safeEntry?.role || '').trim();
            const content =
              typeof safeEntry?.content === 'string' ? safeEntry.content : '';

            if ((role !== 'user' && role !== 'assistant') || !content.trim()) {
              return null;
            }

            const timestampCandidate = Number(
              safeEntry?.t || safeEntry?.timestamp || 0
            );
            const timestamp =
              Number.isFinite(timestampCandidate) && timestampCandidate > 0
                ? timestampCandidate
                : Date.now() + index;

            const debugMeta =
              safeEntry?.debugMeta &&
              typeof safeEntry.debugMeta === 'object' &&
              !Array.isArray(safeEntry.debugMeta)
                ? safeEntry.debugMeta
                : null;
            const stateSnapshot =
              safeEntry?.stateSnapshot &&
              typeof safeEntry.stateSnapshot === 'object' &&
              !Array.isArray(safeEntry.stateSnapshot)
                ? safeEntry.stateSnapshot
                : null;

            return {
              role,
              content,
              timestamp,
              debug: Array.isArray(safeEntry?.debug) ? safeEntry.debug : [],
              debugMeta: debugMeta
                ? {
                    topChips: Array.isArray(debugMeta.topChips)
                      ? debugMeta.topChips
                      : [],
                    memory:
                      typeof debugMeta.memory === 'string'
                        ? debugMeta.memory
                        : '',
                    directivityText:
                      typeof debugMeta.directivityText === 'string'
                        ? debugMeta.directivityText
                        : '',
                    conversationState:
                      typeof debugMeta.conversationState === 'string'
                        ? debugMeta.conversationState
                        : null,
                    consecutiveNonExplorationTurns: Number.isInteger(
                      debugMeta.consecutiveNonExplorationTurns
                    )
                      ? Math.max(0, debugMeta.consecutiveNonExplorationTurns)
                      : 0,
                    interpretationRejection:
                      debugMeta.interpretationRejection === true,
                    needsSoberReadjustment:
                      debugMeta.needsSoberReadjustment === true,
                    relationalAdjustmentActive:
                      debugMeta.relationalAdjustmentActive === true,
                    pipelineStages: Array.isArray(debugMeta.pipelineStages)
                      ? debugMeta.pipelineStages
                          .map((e) => ({
                            stage:
                              typeof e?.stage === 'string' ? e.stage : null,
                            deltaMs: Number.isFinite(e?.deltaMs)
                              ? e.deltaMs
                              : null
                          }))
                          .filter((e) => e.stage)
                      : [],
                    explorationCalibrationLevel: Number.isInteger(
                      debugMeta.explorationCalibrationLevel
                    )
                      ? debugMeta.explorationCalibrationLevel
                      : null,
                    explorationSignal:
                      typeof debugMeta.explorationSignal === 'string'
                        ? debugMeta.explorationSignal
                        : null,
                    analyzerDeterministicEvidence: Array.isArray(
                      debugMeta.analyzerDeterministicEvidence
                    )
                      ? debugMeta.analyzerDeterministicEvidence
                          .map((v) => String(v || ''))
                          .filter(Boolean)
                      : [],
                    intent:
                      typeof debugMeta.intent === 'string'
                        ? debugMeta.intent
                        : null,
                    forbidden: Array.isArray(debugMeta.forbidden)
                      ? debugMeta.forbidden
                          .map((v) => String(v || ''))
                          .filter(Boolean)
                      : [],
                    confidenceSignal:
                      typeof debugMeta.confidenceSignal === 'number'
                        ? Math.max(0, Math.min(1, debugMeta.confidenceSignal))
                        : 1.0,
                    relancePolicy:
                      typeof debugMeta.relancePolicy === 'string'
                        ? debugMeta.relancePolicy
                        : null,
                    actionCollapseGuardActive:
                      debugMeta.actionCollapseGuardActive === true,
                    stateTransitionFrom:
                      typeof debugMeta.stateTransitionFrom === 'string'
                        ? debugMeta.stateTransitionFrom
                        : null,
                    stateTransitionValid:
                      debugMeta.stateTransitionValid !== false,
                    stateTransitionRequested:
                      typeof debugMeta.stateTransitionRequested === 'string'
                        ? debugMeta.stateTransitionRequested
                        : null,
                    allianceSignal:
                      typeof debugMeta.allianceSignal === 'string'
                        ? debugMeta.allianceSignal
                        : null,
                    engagementLevel:
                      typeof debugMeta.engagementLevel === 'string'
                        ? debugMeta.engagementLevel
                        : null,
                    attentionWindow:
                      typeof debugMeta.attentionWindow === 'string'
                        ? debugMeta.attentionWindow
                        : null,
                    dependencyRiskScore: Number.isFinite(
                      debugMeta.dependencyRiskScore
                    )
                      ? Math.max(
                          0,
                          Math.min(
                            100,
                            Math.round(Number(debugMeta.dependencyRiskScore))
                          )
                        )
                      : 0,
                    dependencyRiskLevel:
                      typeof debugMeta.dependencyRiskLevel === 'string'
                        ? debugMeta.dependencyRiskLevel
                        : null,
                    externalSupportMode:
                      typeof debugMeta.externalSupportMode === 'string'
                        ? debugMeta.externalSupportMode
                        : null,
                    closureIntent: debugMeta.closureIntent === true,
                    infoRoutingSource:
                      typeof debugMeta.infoRoutingSource === 'string'
                        ? debugMeta.infoRoutingSource
                        : null,
                    modelConflict: debugMeta.modelConflict === true,
                    // Fields stored in Firebase but previously missing from admin API
                    writerIntentHints: Array.isArray(
                      debugMeta.writerIntentHints
                    )
                      ? debugMeta.writerIntentHints
                          .map((v) => String(v || ''))
                          .filter(Boolean)
                      : [],
                    writerIntentHintsInactive: Array.isArray(
                      debugMeta.writerIntentHintsInactive
                    )
                      ? debugMeta.writerIntentHintsInactive
                          .map((entry) => {
                            if (!entry || typeof entry !== 'object')
                              return null;
                            const hint = String(entry.hint || '').trim();
                            const reason = String(entry.reason || '').trim();
                            return hint && reason ? { hint, reason } : null;
                          })
                          .filter(Boolean)
                      : [],
                    affiliationScore:
                      typeof debugMeta.affiliationScore === 'number'
                        ? debugMeta.affiliationScore
                        : null,
                    affiliationFinalScore:
                      typeof debugMeta.affiliationFinalScore === 'number'
                        ? debugMeta.affiliationFinalScore
                        : null,
                    affiliationWindow: Array.isArray(
                      debugMeta.affiliationWindow
                    )
                      ? debugMeta.affiliationWindow.map((v) =>
                          typeof v === 'number' ? v : 0
                        )
                      : [],
                    affiliationEstablished:
                      debugMeta.affiliationEstablished === true,
                    emotionalDecentering:
                      debugMeta.emotionalDecentering === true,
                    formalAddress: debugMeta.formalAddress === true,
                    contactInsightMoment:
                      debugMeta.contactInsightMoment === true,
                    contactSelfCriticismLevel:
                      typeof debugMeta.contactSelfCriticismLevel === 'string'
                        ? debugMeta.contactSelfCriticismLevel
                        : 'low',
                    aggressiveDischargeDetected:
                      debugMeta.aggressiveDischargeDetected === true,
                    postDischargeTransitionActive:
                      debugMeta.postDischargeTransitionActive === true,
                    secondaryTension:
                      debugMeta.secondaryTension &&
                      typeof debugMeta.secondaryTension === 'object' &&
                      !Array.isArray(debugMeta.secondaryTension)
                        ? debugMeta.secondaryTension
                        : null,
                    n2TurnType:
                      typeof debugMeta.n2TurnType === 'string'
                        ? debugMeta.n2TurnType
                        : null,
                    emergencyNumbersIncluded:
                      debugMeta.emergencyNumbersIncluded === true,
                    postCrisisSupportActive:
                      debugMeta.postCrisisSupportActive === true,
                    postCrisisSupportCarryTurn:
                      debugMeta.postCrisisSupportCarryTurn === true,
                    emergencySupportText:
                      typeof debugMeta.emergencySupportText === 'string'
                        ? debugMeta.emergencySupportText
                        : null,
                    majorHarmRiskLevel:
                      debugMeta.majorHarmRiskLevel === 'H1' ||
                      debugMeta.majorHarmRiskLevel === 'H2'
                        ? debugMeta.majorHarmRiskLevel
                        : 'H0',
                    majorHarmImminenceBand: [
                      'none',
                      'immediate',
                      'short_term',
                      'capability_opportunity'
                    ].includes(debugMeta.majorHarmImminenceBand)
                      ? debugMeta.majorHarmImminenceBand
                      : 'none',
                    majorHarmTargetsPeople:
                      debugMeta.majorHarmTargetsPeople === true,
                    requestId:
                      typeof debugMeta.requestId === 'string'
                        ? debugMeta.requestId
                        : null,
                    traceId:
                      typeof debugMeta.traceId === 'string'
                        ? debugMeta.traceId
                        : null,
                    uncertaintyExpressionPolicy:
                      typeof debugMeta.uncertaintyExpressionPolicy === 'string'
                        ? debugMeta.uncertaintyExpressionPolicy
                        : null,
                    uncertaintyDrivers: Array.isArray(
                      debugMeta.uncertaintyDrivers
                    )
                      ? debugMeta.uncertaintyDrivers
                          .map((v) => String(v || ''))
                          .filter(Boolean)
                      : [],
                    isolationScore: Number.isFinite(debugMeta.isolationScore)
                      ? Math.max(
                          0,
                          Math.min(
                            100,
                            Math.round(Number(debugMeta.isolationScore))
                          )
                        )
                      : 0,
                    attachmentScore: Number.isFinite(debugMeta.attachmentScore)
                      ? Math.max(
                          0,
                          Math.min(
                            100,
                            Math.round(Number(debugMeta.attachmentScore))
                          )
                        )
                      : 0,
                    dependencyCareMessagePending:
                      debugMeta.dependencyCareMessagePending === 'medium' ||
                      debugMeta.dependencyCareMessagePending === 'high'
                        ? debugMeta.dependencyCareMessagePending
                        : false
                  }
                : null,
              stateSnapshot: stateSnapshot
                ? {
                    memory:
                      typeof stateSnapshot.memory === 'string'
                        ? normalizeMemory(
                            stateSnapshot.memory,
                            buildDefaultPromptRegistry()
                          )
                        : '',
                    flags: normalizeSessionFlags(stateSnapshot.flags || {})
                  }
                : null
            };
          })
          .filter(Boolean);

        const normalizedMemory = normalizeMemory(
          typeof safeConversation?.memory === 'string'
            ? safeConversation.memory
            : '',
          buildDefaultPromptRegistry()
        );
        const normalizedFlags = normalizeSessionFlags(
          safeConversation?.flags || {}
        );
        const conversationIsPrivate = safeConversation?.isPrivate === true;

        const updatedAtCandidate = Number(safeConversation?.updatedAt || 0);
        const updatedAtIso =
          Number.isFinite(updatedAtCandidate) && updatedAtCandidate > 0
            ? new Date(updatedAtCandidate).toISOString()
            : new Date().toISOString();

        const firstUserMessage = sanitizedMessages.find(
          (item) => item.role === 'user'
        );
        const lastUserMessage = [...sanitizedMessages]
          .reverse()
          .find((item) => item.role === 'user');
        const fallbackTitle =
          lastUserMessage?.content?.slice(0, 60) ||
          firstUserMessage?.content?.slice(0, 60) ||
          'Conversation sans titre';
        const rawTitle =
          typeof safeConversation?.title === 'string'
            ? safeConversation.title.trim()
            : '';

        await convRef.set({
          userId: session.userId,
          title: rawTitle || fallbackTitle,
          titleLocked: safeConversation?.isCustomTitle === true,
          messageCount: sanitizedMessages.length,
          lastUserMessage: lastUserMessage?.content || '',
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
      console.error(
        'Erreur /api/account/conversations/import-local:',
        err.message
      );
      return res
        .status(500)
        .json({ error: 'Local conversation import failed' });
    }
  }
);

app.get('/api/branches', async (req, res) => {
  try {
    const actorUserId = await resolveBranchActorUserId(req);

    if (!actorUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const snapshot = await branchRecordsRef
      .orderByChild('userId')
      .equalTo(actorUserId)
      .limitToLast(100)
      .once('value');

    const raw = snapshot.val() || {};
    const branches = Object.entries(raw)
      .map(([id, item]) => ({
        id,
        sourceConversationId: String(item?.sourceConversationId || ''),
        sourceAnchorMessageId: String(item?.sourceAnchorMessageId || ''),
        branchConversationId: String(item?.branchConversationId || ''),
        seedMessageCount: Number(item?.seedMessageCount) || 0,
        createdAt: typeof item?.createdAt === 'string' ? item.createdAt : null,
        updatedAt: typeof item?.updatedAt === 'string' ? item.updatedAt : null,
        activatedAt:
          typeof item?.activatedAt === 'string' ? item.activatedAt : null,
        status: String(item?.status || 'active')
      }))
      .sort((a, b) =>
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      );

    return res.json({ branches });
  } catch (err) {
    console.error('Erreur /api/branches:', err.message);
    return res.status(500).json({ error: 'Branches lookup failed' });
  }
});

app.post('/api/branches/from-message', async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      typeof req.body.sourceConversationId !== 'string' ||
      (req.body.anchorMessageId !== undefined &&
        typeof req.body.anchorMessageId !== 'string') ||
      (req.body.seedMessages !== undefined &&
        !Array.isArray(req.body.seedMessages)) ||
      (req.body.userId !== undefined && typeof req.body.userId !== 'string')
    ) {
      return res.status(400).json({ error: 'Invalid branch request' });
    }

    const actorUserId = await resolveBranchActorUserId(req);
    const sourceConversationId = String(
      req.body.sourceConversationId || ''
    ).trim();
    const anchorMessageId = String(req.body.anchorMessageId || '').trim();
    const requestedSeedMessages = Array.isArray(req.body.seedMessages)
      ? req.body.seedMessages
      : null;

    if (!sourceConversationId || !actorUserId) {
      return res
        .status(400)
        .json({ error: 'Missing sourceConversationId or userId' });
    }

    const conversationSnap = await db
      .ref('conversations')
      .child(sourceConversationId)
      .once('value');
    const sourceConversation = conversationSnap.val();

    if (!sourceConversation || typeof sourceConversation !== 'object') {
      return res.status(404).json({ error: 'Source conversation not found' });
    }

    if (String(sourceConversation.userId || '') !== actorUserId) {
      return res.status(403).json({ error: 'Conversation ownership mismatch' });
    }

    const messagesSnap = await messagesRef
      .orderByChild('conversationId')
      .equalTo(sourceConversationId)
      .once('value');

    const rawMessages = messagesSnap.val() || {};
    const messageEntries = Object.entries(rawMessages)
      .map(([id, item]) => ({
        id,
        item: item && typeof item === 'object' ? item : {}
      }))
      .sort((a, b) => {
        const aDate = String(a.item.createdAt || '');
        const bDate = String(b.item.createdAt || '');
        if (aDate && bDate && aDate !== bDate) {
          return aDate.localeCompare(bDate);
        }
        return String(a.id).localeCompare(String(b.id));
      });

    const seedResolution = resolveBranchSeedPayload({
      messageEntries,
      anchorMessageId,
      requestedSeedMessages
    });

    if (seedResolution.error === 'anchor_not_found') {
      logBranchRouteEvent('warn', 'anchor_not_found', {
        route: '/api/branches/from-message',
        sourceConversationId,
        anchorMessageId,
        dbMessageCount: messageEntries.length,
        requestedSeedCount: Array.isArray(requestedSeedMessages)
          ? requestedSeedMessages.length
          : 0
      });
      return res.status(404).json({ error: 'Anchor message not found' });
    }

    const seededMessages = seedResolution.seededMessages;
    const resolvedAnchorMessageId = seedResolution.resolvedAnchorMessageId;

    if (seedResolution.usedSeedFallback) {
      logBranchRouteEvent('info', 'anchor_fallback_used', {
        route: '/api/branches/from-message',
        sourceConversationId,
        anchorMessageId,
        resolvedAnchorMessageId,
        dbMessageCount: messageEntries.length,
        seededMessageCount: seededMessages.length
      });
    }

    const now = new Date().toISOString();
    const branchConversationId = `c_branch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const branchRef = branchRecordsRef.push();
    const branchId = branchRef.key;

    if (!branchId) {
      return res.status(500).json({ error: 'Failed to create branch id' });
    }

    await Promise.all([
      branchRef.set({
        userId: actorUserId,
        sourceConversationId,
        sourceAnchorMessageId: resolvedAnchorMessageId,
        branchConversationId,
        seedMessageCount: seededMessages.length,
        status: 'active',
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
        status: 'active'
      }
    });
  } catch (err) {
    console.error('Erreur /api/branches/from-message:', err.message);
    return res.status(500).json({ error: 'Branch creation failed' });
  }
});

app.post('/api/branches/create-and-activate', async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      typeof req.body.sourceConversationId !== 'string' ||
      (req.body.anchorMessageId !== undefined &&
        typeof req.body.anchorMessageId !== 'string') ||
      (req.body.seedMessages !== undefined &&
        !Array.isArray(req.body.seedMessages)) ||
      (req.body.userId !== undefined && typeof req.body.userId !== 'string') ||
      (req.body.flags !== undefined &&
        (typeof req.body.flags !== 'object' ||
          req.body.flags === null ||
          Array.isArray(req.body.flags)))
    ) {
      return res.status(400).json({ error: 'Invalid branch request' });
    }

    const actorUserId = await resolveBranchActorUserId(req);
    const sourceConversationId = String(
      req.body.sourceConversationId || ''
    ).trim();
    const anchorMessageId = String(req.body.anchorMessageId || '').trim();
    const requestedSeedMessages = Array.isArray(req.body.seedMessages)
      ? req.body.seedMessages
      : null;

    if (!sourceConversationId || !actorUserId) {
      return res
        .status(400)
        .json({ error: 'Missing sourceConversationId or userId' });
    }

    const requestedBranchMemory =
      typeof req.body?.memory === 'string' && req.body.memory.trim()
        ? normalizeMemory(req.body.memory, buildDefaultPromptRegistry())
        : '';
    const requestedBranchFlags =
      req.body?.flags !== undefined
        ? normalizeSessionFlags(req.body.flags)
        : null;

    const [conversationSnap, messagesSnap] = await Promise.all([
      db.ref('conversations').child(sourceConversationId).once('value'),
      messagesRef
        .orderByChild('conversationId')
        .equalTo(sourceConversationId)
        .once('value')
    ]);

    const sourceConversation = conversationSnap.val();
    if (!sourceConversation || typeof sourceConversation !== 'object') {
      return res.status(404).json({ error: 'Source conversation not found' });
    }

    if (String(sourceConversation.userId || '') !== actorUserId) {
      return res.status(403).json({ error: 'Conversation ownership mismatch' });
    }

    const rawMessages = messagesSnap.val() || {};
    const messageEntries = Object.entries(rawMessages)
      .map(([id, item]) => ({
        id,
        item: item && typeof item === 'object' ? item : {}
      }))
      .sort((a, b) => {
        const aDate = String(a.item.createdAt || '');
        const bDate = String(b.item.createdAt || '');
        if (aDate && bDate && aDate !== bDate)
          return aDate.localeCompare(bDate);
        return String(a.id).localeCompare(String(b.id));
      });

    const seedResolution = resolveBranchSeedPayload({
      messageEntries,
      anchorMessageId,
      requestedSeedMessages
    });

    if (seedResolution.error === 'anchor_not_found') {
      logBranchRouteEvent('warn', 'anchor_not_found', {
        route: '/api/branches/create-and-activate',
        sourceConversationId,
        anchorMessageId,
        dbMessageCount: messageEntries.length,
        requestedSeedCount: Array.isArray(requestedSeedMessages)
          ? requestedSeedMessages.length
          : 0
      });
      return res.status(404).json({ error: 'Anchor message not found' });
    }

    const seededMessages = seedResolution.seededMessages;
    const resolvedAnchorMessageId = seedResolution.resolvedAnchorMessageId;

    if (seedResolution.usedSeedFallback) {
      logBranchRouteEvent('info', 'anchor_fallback_used', {
        route: '/api/branches/create-and-activate',
        sourceConversationId,
        anchorMessageId,
        resolvedAnchorMessageId,
        dbMessageCount: messageEntries.length,
        seededMessageCount: seededMessages.length
      });
    }

    const now = new Date().toISOString();
    const branchConversationId = `c_branch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const branchRef = branchRecordsRef.push();
    const branchId = branchRef.key;

    if (!branchId) {
      return res.status(500).json({ error: 'Failed to create branch id' });
    }

    const sourceConversationTitle = String(
      sourceConversation.title || ''
    ).trim();

    const lastUserMessage = [...seededMessages]
      .reverse()
      .find((m) => String(m?.role || '') === 'user');

    await Promise.all([
      branchRef.set({
        userId: actorUserId,
        sourceConversationId,
        sourceAnchorMessageId: resolvedAnchorMessageId,
        branchConversationId,
        seedMessageCount: seededMessages.length,
        status: 'active',
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
      db
        .ref('conversations')
        .child(branchConversationId)
        .set({
          userId: actorUserId,
          isBranch: true,
          sourceConversationId,
          createdAt: now,
          updatedAt: now,
          title:
            sourceConversationTitle || `Branche de ${sourceConversationId}`,
          titleLocked: false,
          messageCount: seededMessages.filter(
            (m) => String(m?.role || '') === 'user'
          ).length,
          lastUserMessage: lastUserMessage
            ? String(lastUserMessage.content || '')
            : '',
          memory: requestedBranchMemory,
          flags: requestedBranchFlags || normalizeSessionFlags({})
        })
    ]);

    if (seededMessages.length > 0) {
      await Promise.all(
        seededMessages.map((message, index) => {
          const timestampBase = Date.now();
          return messagesRef.push({
            role: String(message?.role || ''),
            content: String(message?.content || ''),
            timestamp: timestampBase + index,
            userId: actorUserId,
            conversationId: branchConversationId,
            debug: Array.isArray(message?.debug) ? message.debug : [],
            debugMeta:
              message?.debugMeta && typeof message.debugMeta === 'object'
                ? message.debugMeta
                : null,
            branchId,
            sourceMessageId: typeof message?.id === 'string' ? message.id : null
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
        status: 'active',
        activatedAt: now
      },
      memory: requestedBranchMemory,
      flags: requestedBranchFlags !== null ? requestedBranchFlags : undefined
    });
  } catch (err) {
    console.error('Erreur /api/branches/create-and-activate:', err.message);
    return res.status(500).json({ error: 'Branch create-and-activate failed' });
  }
});

function sanitizeFeedbackContext(rawContext) {
  if (
    !rawContext ||
    typeof rawContext !== 'object' ||
    Array.isArray(rawContext)
  ) {
    return null;
  }

  const recentMessages = Array.isArray(rawContext.recentMessages)
    ? rawContext.recentMessages
        .slice(-4)
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return null;
          }

          const role = String(entry.role || '').trim();
          if (role !== 'user' && role !== 'assistant') {
            return null;
          }

          const content = String(entry.content || '').trim().slice(0, 2000);
          if (!content) {
            return null;
          }

          return { role, content };
        })
        .filter(Boolean)
    : [];

  const memory =
    typeof rawContext.memory === 'string'
      ? rawContext.memory.trim().slice(0, 6000)
      : '';

  const flags = normalizeSessionFlags(rawContext.flags || {});

  const botDebug = Array.isArray(rawContext.botDebug)
    ? rawContext.botDebug
        .map((line) => String(line || '').trim().slice(0, 500))
        .filter(Boolean)
        .slice(0, 60)
    : [];

  const defaults = buildDefaultPromptRegistry();
  const safeNormalizeDebugMetaForFeedback = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    if (typeof normalizeDebugMetaForStorage === 'function') {
      return normalizeDebugMetaForStorage(value, defaults);
    }

    // Fallback: keep a bounded subset when the full normalizer is unavailable.
    return {
      topChips: Array.isArray(value.topChips)
        ? value.topChips
            .map((entry) => String(entry || '').trim().slice(0, 120))
            .filter(Boolean)
            .slice(0, 20)
        : [],
      memory:
        typeof value.memory === 'string'
          ? value.memory.trim().slice(0, 6000)
          : '',
      directivityText:
        typeof value.directivityText === 'string'
          ? value.directivityText.trim().slice(0, 2000)
          : '',
      conversationState:
        typeof value.conversationState === 'string'
          ? value.conversationState.trim().slice(0, 80)
          : null,
      requestId:
        typeof value.requestId === 'string'
          ? value.requestId.trim().slice(0, 120)
          : null,
      traceId:
        typeof value.traceId === 'string'
          ? value.traceId.trim().slice(0, 120)
          : null
    };
  };
  const botDebugMeta =
    rawContext.botDebugMeta &&
    typeof rawContext.botDebugMeta === 'object' &&
    !Array.isArray(rawContext.botDebugMeta)
      ? safeNormalizeDebugMetaForFeedback(rawContext.botDebugMeta)
      : null;

  const botStateSnapshot =
    rawContext.botStateSnapshot &&
    typeof rawContext.botStateSnapshot === 'object' &&
    !Array.isArray(rawContext.botStateSnapshot)
      ? {
          memory:
            typeof rawContext.botStateSnapshot.memory === 'string'
              ? normalizeMemory(rawContext.botStateSnapshot.memory, defaults)
              : '',
          flags: normalizeSessionFlags(rawContext.botStateSnapshot.flags || {})
        }
      : null;

  const capturedAt =
    typeof rawContext.capturedAt === 'number' &&
    Number.isFinite(rawContext.capturedAt)
      ? Math.max(0, Math.round(rawContext.capturedAt))
      : Date.now();

  if (
    recentMessages.length === 0 &&
    !memory &&
    botDebug.length === 0 &&
    !botDebugMeta &&
    !botStateSnapshot
  ) {
    return null;
  }

  return {
    recentMessages,
    memory: memory || null,
    flags,
    botDebug,
    botDebugMeta,
    botStateSnapshot,
    capturedAt
  };
}

function normalizeFeedbackForRead(rawFeedback) {
  if (!rawFeedback || typeof rawFeedback !== 'object') {
    return null;
  }

  let context = null;
  try {
    context = sanitizeFeedbackContext(rawFeedback.context);
  } catch (err) {
    console.warn('[FEEDBACK_CONTEXT_READ_FAILED]', {
      error: err && err.message ? err.message : String(err)
    });
    context = null;
  }

  return {
    type:
      rawFeedback.type === 'thumbUp' || rawFeedback.type === 'thumbDown'
        ? rawFeedback.type
        : null,
    comment:
      typeof rawFeedback.comment === 'string' ? rawFeedback.comment : null,
    devShare: rawFeedback.devShare === true,
    timestamp:
      typeof rawFeedback.timestamp === 'number' ? rawFeedback.timestamp : null,
    context
  };
}

// Store feedback (thumbUp/thumbDown + optional comment) on an existing message.
// If devShare is false, the call should not reach this endpoint - frontend handles locally only.
app.post('/api/messages/:id/feedback', async (req, res) => {
  try {
    const messageId = String(req.params?.id || '').trim();
    if (!messageId) {
      return res.status(400).json({ error: 'Missing messageId' });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const type = req.body.type;
    if (type !== 'thumbUp' && type !== 'thumbDown') {
      return res
        .status(400)
        .json({ error: 'type must be thumbUp or thumbDown' });
    }

    const rawComment =
      typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
    const comment = rawComment.slice(0, 1000); // Bound comment length
    const devShare = req.body.devShare === true;
    if (!devShare) {
      return res.status(400).json({ error: 'devShare must be true' });
    }
    const mailsEnabled = req.body?.mailsEnabled !== false;
    const adminUiActive = req.body?.adminUiActive === true;
    const userId =
      typeof req.body.userId === 'string' ? req.body.userId.trim() : '';
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    if (!/^u_[A-Za-z0-9_\-]{6,120}$/.test(userId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const session = await getUserSession(req);
    if (session && String(session.userId || '').trim() !== userId) {
      return res.status(403).json({ error: 'Feedback ownership mismatch' });
    }

    const feedbackContext = sanitizeFeedbackContext(req.body.feedbackContext);

    const messageSnap = await messagesRef.child(messageId).once('value');
    if (!messageSnap.exists()) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const messageData = messageSnap.val();
    // Allow feedback on both user and assistant messages, but only if conversationId present
    if (!messageData || typeof messageData.conversationId !== 'string') {
      return res.status(400).json({ error: 'Message has no conversationId' });
    }

    if (String(messageData.userId || '').trim() !== userId) {
      return res.status(403).json({ error: 'Feedback ownership mismatch' });
    }

    const conversationSnap = await db
      .ref('conversations')
      .child(String(messageData.conversationId || '').trim())
      .once('value');
    const conversationData = conversationSnap.val();
    if (!conversationData || typeof conversationData !== 'object') {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (String(conversationData.userId || '').trim() !== userId) {
      return res.status(403).json({ error: 'Feedback ownership mismatch' });
    }

    const feedback = {
      type,
      comment: comment || null,
      devShare,
      userId: userId || null,
      timestamp: Date.now(),
      context: feedbackContext
    };

    await messagesRef.child(messageId).update({ feedback });

    const effectiveMailsEnabled =
      mailsEnabled !== false &&
      (adminMailsCacheReady ? getCachedAdminMailsEnabled() : false);
    const suppressAdminMailAlert = await shouldSuppressAdminEmailAlertForUser(
      req,
      userId
    );

    if (
      emailNotifier.enabled &&
      effectiveMailsEnabled &&
      adminVisitedSinceLastAlert &&
      adminUiActive !== true &&
      !suppressAdminMailAlert
    ) {
      adminVisitedSinceLastAlert = false;
      emailNotifier.sendNewMessageAlert();
    }

    console.log('[FEEDBACK]', {
      messageId,
      type,
      devShare,
      userId: userId || 'anon'
    });
    return res.json({ success: true, messageId, feedback });
  } catch (err) {
    console.error('Erreur /api/messages/:id/feedback:', err.message);
    return res.status(500).json({ error: 'Feedback failed' });
  }
});

// Create a non-private snapshot branch containing only the target user+bot pair,
// then attach feedback to the bot message in that snapshot.
// Used when the source conversation is private and the user wants to share feedback.
app.post('/api/branches/feedback-snapshot', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const type = req.body.type;
    if (type !== 'thumbUp' && type !== 'thumbDown') {
      return res
        .status(400)
        .json({ error: 'type must be thumbUp or thumbDown' });
    }

    const rawComment =
      typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
    const comment = rawComment.slice(0, 1000);
    const devShare = req.body.devShare === true;
    if (!devShare) {
      return res.status(400).json({ error: 'devShare must be true' });
    }
    const mailsEnabled = req.body?.mailsEnabled !== false;
    const adminUiActive = req.body?.adminUiActive === true;
    const userId =
      typeof req.body.userId === 'string' ? req.body.userId.trim() : '';
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    if (!/^u_[A-Za-z0-9_\-]{6,120}$/.test(userId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const session = await getUserSession(req);
    if (session && String(session.userId || '').trim() !== userId) {
      return res.status(403).json({ error: 'Feedback ownership mismatch' });
    }

    const feedbackContext = sanitizeFeedbackContext(req.body.feedbackContext);

    // The frontend sends the raw user + bot message content when from a private conversation
    const userContent =
      typeof req.body.userContent === 'string'
        ? req.body.userContent.trim()
        : '';
    const botContent =
      typeof req.body.botContent === 'string' ? req.body.botContent.trim() : '';

    const safeUserContent = userContent.slice(0, 8000);
    const safeBotContent = botContent.slice(0, 8000);

    if (!safeUserContent || !safeBotContent) {
      return res
        .status(400)
        .json({ error: 'Missing userContent or botContent' });
    }

    const now = new Date().toISOString();
    const snapshotConversationId =
      'c_fbsnap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // Create a non-private conversation to hold the snapshot
    await db
      .ref('conversations')
      .child(snapshotConversationId)
      .set({
        userId: userId || 'u_anon',
        createdAt: now,
        updatedAt: now,
        title: 'Partage feedback',
        titleLocked: true,
        messageCount: 2,
        feedbackSnapshot: true,
        isPrivate: false,
        memory:
          feedbackContext && typeof feedbackContext.memory === 'string'
            ? feedbackContext.memory
            : '',
        flags:
          feedbackContext &&
          feedbackContext.flags &&
          typeof feedbackContext.flags === 'object'
            ? normalizeSessionFlags(feedbackContext.flags)
            : normalizeSessionFlags({})
      });

    // Push user message then bot message
    const timestampBase = Date.now();
    const userMsgRef = await messagesRef.push({
      role: 'user',
      content: safeUserContent,
      timestamp: timestampBase,
      userId: userId || 'u_anon',
      conversationId: snapshotConversationId,
      feedbackSnapshot: true
    });

    const botMsgRef = await messagesRef.push({
      role: 'assistant',
      content: safeBotContent,
      timestamp: timestampBase + 1,
      userId: userId || 'u_anon',
      conversationId: snapshotConversationId,
      feedbackSnapshot: true,
      debug:
        feedbackContext && Array.isArray(feedbackContext.botDebug)
          ? feedbackContext.botDebug
          : [],
      debugMeta:
        feedbackContext &&
        feedbackContext.botDebugMeta &&
        typeof feedbackContext.botDebugMeta === 'object'
          ? feedbackContext.botDebugMeta
          : null,
      stateSnapshot:
        feedbackContext &&
        feedbackContext.botStateSnapshot &&
        typeof feedbackContext.botStateSnapshot === 'object'
          ? feedbackContext.botStateSnapshot
          : null,
      feedback: {
        type,
        comment: comment || null,
        devShare,
        userId: userId || null,
        timestamp: Date.now(),
        context: feedbackContext
      }
    });

    const effectiveMailsEnabled =
      mailsEnabled !== false &&
      (adminMailsCacheReady ? getCachedAdminMailsEnabled() : false);
    const suppressAdminMailAlert = await shouldSuppressAdminEmailAlertForUser(
      req,
      userId
    );

    if (
      emailNotifier.enabled &&
      effectiveMailsEnabled &&
      adminVisitedSinceLastAlert &&
      adminUiActive !== true &&
      !suppressAdminMailAlert
    ) {
      adminVisitedSinceLastAlert = false;
      emailNotifier.sendNewMessageAlert();
    }

    console.log('[FEEDBACK_SNAPSHOT]', {
      snapshotConversationId,
      type,
      devShare,
      userId: userId || 'anon'
    });

    return res.status(201).json({
      success: true,
      snapshotConversationId,
      userMessageId: userMsgRef.key,
      botMessageId: botMsgRef.key
    });
  } catch (err) {
    console.error('Erreur /api/branches/feedback-snapshot:', err.message);
    return res.status(500).json({ error: 'Feedback snapshot failed' });
  }
});

app.post('/api/branches/:id/activate', async (req, res) => {
  try {
    const branchId = String(req.params?.id || '').trim();
    const actorUserId = await resolveBranchActorUserId(req);

    if (
      req.body !== undefined &&
      (typeof req.body !== 'object' ||
        req.body === null ||
        Array.isArray(req.body))
    ) {
      return res
        .status(400)
        .json({ error: 'Invalid branch activation payload' });
    }

    if (
      req.body?.flags !== undefined &&
      (typeof req.body.flags !== 'object' ||
        req.body.flags === null ||
        Array.isArray(req.body.flags))
    ) {
      return res.status(400).json({ error: 'Invalid branch flags payload' });
    }

    if (req.body?.userId !== undefined && typeof req.body.userId !== 'string') {
      return res.status(400).json({ error: 'Invalid branch user id payload' });
    }

    if (!branchId || !actorUserId) {
      return res.status(400).json({ error: 'Invalid branch id' });
    }

    const requestedBranchMemory =
      typeof req.body?.memory === 'string' && req.body.memory.trim()
        ? normalizeMemory(req.body.memory, buildDefaultPromptRegistry())
        : '';
    const requestedBranchFlags =
      req.body?.flags !== undefined
        ? normalizeSessionFlags(req.body.flags)
        : null;

    const branchRef = branchRecordsRef.child(branchId);
    const [branchSnap, seedSnap] = await Promise.all([
      branchRef.once('value'),
      branchSeedSnapshotsRef.child(branchId).once('value')
    ]);

    const branch = branchSnap.val();
    const seed = seedSnap.val();

    if (!branch || typeof branch !== 'object') {
      return res.status(404).json({ error: 'Branch not found' });
    }

    if (String(branch.userId || '') !== actorUserId) {
      return res.status(403).json({ error: 'Branch ownership mismatch' });
    }

    let seedMessages =
      seed && typeof seed === 'object' && Array.isArray(seed.messages)
        ? seed.messages
        : null;

    if (!Array.isArray(seedMessages)) {
      seedMessages = [];
      await branchSeedSnapshotsRef.child(branchId).set({
        sourceConversationId: String(branch.sourceConversationId || ''),
        sourceAnchorMessageId: String(branch.sourceAnchorMessageId || ''),
        seededAt: new Date().toISOString(),
        messages: seedMessages
      });
    }

    const branchConversationId = String(
      branch.branchConversationId || ''
    ).trim();
    if (!branchConversationId) {
      return res.status(500).json({ error: 'Missing branch conversation id' });
    }

    const convRef = db.ref('conversations').child(branchConversationId);
    const existingConvSnap = await convRef.once('value');
    const existingConversation = existingConvSnap.val();

    if (!existingConversation || typeof existingConversation !== 'object') {
      let sourceConversationTitle = '';
      const sourceConversationId = String(
        branch.sourceConversationId || ''
      ).trim();

      if (sourceConversationId) {
        const sourceConvSnap = await db
          .ref('conversations')
          .child(sourceConversationId)
          .once('value');
        const sourceConversation = sourceConvSnap.val();
        if (sourceConversation && typeof sourceConversation === 'object') {
          sourceConversationTitle = String(
            sourceConversation.title || ''
          ).trim();
        }
      }

      const lastUserMessage = [...seedMessages]
        .reverse()
        .find((m) => String(m?.role || '') === 'user');
      const now = new Date().toISOString();

      await convRef.set({
        userId: actorUserId,
        isBranch: true,
        sourceConversationId: String(branch.sourceConversationId || ''),
        createdAt: now,
        updatedAt: now,
        title:
          sourceConversationTitle ||
          `Branche de ${String(branch.sourceConversationId || 'conversation')}`,
        titleLocked: false,
        messageCount: seedMessages.filter(
          (m) => String(m?.role || '') === 'user'
        ).length,
        lastUserMessage: lastUserMessage
          ? String(lastUserMessage.content || '')
          : '',
        memory: requestedBranchMemory,
        flags: requestedBranchFlags || normalizeSessionFlags({})
      });

      // Seed all historical messages into the new conversation once.
      await Promise.all(
        seedMessages.map((message, index) => {
          const timestampBase = Date.now();
          return messagesRef.push({
            role: String(message?.role || ''),
            content: String(message?.content || ''),
            timestamp: timestampBase + index,
            userId: actorUserId,
            conversationId: branchConversationId,
            debug: Array.isArray(message?.debug) ? message.debug : [],
            debugMeta:
              message?.debugMeta && typeof message.debugMeta === 'object'
                ? message.debugMeta
                : null,
            branchId,
            sourceMessageId: typeof message?.id === 'string' ? message.id : null
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
      status: 'active',
      activatedAt,
      updatedAt: activatedAt
    });

    return res.json({
      success: true,
      branch: {
        id: branchId,
        branchConversationId,
        activatedAt,
        status: 'active'
      },
      memory: requestedBranchMemory,
      flags: requestedBranchFlags !== null ? requestedBranchFlags : undefined
    });
  } catch (err) {
    console.error('Erreur /api/branches/:id/activate:', err.message);
    return res.status(500).json({ error: 'Branch activation failed' });
  }
});

// Fetch a single branch record + seed messages (for cross-device resume).
app.get('/api/branches/:id', async (req, res) => {
  try {
    const branchId = String(req.params?.id || '').trim();
    const actorUserId = await resolveBranchActorUserId(req);

    if (!branchId || !actorUserId) {
      return res.status(400).json({ error: 'Invalid branch id' });
    }

    const [branchSnap, seedSnap] = await Promise.all([
      branchRecordsRef.child(branchId).once('value'),
      branchSeedSnapshotsRef.child(branchId).once('value')
    ]);

    const branch = branchSnap.val();
    const seed = seedSnap.val();

    if (!branch || typeof branch !== 'object') {
      return res.status(404).json({ error: 'Branch not found' });
    }

    if (String(branch.userId || '') !== actorUserId) {
      return res.status(403).json({ error: 'Branch ownership mismatch' });
    }

    const safeSeedMessages = Array.isArray(seed?.messages)
      ? seed.messages.map((m) => ({
          role: String(m?.role || ''),
          content: String(m?.content || ''),
          debug: Array.isArray(m?.debug) ? m.debug : [],
          debugMeta:
            m?.debugMeta && typeof m.debugMeta === 'object'
              ? m.debugMeta
              : null,
          createdAt: typeof m?.createdAt === 'string' ? m.createdAt : null
        }))
      : [];

    return res.json({
      branch: {
        id: branchId,
        sourceConversationId: String(branch.sourceConversationId || ''),
        sourceAnchorMessageId: String(branch.sourceAnchorMessageId || ''),
        branchConversationId: String(branch.branchConversationId || ''),
        seedMessageCount: Number(branch.seedMessageCount) || 0,
        status: String(branch.status || 'active'),
        createdAt:
          typeof branch.createdAt === 'string' ? branch.createdAt : null,
        activatedAt:
          typeof branch.activatedAt === 'string' ? branch.activatedAt : null
      },
      messages: safeSeedMessages
    });
  } catch (err) {
    console.error('Erreur GET /api/branches/:id:', err.message);
    return res.status(500).json({ error: 'Branch lookup failed' });
  }
});

// Intersession memory endpoints.
// GET returns the stored long-term memory for the authenticated user.
app.get('/api/intersession-memory', requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;
    const snap = await usersRef.child(session.userId).once('value');
    const userData = snap.val() || {};
    const memorySource = normalizeIntersessionSourceFromUserData(
      userData,
      buildDefaultPromptRegistry()
    );
    const storedCompact =
      typeof userData.intersessionMemoryCompact === 'string'
        ? userData.intersessionMemoryCompact.trim()
        : '';
    const memoryCompact =
      storedCompact || buildIntersessionCompactRuntime(memorySource).trim();
    const historyRaw = Array.isArray(userData.intersessionMemoryHistory)
      ? userData.intersessionMemoryHistory
      : [];
    return res.json({
      memory: memorySource || null,
      memorySource: memorySource || null,
      memoryCompact: memoryCompact || null,
      intersessionMemoryUpdatedAt:
        typeof userData.intersessionMemoryUpdatedAt === 'string'
          ? userData.intersessionMemoryUpdatedAt
          : null,
      intersessionMemoryHistory: historyRaw.slice(0, 3).map((entry) => ({
        memory:
          typeof entry?.memorySource === 'string'
            ? entry.memorySource
            : typeof entry?.memory === 'string'
              ? entry.memory
              : '',
        memorySource:
          typeof entry?.memorySource === 'string'
            ? entry.memorySource
            : typeof entry?.memory === 'string'
              ? entry.memory
              : '',
        memoryCompact:
          typeof entry?.memoryCompact === 'string'
            ? entry.memoryCompact
            : buildIntersessionCompactRuntime(
                typeof entry?.memorySource === 'string'
                  ? entry.memorySource
                  : typeof entry?.memory === 'string'
                    ? entry.memory
                    : ''
              ),
        savedAt: typeof entry?.savedAt === 'string' ? entry.savedAt : null
      }))
    });
  } catch (err) {
    console.error('Erreur GET /api/intersession-memory:', err.message);
    return res.status(500).json({ error: 'Intersession memory read failed' });
  }
});

// Deterministic strip of transient session memory blocks before intersession consolidation.
// Removes transient movement sections while preserving stable context.
function stripTransientMemoryBlocksForIntersession(memoryText) {
  const lines = String(memoryText || '').split('\n');
  const result = [];
  let inTransientBlock = false;

  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (
      /^mouvements en cours\s*:/.test(trimmed) ||
      /^anciens mouvements\s*:/.test(trimmed)
    ) {
      inTransientBlock = true;
      result.push(line); // Keep the header
      result.push('-'); // Replace content with empty marker
      continue;
    }
    // Any new section header exits the transient block
    if (
      line.trim() &&
      !line.trim().startsWith('-') &&
      /^[A-Za-z\u00C0-\u017E].*:/.test(line.trim())
    ) {
      inTransientBlock = false;
    }
    if (!inTransientBlock) {
      result.push(line);
    }
  }
  return result.join('\n').trim();
}

// For intersession consolidation, prefer the server-side conversation memory when available.
// This avoids re-feeding long-term memory from stale localStorage snapshots.
async function resolveAuthoritativeSessionMemoryForIntersession({
  userId,
  conversationId,
  fallbackMemory
}) {
  const fallback = String(fallbackMemory || '').slice(0, 8000);
  const safeConversationId =
    typeof conversationId === 'string' ? conversationId.trim() : '';

  if (!safeConversationId || !userId) {
    return fallback;
  }

  try {
    const convSnap = await db
      .ref('conversations')
      .child(safeConversationId)
      .once('value');
    const convData = convSnap.val() || {};
    const ownerUserId = String(convData.userId || '');
    const isPrivate = convData.isPrivate === true;
    const conversationMemory =
      typeof convData.memory === 'string' ? convData.memory.trim() : '';

    if (ownerUserId === String(userId) && !isPrivate && conversationMemory) {
      return conversationMemory.slice(0, 8000);
    }
  } catch {
    // Best-effort fallback: keep request payload memory when conversation lookup fails.
  }

  return fallback;
}

// PUT saves the long-term memory for the authenticated user.
app.put('/api/intersession-memory', requireUserAuth, async (req, res) => {
  try {
    const session = req.userSession;

    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Invalid memory payload' });
    }

    const requestedConversationId =
      typeof req.body.conversationId === 'string'
        ? req.body.conversationId.trim()
        : '';
    const hasMemoryFallback =
      typeof req.body.memory === 'string' && req.body.memory.trim();
    if (!requestedConversationId && !hasMemoryFallback) {
      return res
        .status(400)
        .json({ error: 'Missing conversationId or memory' });
    }

    const sessionMemory =
      await resolveAuthoritativeSessionMemoryForIntersession({
        userId: session.userId,
        conversationId: requestedConversationId,
        fallbackMemory: String(req.body.memory || '')
      });

    if (!sessionMemory.trim()) {
      return res.json({
        success: true,
        skipped: true,
        reason: 'empty_session_memory'
      });
    }

    const strippedSessionMemory =
      stripTransientMemoryBlocksForIntersession(sessionMemory);
    const userSnap = await usersRef.child(session.userId).once('value');
    const userData = userSnap.val() || {};

    // Direct manual edit from account is authoritative until /chat consumes it.
    // Ignore background/session consolidation attempts while this lock is active.
    if (userData.intersessionRefreshForced === true) {
      return res.json({
        success: true,
        skipped: true,
        reason: 'manual_edit_lock'
      });
    }

    const previousIntersessionSource = normalizeIntersessionSourceFromUserData(
      userData,
      buildDefaultPromptRegistry()
    );
    const memorySource = await updateIntersessionMemory(
      previousIntersessionSource,
      strippedSessionMemory,
      buildDefaultPromptRegistry()
    );

    await usersRef.child(session.userId).update({
      intersessionMemorySource: memorySource,
      intersessionMemoryUpdatedAt: new Date().toISOString(),
      intersessionCompactOutdated: true
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Erreur PUT /api/intersession-memory:', err.message);
    if (
      err &&
      (err.code === 'insufficient_quota' || err.type === 'insufficient_quota')
    ) {
      return res.status(503).json({
        error: 'OpenAI quota exhausted',
        code: 'insufficient_quota',
        status: 'service_unavailable',
        serviceUnavailable: true,
        serviceUnavailableReason: 'quota_exhausted',
        userMessage:
          "Le service est temporairement indisponible car le quota API est épuisé. Aucun nouveau message ne peut être traité tant que ce quota n'est pas rétabli. Recharge la page après rétablissement du quota."
      });
    }
    return res.status(500).json({ error: 'Intersession memory save failed' });
  }
});

// PATCH saves intersession memory directly (no LLM), archives current version, forces refresh.
app.patch(
  '/api/intersession-memory/direct',
  requireUserAuth,
  async (req, res) => {
    try {
      const session = req.userSession;
      if (
        !req.body ||
        typeof req.body !== 'object' ||
        typeof req.body.memory !== 'string'
      ) {
        return res.status(400).json({ error: 'Invalid payload' });
      }

      const newSourceMemory = String(req.body.memory || '').slice(0, 6000);
      const now = new Date().toISOString();

      // Archive current version before overwriting
      const snap = await usersRef.child(session.userId).once('value');
      const userData = snap.val() || {};
      const currentMemorySource = normalizeIntersessionSourceFromUserData(
        userData,
        buildDefaultPromptRegistry()
      );
      const currentMemoryCompact =
        typeof userData.intersessionMemoryCompact === 'string'
          ? userData.intersessionMemoryCompact
          : buildIntersessionCompactRuntime(currentMemorySource);
      const currentUpdatedAt = userData.intersessionMemoryUpdatedAt;
      const currentHistory = Array.isArray(userData.intersessionMemoryHistory)
        ? userData.intersessionMemoryHistory
        : [];

      if (
        typeof currentMemorySource === 'string' &&
        currentMemorySource.trim()
      ) {
        const newEntry = {
          memorySource: currentMemorySource,
          memoryCompact: currentMemoryCompact,
          savedAt: currentUpdatedAt || now
        };
        const updatedHistory = [newEntry, ...currentHistory].slice(0, 3);
        await usersRef
          .child(session.userId)
          .child('intersessionMemoryHistory')
          .set(updatedHistory);
      }

      const nextMemorySource = newSourceMemory.trim();

      await usersRef.child(session.userId).update({
        intersessionMemorySource: nextMemorySource,
        intersessionMemoryUpdatedAt: now,
        intersessionRefreshForced: true,
        intersessionCompactOutdated: true
      });

      return res.json({ success: true });
    } catch (err) {
      console.error(
        'Erreur PATCH /api/intersession-memory/direct:',
        err.message
      );
      return res
        .status(500)
        .json({ error: 'Intersession memory direct save failed' });
    }
  }
);

// POST beacon - called by sendBeacon on pagehide / visibilitychange.
// Responds 200 immediately; consolidation runs async in the background.
// Race-condition guard: ignored if the beacon's timestamp is older than the
// intersessionMemoryUpdatedAt already stored (e.g. explicit close arrived first).
app.post('/api/session/beacon', async (req, res) => {
  // Respond immediately - sendBeacon ignores the body anyway.
  res.status(200).json({ ok: true });

  try {
    const session = await getUserSession(req);
    if (!session) return; // unauthenticated - ignore silently

    const requestedConversationId =
      typeof req.body?.conversationId === 'string'
        ? req.body.conversationId.trim()
        : '';
    const memory = await resolveAuthoritativeSessionMemoryForIntersession({
      userId: session.userId,
      conversationId: requestedConversationId,
      fallbackMemory:
        typeof req.body?.memory === 'string' ? req.body.memory : ''
    });
    const beaconTimestamp =
      typeof req.body?.timestamp === 'string' ? req.body.timestamp : null;

    if (!memory.trim()) return;

    const now = new Date().toISOString();

    // Update lastActiveAt unconditionally - lightweight, no LLM.
    await usersRef.child(session.userId).update({ lastActiveAt: now });

    // Race-condition guard: skip consolidation if a more recent update already exists.
    const snap = await usersRef.child(session.userId).once('value');
    const userData = snap.val() || {};
    const storedUpdatedAt = userData.intersessionMemoryUpdatedAt;

    // Direct manual edit from account is authoritative until /chat consumes it.
    if (userData.intersessionRefreshForced === true) {
      return;
    }

    if (
      beaconTimestamp &&
      storedUpdatedAt &&
      new Date(storedUpdatedAt) > new Date(beaconTimestamp)
    ) {
      // A more recent consolidation (explicit close) already happened - skip.
      return;
    }

    const strippedMemory = stripTransientMemoryBlocksForIntersession(memory);
    const previousIntersessionMemory = normalizeIntersessionSourceFromUserData(
      userData,
      buildDefaultPromptRegistry()
    );

    const consolidated = await updateIntersessionMemory(
      previousIntersessionMemory,
      strippedMemory,
      buildDefaultPromptRegistry()
    );

    await usersRef.child(session.userId).update({
      intersessionMemorySource: consolidated,
      intersessionMemoryUpdatedAt: now,
      intersessionCompactOutdated: true
    });
  } catch (err) {
    // Background processing - errors are non-critical, log and continue.
    console.error('Erreur /api/session/beacon (background):', err.message);
  }
});

// Admin route to set or remove a human-readable label for a user.
app.post('/api/admin/user-label', requireAdminAuth, async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      typeof req.body.userId !== 'string' ||
      (req.body.label !== undefined && typeof req.body.label !== 'string')
    ) {
      return res.status(400).json({ error: 'Invalid user label request' });
    }

    const userId = req.body.userId.trim();
    const label =
      typeof req.body.label === 'string' ? req.body.label.trim() : '';

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    if (!label) {
      await userLabelsRef.child(userId).remove();
      return res.json({ success: true, removed: true });
    }

    await userLabelsRef.child(userId).set(label);

    return res.json({ success: true });
  } catch (err) {
    console.error('Erreur user-label:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
  try {
    const snapshot = await usersRef.once('value');
    const raw = snapshot.val() || {};

    const users = Object.entries(raw)
      .map(([id, user]) => {
        const safeUser = user && typeof user === 'object' ? user : {};
        return {
          id,
          email: normalizeEmail(safeUser.email || ''),
          createdAt:
            typeof safeUser.createdAt === 'string' ? safeUser.createdAt : null,
          updatedAt:
            typeof safeUser.updatedAt === 'string' ? safeUser.updatedAt : null
        };
      })
      .sort((a, b) =>
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      );

    return res.json({ users });
  } catch (err) {
    console.error('Erreur /api/admin/users:', err.message);
    return res.status(500).json({ error: 'Users lookup failed' });
  }
});

app.get('/api/admin/support-cases', requireAdminAuth, async (req, res) => {
  try {
    const emailFilter = String(req.query?.email || '')
      .trim()
      .toLowerCase();

    const [usersSnap, conversationsSnap] = await Promise.all([
      usersRef.once('value'),
      db.ref('conversations').once('value')
    ]);

    const usersRaw = usersSnap.val() || {};
    const conversationsRaw = conversationsSnap.val() || {};

    const latestActivityByUserId = new Map();
    const conversationCountByUserId = new Map();

    for (const [, value] of Object.entries(conversationsRaw)) {
      const safeConversation = value && typeof value === 'object' ? value : {};
      if (safeConversation.isBranch === true) continue;

      const userId = String(safeConversation.userId || '').trim();
      if (!userId) continue;

      const updatedAtMs = Date.parse(
        String(safeConversation.updatedAt || safeConversation.createdAt || '')
      );
      const safeUpdatedAtMs = Number.isFinite(updatedAtMs) ? updatedAtMs : 0;

      const previousLast = Number(latestActivityByUserId.get(userId) || 0);
      if (safeUpdatedAtMs > previousLast) {
        latestActivityByUserId.set(userId, safeUpdatedAtMs);
      }

      conversationCountByUserId.set(
        userId,
        Number(conversationCountByUserId.get(userId) || 0) + 1
      );
    }

    const casesBySuperId = new Map();

    for (const [userId, userValue] of Object.entries(usersRaw)) {
      const safeUserId = String(userId || '').trim();
      if (!safeUserId) continue;

      const safeUser =
        userValue && typeof userValue === 'object' ? userValue : {};
      const superId = resolveStableSuperId(safeUserId, safeUser);
      const email = normalizeEmail(safeUser.email || '');

      if (emailFilter && !email.toLowerCase().includes(emailFilter)) {
        continue;
      }

      const usageMeter = normalizeUsageMeter(safeUser.usageMeter);
      const usageEnvelope = resolveUsageEnvelopeForRead(safeUser.usageEnvelope);
      const usageMonthlyHistory = normalizeUsageMonthlyHistory(
        safeUser.usageMonthlyHistory
      );
      const userUpdatedAtMs = Date.parse(
        String(safeUser.updatedAt || safeUser.createdAt || '')
      );
      const safeUserUpdatedAtMs = Number.isFinite(userUpdatedAtMs)
        ? userUpdatedAtMs
        : 0;
      const conversationLastActivityMs = Number(
        latestActivityByUserId.get(safeUserId) || 0
      );
      const lastActivityMs = Math.max(
        safeUserUpdatedAtMs,
        conversationLastActivityMs
      );
      const conversationCount = Number(
        conversationCountByUserId.get(safeUserId) || 0
      );

      if (!casesBySuperId.has(superId)) {
        casesBySuperId.set(superId, {
          superId,
          activeUserId: safeUserId,
          activeUserCreatedAt:
            typeof safeUser.createdAt === 'string' ? safeUser.createdAt : null,
          createdAt:
            typeof safeUser.createdAt === 'string' ? safeUser.createdAt : null,
          updatedAt:
            typeof safeUser.updatedAt === 'string' ? safeUser.updatedAt : null,
          lastActivityAt:
            lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : null,
          emails: email ? [email] : [],
          totalTokens: usageMeter.totalTokens,
          totalSimulatedEur: usageMeter.totalSimulatedEur,
          conversationCount,
          usageEnvelope,
          usageMonthlyHistory,
          usageMeterUpdatedAt: usageMeter.updatedAt,
          members: [
            {
              userId: safeUserId,
              email: email || null,
              createdAt:
                typeof safeUser.createdAt === 'string'
                  ? safeUser.createdAt
                  : null,
              updatedAt:
                typeof safeUser.updatedAt === 'string'
                  ? safeUser.updatedAt
                  : null,
              conversationCount
            }
          ]
        });
        continue;
      }

      const existing = casesBySuperId.get(superId);
      if (email && !existing.emails.includes(email)) {
        existing.emails.push(email);
      }

      existing.totalTokens += usageMeter.totalTokens;
      existing.totalSimulatedEur += usageMeter.totalSimulatedEur;
      existing.conversationCount += conversationCount;
      existing.members.push({
        userId: safeUserId,
        email: email || null,
        createdAt:
          typeof safeUser.createdAt === 'string' ? safeUser.createdAt : null,
        updatedAt:
          typeof safeUser.updatedAt === 'string' ? safeUser.updatedAt : null,
        conversationCount
      });

      const existingLastActivityMs = Date.parse(
        String(existing.lastActivityAt || '')
      );
      const safeExistingLastActivityMs = Number.isFinite(existingLastActivityMs)
        ? existingLastActivityMs
        : 0;
      if (lastActivityMs > safeExistingLastActivityMs) {
        existing.lastActivityAt = new Date(lastActivityMs).toISOString();
        existing.activeUserId = safeUserId;
        existing.activeUserCreatedAt =
          typeof safeUser.createdAt === 'string' ? safeUser.createdAt : null;
        existing.usageEnvelope = usageEnvelope;
        existing.usageMonthlyHistory = usageMonthlyHistory;
        existing.usageMeterUpdatedAt = usageMeter.updatedAt;
      }
    }

    const cases = Array.from(casesBySuperId.values())
      .map((item) => ({
        ...item,
        emails: item.emails.sort((a, b) => a.localeCompare(b))
      }))
      .sort((a, b) => {
        const aMs = Date.parse(String(a.lastActivityAt || ''));
        const bMs = Date.parse(String(b.lastActivityAt || ''));
        const safeAMs = Number.isFinite(aMs) ? aMs : 0;
        const safeBMs = Number.isFinite(bMs) ? bMs : 0;
        return safeBMs - safeAMs;
      });

    return res.json({
      cases,
      count: cases.length
    });
  } catch (err) {
    console.error('Erreur /api/admin/support-cases:', err.message);
    return res.status(500).json({ error: 'Support cases lookup failed' });
  }
});

// Route to manually set the title of a conversation and lock it.
app.post('/api/conversations/:id/title', async (req, res) => {
  try {
    if (
      !req.params ||
      typeof req.params.id !== 'string' ||
      !req.params.id.trim()
    ) {
      return res.status(400).json({ error: 'Conversation invalide' });
    }

    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      typeof req.body.title !== 'string'
    ) {
      return res
        .status(400)
        .json({ error: 'Invalid conversation title request' });
    }

    const conversationId = req.params.id;
    const title = req.body.title.trim();

    if (!title) {
      return res.status(400).json({ error: 'Titre vide' });
    }

    const convRef = db.ref('conversations').child(conversationId);

    await convRef.update({
      title,
      titleLocked: true
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Erreur update title:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Return the title and metadata for a given conversation.
app.get('/api/conversations/:id/title', async (req, res) => {
  try {
    if (
      !req.params ||
      typeof req.params.id !== 'string' ||
      !req.params.id.trim()
    ) {
      return res.status(400).json({ error: 'Conversation invalide' });
    }

    const conversationId = req.params.id;
    const snapshot = await db
      .ref('conversations')
      .child(conversationId)
      .once('value');
    const data = snapshot.val() || null;

    if (!data) {
      return res.status(404).json({ error: 'Conversation introuvable' });
    }

    return res.json({
      id: conversationId,
      title: data.title || null,
      titleLocked: data.titleLocked === true,
      updatedAt: data.updatedAt || data.createdAt || null
    });
  } catch (err) {
    console.error('Erreur get conversation title:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin route to read the intersession memory (non-compressed) of a specific user.
app.get(
  '/api/admin/intersession-memory/:userId',
  requireAdminAuth,
  async (req, res) => {
    try {
      const userId = String(req.params.userId || '').trim();
      if (!userId) return res.status(400).json({ error: 'userId requis' });
      const snap = await usersRef.child(userId).once('value');
      const userData = snap.val() || {};
      const memorySource = normalizeIntersessionSourceFromUserData(
        userData,
        buildDefaultPromptRegistry()
      );
      const storedCompact =
        typeof userData.intersessionMemoryCompact === 'string'
          ? userData.intersessionMemoryCompact.trim()
          : '';
      const memoryCompact =
        storedCompact || buildIntersessionCompactRuntime(memorySource).trim();
      return res.json({
        memory: memorySource,
        memorySource,
        memoryCompact
      });
    } catch (err) {
      console.error(
        'Erreur GET /api/admin/intersession-memory/:userId:',
        err.message
      );
      return res
        .status(500)
        .json({ error: 'Lecture mémoire inter-sessions échouée' });
    }
  }
);

// Admin route to list all conversations with optional user labels.
app.get('/api/admin/conversations', requireAdminAuth, async (req, res) => {
  try {
    const [convSnap, labelsSnap, usersSnap] = await Promise.all([
      db.ref('conversations').once('value'),
      userLabelsRef.once('value'),
      usersRef.once('value')
    ]);

    const data = convSnap.val() || {};
    const labels = labelsSnap.val() || {};
    const users = usersSnap.val() || {};

    const conversations = Object.entries(data)
      .filter(([, value]) => value?.isBranch !== true)
      .map(([id, value]) => {
        const rawUserId = value.userId || null;
        const label = rawUserId && labels[rawUserId] ? labels[rawUserId] : null;
        const userEmail =
          rawUserId && users[rawUserId]
            ? normalizeEmail(users[rawUserId].email)
            : null;

        return {
          id,
          userId: rawUserId,
          userEmail,
          userLabel: label,
          displayUser: label || rawUserId,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt || value.createdAt,
          displayTitle:
            value.title ||
            (value.lastUserMessage
              ? value.lastUserMessage.slice(0, 40)
              : '(sans titre)'),
          messageCount: value.messageCount || 0
        };
      });

    conversations.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    res.json(conversations);
  } catch (err) {
    console.error('Erreur conversations admin:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.patch(
  '/api/admin/conversations/:id/title',
  requireAdminAuth,
  async (req, res) => {
    try {
      if (
        !req.params ||
        typeof req.params.id !== 'string' ||
        !req.params.id.trim()
      ) {
        return res.status(400).json({ error: 'Conversation invalide' });
      }

      if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body) ||
        (req.body.title !== null && typeof req.body.title !== 'string')
      ) {
        return res
          .status(400)
          .json({ error: 'Invalid conversation title request' });
      }

      const conversationId = String(req.params.id || '').trim();
      const convRef = db.ref('conversations').child(conversationId);
      const convSnap = await convRef.once('value');
      const existing = convSnap.val();

      if (!existing || typeof existing !== 'object') {
        return res.status(404).json({ error: 'Conversation introuvable' });
      }

      const normalizedTitle =
        typeof req.body.title === 'string'
          ? req.body.title.trim().slice(0, 60)
          : '';
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
      console.error(
        'Erreur PATCH /api/admin/conversations/:id/title:',
        err.message
      );
      return res.status(500).json({ error: 'Conversation update failed' });
    }
  }
);

app.delete(
  '/api/admin/conversations/:id',
  requireAdminAuth,
  async (req, res) => {
    try {
      if (
        !req.params ||
        typeof req.params.id !== 'string' ||
        !req.params.id.trim()
      ) {
        return res.status(400).json({ error: 'Conversation invalide' });
      }

      const conversationId = String(req.params.id || '').trim();
      const convRef = db.ref('conversations').child(conversationId);
      const convSnap = await convRef.once('value');
      const existing = convSnap.val();

      if (!existing || typeof existing !== 'object') {
        return res.status(404).json({ error: 'Conversation introuvable' });
      }

      const messagesSnap = await messagesRef
        .orderByChild('conversationId')
        .equalTo(conversationId)
        .once('value');

      const messageIds = Object.keys(messagesSnap.val() || {});

      const branchSnap = await branchRecordsRef.once('value');
      const branches = branchSnap.val() || {};
      const relatedBranchIds = Object.entries(branches)
        .filter(([, value]) => {
          const sourceConversationId = String(
            value?.sourceConversationId || ''
          ).trim();
          const branchConversationId = String(
            value?.branchConversationId || ''
          ).trim();
          return (
            sourceConversationId === conversationId ||
            branchConversationId === conversationId
          );
        })
        .map(([id]) => id);

      await Promise.all([
        convRef.remove(),
        ...messageIds.map((messageId) => messagesRef.child(messageId).remove()),
        ...relatedBranchIds.map((branchId) =>
          branchRecordsRef.child(branchId).remove()
        ),
        ...relatedBranchIds.map((branchId) =>
          branchSeedSnapshotsRef.child(branchId).remove()
        )
      ]);

      return res.json({
        success: true,
        deletedConversationId: conversationId,
        deletedMessageCount: messageIds.length,
        deletedBranchCount: relatedBranchIds.length
      });
    } catch (err) {
      console.error('Erreur DELETE /api/admin/conversations/:id:', err.message);
      return res.status(500).json({ error: 'Conversation delete failed' });
    }
  }
);

// Admin route to fetch all messages for a specific conversation.
app.get(
  '/api/admin/conversations/:id/messages',
  requireAdminAuth,
  async (req, res) => {
    try {
      if (
        !req.params ||
        typeof req.params.id !== 'string' ||
        !req.params.id.trim()
      ) {
        return res.status(400).json({ error: 'Conversation invalide' });
      }

      const conversationId = req.params.id;

      const [messagesSnap, labelsSnap] = await Promise.all([
        messagesRef
          .orderByChild('conversationId')
          .equalTo(conversationId)
          .once('value'),
        userLabelsRef.once('value')
      ]);

      const data = messagesSnap.val() || {};
      const labels = labelsSnap.val() || {};

      const list = Object.entries(data)
        .map(([id, value]) => {
          const rawUserId = value.userId || null;
          const label =
            rawUserId && labels[rawUserId] ? labels[rawUserId] : null;

          let normalizedFeedback = null;
          try {
            normalizedFeedback = normalizeFeedbackForRead(
              value.feedback && typeof value.feedback === 'object'
                ? value.feedback
                : null
            );
          } catch (err) {
            console.warn('[ADMIN_FEEDBACK_NORMALIZE_FAILED]', {
              conversationId,
              messageId: id,
              error: err && err.message ? err.message : String(err)
            });
            normalizedFeedback =
              value.feedback && typeof value.feedback === 'object'
                ? {
                    type:
                      value.feedback.type === 'thumbUp' ||
                      value.feedback.type === 'thumbDown'
                        ? value.feedback.type
                        : null,
                    comment:
                      typeof value.feedback.comment === 'string'
                        ? value.feedback.comment
                        : null,
                    devShare: value.feedback.devShare === true,
                    timestamp:
                      typeof value.feedback.timestamp === 'number'
                        ? value.feedback.timestamp
                        : null,
                    context: null
                  }
                : null;
          }

          return {
            id,
            ...value,
            feedback: normalizedFeedback,
            userLabel: label,
            displayUser: label || rawUserId
          };
        })
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      res.json(list);
    } catch (err) {
      console.error('Erreur messages conversation:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

app.post(
  '/api/admin/conversations/import-replay',
  requireAdminAuth,
  async (req, res) => {
    try {
      const safeConversation =
        req.body?.conversation &&
        typeof req.body.conversation === 'object' &&
        !Array.isArray(req.body.conversation)
          ? req.body.conversation
          : null;

      const conversationId = String(safeConversation?.id || '').trim();
      const userId =
        String(safeConversation?.userId || '').trim() || 'u_admin_replay';

      if (!conversationId) {
        return res.status(400).json({ error: 'Conversation invalide' });
      }

      const rawMessages = Array.isArray(safeConversation?.messages)
        ? safeConversation.messages
        : [];
      const sanitizedMessages = rawMessages
        .map((entry, index) => {
          const safeEntry =
            entry && typeof entry === 'object' && !Array.isArray(entry)
              ? entry
              : null;
          const role = String(safeEntry?.role || '').trim();
          const content =
            typeof safeEntry?.content === 'string' ? safeEntry.content : '';

          if ((role !== 'user' && role !== 'assistant') || !content.trim()) {
            return null;
          }

          const timestampCandidate = Number(
            safeEntry?.t || safeEntry?.timestamp || 0
          );
          const timestamp =
            Number.isFinite(timestampCandidate) && timestampCandidate > 0
              ? timestampCandidate
              : Date.now() + index;
          const debugMeta =
            safeEntry?.debugMeta &&
            typeof safeEntry.debugMeta === 'object' &&
            !Array.isArray(safeEntry.debugMeta)
              ? safeEntry.debugMeta
              : null;
          const stateSnapshot =
            safeEntry?.stateSnapshot &&
            typeof safeEntry.stateSnapshot === 'object' &&
            !Array.isArray(safeEntry.stateSnapshot)
              ? {
                  memory:
                    typeof safeEntry.stateSnapshot.memory === 'string'
                      ? normalizeMemory(
                          safeEntry.stateSnapshot.memory,
                          buildDefaultPromptRegistry()
                        )
                      : '',
                  flags: normalizeSessionFlags(
                    safeEntry.stateSnapshot.flags || {}
                  )
                }
              : null;

          return {
            role,
            content,
            timestamp,
            debug: Array.isArray(safeEntry?.debug) ? safeEntry.debug : [],
            debugMeta,
            stateSnapshot
          };
        })
        .filter(Boolean);

      if (sanitizedMessages.length === 0) {
        return res
          .status(400)
          .json({ error: 'Aucun message valide a importer' });
      }

      const convRef = db.ref('conversations').child(conversationId);
      const existingMsgsSnap = await messagesRef
        .orderByChild('conversationId')
        .equalTo(conversationId)
        .once('value');
      const deleteOps = [];
      existingMsgsSnap.forEach((child) => {
        deleteOps.push(child.ref.remove());
      });
      await Promise.all(deleteOps);

      const normalizedMemory = normalizeMemory(
        typeof safeConversation?.memory === 'string'
          ? safeConversation.memory
          : '',
        buildDefaultPromptRegistry()
      );
      const normalizedFlags = normalizeSessionFlags(
        safeConversation?.flags || {}
      );
      const rawTitle =
        typeof safeConversation?.title === 'string'
          ? safeConversation.title.trim()
          : '';
      const firstUserMessage = sanitizedMessages.find(
        (item) => item.role === 'user'
      );
      const lastUserMessage = [...sanitizedMessages]
        .reverse()
        .find((item) => item.role === 'user');
      const fallbackTitle =
        lastUserMessage?.content?.slice(0, 60) ||
        firstUserMessage?.content?.slice(0, 60) ||
        'Conversation sans titre';
      const updatedAtCandidate = Number(safeConversation?.updatedAt || 0);
      const updatedAtIso =
        Number.isFinite(updatedAtCandidate) && updatedAtCandidate > 0
          ? new Date(updatedAtCandidate).toISOString()
          : new Date().toISOString();

      await convRef.set({
        userId,
        title: rawTitle || fallbackTitle,
        titleLocked: false,
        messageCount: sanitizedMessages.filter((item) => item.role === 'user')
          .length,
        lastUserMessage: lastUserMessage?.content || '',
        memory: normalizedMemory,
        flags: normalizedFlags,
        adminReplaySourceConversationId:
          String(safeConversation?.sourceConversationId || '').trim() || null,
        adminReplayAnchorMessageId:
          String(safeConversation?.anchorMessageId || '').trim() || null,
        createdAt: updatedAtIso,
        updatedAt: updatedAtIso
      });

      const pushedMessageIds = [];
      for (const message of sanitizedMessages) {
        const pushRef = await messagesRef.push({
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
          userId,
          conversationId,
          debug: message.debug,
          debugMeta: message.debugMeta,
          stateSnapshot: message.stateSnapshot
        });
        pushedMessageIds.push(pushRef.key);
      }

      return res.json({
        success: true,
        conversationId,
        messageIds: pushedMessageIds
      });
    } catch (err) {
      console.error(
        'Erreur /api/admin/conversations/import-replay:',
        err.message
      );
      return res.status(500).json({ error: 'Admin replay import failed' });
    }
  }
);

app.get(
  '/api/admin/conversations/:id/branches',
  requireAdminAuth,
  async (req, res) => {
    try {
      if (
        !req.params ||
        typeof req.params.id !== 'string' ||
        !req.params.id.trim()
      ) {
        return res.status(400).json({ error: 'Conversation invalide' });
      }

      const currentConversationId = String(req.params.id || '').trim();
      const [convSnap, branchSnap] = await Promise.all([
        db.ref('conversations').once('value'),
        branchRecordsRef.once('value')
      ]);

      const conversationsRaw = convSnap.val() || {};
      const branchesRaw = branchSnap.val() || {};

      const branches = Object.entries(branchesRaw)
        .map(([id, item]) => ({
          id,
          sourceConversationId: String(item?.sourceConversationId || '').trim(),
          sourceAnchorMessageId: String(
            item?.sourceAnchorMessageId || ''
          ).trim(),
          branchConversationId: String(item?.branchConversationId || '').trim(),
          seedMessageCount: Number(item?.seedMessageCount) || 0,
          createdAt:
            typeof item?.createdAt === 'string' ? item.createdAt : null,
          updatedAt:
            typeof item?.updatedAt === 'string' ? item.updatedAt : null,
          activatedAt:
            typeof item?.activatedAt === 'string' ? item.activatedAt : null,
          status: String(item?.status || 'active')
        }))
        .filter(
          (item) => item.sourceConversationId && item.branchConversationId
        );

      const parentBranchByConversationId = new Map();
      const childBranchesByConversationId = new Map();

      branches.forEach((branch) => {
        parentBranchByConversationId.set(branch.branchConversationId, branch);

        if (!childBranchesByConversationId.has(branch.sourceConversationId)) {
          childBranchesByConversationId.set(branch.sourceConversationId, []);
        }

        childBranchesByConversationId
          .get(branch.sourceConversationId)
          .push(branch);
      });

      let rootConversationId = currentConversationId;
      const visitedAncestorIds = new Set([rootConversationId]);

      while (parentBranchByConversationId.has(rootConversationId)) {
        const parentBranch =
          parentBranchByConversationId.get(rootConversationId);
        const nextRootId = String(
          parentBranch?.sourceConversationId || ''
        ).trim();

        if (!nextRootId || visitedAncestorIds.has(nextRootId)) {
          break;
        }

        visitedAncestorIds.add(nextRootId);
        rootConversationId = nextRootId;
      }

      const relatedConversationIds = new Set([
        rootConversationId,
        currentConversationId
      ]);
      const relevantBranches = [];
      const pendingConversationIds = [rootConversationId];
      const visitedTreeIds = new Set();

      while (pendingConversationIds.length > 0) {
        const sourceConversationId = pendingConversationIds.shift();

        if (!sourceConversationId || visitedTreeIds.has(sourceConversationId)) {
          continue;
        }

        visitedTreeIds.add(sourceConversationId);

        const children =
          childBranchesByConversationId.get(sourceConversationId) || [];
        children
          .slice()
          .sort((a, b) =>
            String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
          )
          .forEach((branch) => {
            relevantBranches.push(branch);
            relatedConversationIds.add(branch.sourceConversationId);
            relatedConversationIds.add(branch.branchConversationId);
            pendingConversationIds.push(branch.branchConversationId);
          });
      }

      const conversations = Array.from(relatedConversationIds)
        .filter(Boolean)
        .map((id) => {
          const value =
            conversationsRaw[id] && typeof conversationsRaw[id] === 'object'
              ? conversationsRaw[id]
              : {};
          const fallbackTitle =
            typeof value.lastUserMessage === 'string' &&
            value.lastUserMessage.trim()
              ? value.lastUserMessage.slice(0, 48)
              : 'Conversation sans titre';

          return {
            id,
            title:
              typeof value.title === 'string' && value.title.trim()
                ? value.title.trim()
                : fallbackTitle,
            createdAt:
              typeof value.createdAt === 'string' ? value.createdAt : null,
            updatedAt:
              typeof value.updatedAt === 'string' ? value.updatedAt : null,
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
      console.error('Erreur branches conversation admin:', err);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

// Normalize incoming /chat payload into a stable request object.
// This function keeps body parsing separated from the main pipeline logic.
function parseChatRequest(req) {
  const message = String(req.body?.message || '');
  const isEdited = req.body?.isEdited === true;
  const bodyRequestId =
    typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
  const headerRequestId =
    typeof req.headers?.['x-request-id'] === 'string'
      ? String(req.headers['x-request-id']).trim()
      : '';
  const requestId =
    bodyRequestId || headerRequestId || String(req.requestId || '').trim();
  const conversationId =
    typeof req.body?.conversationId === 'string'
      ? req.body.conversationId.trim()
      : '';
  const isPrivateConversation = req.body?.isPrivateConversation === true;
  const sessionUserId = String(req.userSession?.userId || '').trim();
  const userId =
    sessionUserId || String(req.body?.userId || 'u_anon').trim() || 'u_anon';
  const convRef =
    conversationId && !isPrivateConversation
      ? db.ref('conversations').child(conversationId)
      : null;
  const recentHistory = trimHistory(req.body?.recentHistory);
  const conversationBranchHistory = normalizeConversationBranchHistory(
    req.body?.conversationBranchHistory
  );
  const mailsEnabled = req.body?.mailsEnabled !== false;
  const logsEnabled = req.body?.logsEnabled === true;
  const adminUiActive = req.body?.adminUiActive === true;
  const titleDenyList = Array.isArray(req.body?.titleDenyList)
    ? req.body.titleDenyList
        .map((value) => String(value || '').trim())
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
  if (!body || typeof body !== 'object') {
    return ['body: body_not_object'];
  }

  const schemaIssues = validateShape(chatRequestSchema, body);
  if (schemaIssues.length > 0) {
    return schemaIssues;
  }

  if (typeof body.message === 'string' && body.message.length > 12000) {
    return ['message: message_too_long'];
  }

  if (
    typeof body.userId !== 'string' &&
    body.userId !== undefined &&
    body.userId !== null
  ) {
    return ['userId: invalid_type'];
  }

  if (body.titleDenyList !== undefined) {
    if (!Array.isArray(body.titleDenyList)) {
      return ['titleDenyList: not_array'];
    }
    if (body.titleDenyList.some((value) => typeof value !== 'string')) {
      return ['titleDenyList: invalid_entry_type'];
    }
  }

  if (body.memory !== undefined && typeof body.memory !== 'string') {
    return ['memory: not_string'];
  }

  if (
    body.flags !== undefined &&
    (typeof body.flags !== 'object' ||
      body.flags === null ||
      Array.isArray(body.flags))
  ) {
    return ['flags: not_object'];
  }

  return [];
}

const activeChatRequests = new Map();
const CHAT_REQUEST_STALE_TTL_MS = 15 * 60 * 1000;
const activeChatProgressStreams = new Map(); // requestId -> Set(response)
const privateConversationMemoryCache = new Map(); // conversationId -> { memory, memoryState, updatedAt }
const conversationMemorySyncLocks = new Map(); // conversationId -> { promise, startedAt }
const MEMORY_SYNC_GATE_TIMEOUT_MS = 2000;
const conversationRelanceSyncLocks = new Map(); // conversationId -> { promise, startedAt, targetTurnNumber }
const conversationRelanceAsyncState = new Map(); // conversationId -> { targetTurnNumber, sourceTurnNumber, explorationRelanceWindow, explorationDirectivityLevel, isRelance, status, producedAt }
const conversationTurnCounters = new Map(); // conversationId -> currentTurnNumber
const RELANCE_SYNC_GATE_TIMEOUT_MS = 800;
const RELANCE_ASYNC_TIMEOUT_MS = 2500;
const RELANCE_ASYNC_STATE_TTL_MS = 30 * 1000;
const INTERSESSION_PREPARATION_WAIT_TIMEOUT_MS = 1200;
const INTERSESSION_FALLBACK_SEED_WAIT_TIMEOUT_MS = 120;

function nextConversationTurnNumber(conversationId) {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) {
    return 1;
  }

  const previous = Number(conversationTurnCounters.get(safeConversationId));
  const next = Number.isInteger(previous) && previous > 0 ? previous + 1 : 1;
  conversationTurnCounters.set(safeConversationId, next);
  return next;
}

function trackConversationMemorySync(conversationId, promiseLike) {
  const safeConversationId = String(conversationId || '').trim();
  if (
    !safeConversationId ||
    !promiseLike ||
    typeof promiseLike.then !== 'function'
  ) {
    return null;
  }

  let trackedPromise = null;
  trackedPromise = Promise.resolve(promiseLike)
    .catch(() => {
      // Non-blocking safeguard: background memory sync failures must not break future requests.
    })
    .finally(() => {
      const current = conversationMemorySyncLocks.get(safeConversationId);
      if (current && current.promise === trackedPromise) {
        conversationMemorySyncLocks.delete(safeConversationId);
      }
    });

  conversationMemorySyncLocks.set(safeConversationId, {
    promise: trackedPromise,
    startedAt: Date.now()
  });

  return trackedPromise;
}

async function waitForConversationMemorySync(
  conversationId,
  timeoutMs = MEMORY_SYNC_GATE_TIMEOUT_MS
) {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) {
    return { waited: false, timedOut: false, waitMs: 0 };
  }

  const pending = conversationMemorySyncLocks.get(safeConversationId);
  if (!pending || !pending.promise) {
    return { waited: false, timedOut: false, waitMs: 0 };
  }

  const start = Date.now();
  let timedOut = false;
  await Promise.race([
    pending.promise,
    wait(Math.max(0, timeoutMs)).then(() => {
      timedOut = true;
    })
  ]);

  return {
    waited: true,
    timedOut,
    waitMs: Math.max(0, Date.now() - start)
  };
}

function trackConversationRelanceSync(
  conversationId,
  promiseLike,
  targetTurnNumber = null
) {
  const safeConversationId = String(conversationId || '').trim();
  if (
    !safeConversationId ||
    !promiseLike ||
    typeof promiseLike.then !== 'function'
  ) {
    return null;
  }

  let trackedPromise = null;
  trackedPromise = Promise.resolve(promiseLike)
    .catch(() => {
      // Non-blocking safeguard: async relance failures must not break future requests.
    })
    .finally(() => {
      const current = conversationRelanceSyncLocks.get(safeConversationId);
      if (current && current.promise === trackedPromise) {
        conversationRelanceSyncLocks.delete(safeConversationId);
      }
    });

  conversationRelanceSyncLocks.set(safeConversationId, {
    promise: trackedPromise,
    targetTurnNumber: Number.isInteger(targetTurnNumber)
      ? targetTurnNumber
      : null,
    startedAt: Date.now()
  });

  return trackedPromise;
}

async function waitForConversationRelanceSync(
  conversationId,
  timeoutMs = RELANCE_SYNC_GATE_TIMEOUT_MS
) {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) {
    return { waited: false, timedOut: false, waitMs: 0 };
  }

  const pending = conversationRelanceSyncLocks.get(safeConversationId);
  if (!pending || !pending.promise) {
    return { waited: false, timedOut: false, waitMs: 0 };
  }

  const start = Date.now();
  let timedOut = false;
  await Promise.race([
    pending.promise,
    wait(Math.max(0, timeoutMs)).then(() => {
      timedOut = true;
    })
  ]);

  return {
    waited: true,
    timedOut,
    waitMs: Math.max(0, Date.now() - start)
  };
}

function consumeRelanceAsyncStateForTurn(conversationId, currentTurnNumber) {
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId || !Number.isInteger(currentTurnNumber)) {
    return {
      appliedState: null,
      droppedState: null,
      droppedReason: null
    };
  }

  const state = conversationRelanceAsyncState.get(safeConversationId);
  if (!state || typeof state !== 'object') {
    return {
      appliedState: null,
      droppedState: null,
      droppedReason: null
    };
  }

  const producedAt = Number(state.producedAt);
  if (
    Number.isFinite(producedAt) &&
    Date.now() - producedAt > RELANCE_ASYNC_STATE_TTL_MS
  ) {
    conversationRelanceAsyncState.delete(safeConversationId);
    return {
      appliedState: null,
      droppedState: state,
      droppedReason: 'expired_ttl'
    };
  }

  const targetTurnNumber = Number(state.targetTurnNumber);
  if (!Number.isInteger(targetTurnNumber) || targetTurnNumber <= 0) {
    conversationRelanceAsyncState.delete(safeConversationId);
    return {
      appliedState: null,
      droppedState: state,
      droppedReason: 'invalid_target_turn'
    };
  }

  if (targetTurnNumber < currentTurnNumber) {
    conversationRelanceAsyncState.delete(safeConversationId);
    return {
      appliedState: null,
      droppedState: state,
      droppedReason: 'stale_target_turn'
    };
  }

  if (targetTurnNumber > currentTurnNumber) {
    return {
      appliedState: null,
      droppedState: null,
      droppedReason: null
    };
  }

  conversationRelanceAsyncState.delete(safeConversationId);
  return {
    appliedState: state,
    droppedState: null,
    droppedReason: null
  };
}

function mapChatStageToProgressStep(stage = '') {
  const key = String(stage || '').trim();

  if (!key) {
    return 'reading';
  }

  if (
    ['request_destructured', 'request_normalized', 'suicide_analysis'].includes(
      key
    )
  ) {
    return 'reading';
  }

  if (
    ['recall_analysis', 'mode_analysis'].includes(key) ||
    key.startsWith('analyzer_')
  ) {
    return 'understanding';
  }

  if (['reply_generation'].includes(key)) {
    return 'drafting';
  }

  if (['memory_update', 'persist_response'].includes(key)) {
    return 'finalizing';
  }

  return 'reading';
}

function writeSSEEvent(res, eventName, payload) {
  try {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // Ignore stream write failures on closed SSE connections.
  }
}

function pushChatProgressEvent(requestId, eventName, payload) {
  const safeId = String(requestId || '').trim();
  if (!safeId) return;

  const streams = activeChatProgressStreams.get(safeId);
  if (!streams || streams.size === 0) return;

  for (const res of streams) {
    writeSSEEvent(res, eventName, payload);
  }
}

function publishChatProgressStage(requestId, stage, status = 'in_progress') {
  const safeId = String(requestId || '').trim();
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

  pushChatProgressEvent(safeId, 'progress', {
    requestId: safeId,
    status,
    stage,
    progressStep,
    ts: Date.now()
  });
}

function publishChatProgressTerminal(requestId, status) {
  const safeId = String(requestId || '').trim();
  if (!safeId) return;

  pushChatProgressEvent(safeId, 'progress', {
    requestId: safeId,
    status,
    stage: status,
    progressStep: status,
    ts: Date.now()
  });
}

function closeChatProgressStreams(requestId) {
  const safeId = String(requestId || '').trim();
  if (!safeId) return;

  const streams = activeChatProgressStreams.get(safeId);
  if (!streams || streams.size === 0) {
    activeChatProgressStreams.delete(safeId);
    return;
  }

  for (const res of streams) {
    try {
      res.end();
    } catch {
      // Ignore close failures on already-closed SSE connections.
    }
  }

  activeChatProgressStreams.delete(safeId);
}

function registerActiveChatRequest(requestId, userId) {
  const safeId = String(requestId || '').trim();
  if (!safeId) return;

  activeChatRequests.set(safeId, {
    userId: String(userId || '').trim(),
    canceled: false,
    updatedAt: Date.now(),
    lastProgressStep: null
  });
}

function cancelActiveChatRequest(requestId, userId = '') {
  const safeId = String(requestId || '').trim();
  if (!safeId) return false;

  const entry = activeChatRequests.get(safeId);
  if (!entry) return false;

  const safeUserId = String(userId || '').trim();
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
  const safeId = String(requestId || '').trim();
  if (!safeId) return false;

  const entry = activeChatRequests.get(safeId);
  if (!entry) return false;
  return entry.canceled === true;
}

function finalizeActiveChatRequest(requestId) {
  const safeId = String(requestId || '').trim();
  if (!safeId) return;
  activeChatRequests.delete(safeId);
  closeChatProgressStreams(safeId);
}

function throwIfChatRequestCanceled(requestId) {
  if (isActiveChatRequestCanceled(requestId)) {
    const err = new Error('Chat request canceled');
    err.code = 'chat_request_canceled';
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

app.post('/chat/cancel', requireUserAuth, (req, res) => {
  const requestId =
    typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
  const userId = String(req.userSession?.userId || '').trim();

  if (!requestId) {
    return res.status(400).json({ error: 'Missing requestId' });
  }

  const canceled = cancelActiveChatRequest(requestId, userId);
  if (canceled) {
    publishChatProgressTerminal(requestId, 'canceled');
  }
  return res.json({ success: true, requestId, canceled });
});

app.post('/chat/stream/interrupted', requireUserAuth, async (req, res) => {
  const conversationId =
    typeof req.body?.conversationId === 'string'
      ? req.body.conversationId.trim()
      : '';
  const userId = String(req.userSession?.userId || '').trim();
  const requestId =
    typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
  const partialReply =
    typeof req.body?.partialReply === 'string' ? req.body.partialReply : '';
  const isPrivateConversation = req.body?.isPrivateConversation === true;
  const isEdited = req.body?.isEdited === true;

  if (!conversationId) {
    return res.status(400).json({ error: 'Missing conversationId' });
  }

  const normalizedPartial = partialReply.trim();
  if (!normalizedPartial) {
    return res.status(400).json({ error: 'Missing partialReply' });
  }

  if (isPrivateConversation) {
    return res.json({
      success: true,
      skipped: true,
      reason: 'private_conversation'
    });
  }

  try {
    const pushedRef = await messagesRef.push({
      role: 'assistant',
      content: isEdited ? normalizedPartial + '\n[MODIFIÉ]' : normalizedPartial,
      timestamp: Date.now(),
      userId,
      conversationId,
      streamInterrupted: true,
      requestId: requestId || null
    });

    const convRef = db.ref('conversations').child(conversationId);
    await convRef.update({
      updatedAt: new Date().toISOString()
    });

    return res.json({
      success: true,
      messageId: pushedRef.key || null,
      conversationId
    });
  } catch (err) {
    console.error(
      '[STREAM_INTERRUPTED_PERSIST][FAILED]',
      err && err.message ? err.message : String(err)
    );
    return res
      .status(500)
      .json({ error: 'Failed to persist interrupted stream' });
  }
});

app.get('/chat/progress', requireUserAuth, (req, res) => {
  const requestId =
    typeof req.query?.requestId === 'string' ? req.query.requestId.trim() : '';

  if (!requestId) {
    return res.status(400).json({ error: 'Missing requestId' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let streams = activeChatProgressStreams.get(requestId);
  if (!streams) {
    streams = new Set();
    activeChatProgressStreams.set(requestId, streams);
  }
  streams.add(res);

  writeSSEEvent(res, 'ready', {
    requestId,
    status: 'connected',
    ts: Date.now()
  });

  req.on('close', () => {
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
  const previousMemory = normalizeMemory(
    req.body?.memory,
    activePromptRegistry
  );
  const rawFlags = normalizeFlags(req.body?.flags);
  const flags = normalizeSessionFlags(rawFlags);

  return {
    previousMemory,
    rawFlags,
    flags
  };
}

// Builds a compact one-line signal annotation for the turn, to be stored in the
// assistant history entry and later injected into the LLM context as self-knowledge.
// Only non-default values are included to keep the annotation minimal.
function buildTurnSignals(
  postureDecision,
  {
    allianceSignal = 'good',
    relationalAdjustmentActive = false,
    interpretationRejectionActive = false,
    insightMoment = false,
    selfCriticismLevel = 'low',
    emotionalDecentering = false,
    dependencyRiskLevel = 'low'
  } = {}
) {
  const parts = [];
  const state =
    typeof postureDecision.conversationState === 'string'
      ? postureDecision.conversationState
      : 'exploration_open';
  parts.push(`état:${state}`);

  if (state.startsWith('exploration_')) {
    const lvl = postureDecision.finalDirectivityLevel;
    if (typeof lvl === 'number' && lvl > 0) {
      parts.push(`niveau:${lvl}`);
    }
  }

  const sec = postureDecision.secondaryTension;
  if (sec && typeof sec.family === 'string') {
    parts.push(`tension:${sec.family}`);
  }

  if (allianceSignal && allianceSignal !== 'good') {
    parts.push(`alliance:${allianceSignal}`);
  }

  if (relationalAdjustmentActive) parts.push('ajust_rel');
  if (interpretationRejectionActive) parts.push('rejet_interp');
  if (insightMoment) parts.push('insight');
  if (selfCriticismLevel && selfCriticismLevel !== 'low')
    parts.push(`autocrit:${selfCriticismLevel}`);

  if (postureDecision.formalAddress === true) parts.push('adressage:vous');

  if (emotionalDecentering) parts.push('decentrage_emo');

  if (dependencyRiskLevel && dependencyRiskLevel !== 'low')
    parts.push(`dependance:${dependencyRiskLevel}`);

  return parts.join(', ');
}

function deriveAttachmentLevelFromScore(attachmentScore = 0) {
  const score = Number.isFinite(attachmentScore) ? attachmentScore : 0;
  if (score <= 30) return 'low';
  if (score <= 65) return 'medium';
  return 'high';
}

async function analyzeAffiliationShortValidationCoherence(
  message = '',
  history = [],
  _promptRegistry = buildDefaultPromptRegistry()
) {
  const trimmedMessage = String(message || '').trim();
  const normalizedLead = trimmedMessage
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2019]/g, "'");

  if (!hasShortAffiliationMarker(message)) {
    return {
      shortValidationConfirmed: true,
      source: 'deterministic_no_short_marker'
    };
  }

  // Deterministic fast-path for explicit leading validation markers.
  // This avoids unnecessary LLM rejects on forms like "Exact." or
  // concession starts such as "Oui, mais ...".
  if (
    /^(?:oui|exact(?:ement)?|c[' ]est\s*(?:exactement\s+)?ca)\b/.test(
      normalizedLead
    ) &&
    !/^oui\s*,?\s*mais\s+non\b/.test(normalizedLead)
  ) {
    return {
      shortValidationConfirmed: true,
      source: 'deterministic_leading_marker'
    };
  }

  const context = trimInfoAnalysisHistory(history);
  const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.content}`).join('\n')}
`;

  try {
    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_completion_tokens: 60,
      messages: [
        {
          role: 'system',
          content:
            "Tu determines si un marqueur lexical court de validation (ex: 'exactement', 'c'est ca') confirme reellement le message assistant precedent. Reponds STRICTEMENT en JSON: {\"shortValidationConfirmed\": true|false}. true uniquement si la validation est contextuellement coherente et non ironique/non contestataire."
        },
        { role: 'user', content: user }
      ]
    });

    const raw = (r.choices?.[0]?.message?.content || '')
      .replace(/```json|```/g, '')
      .trim();
    const parsed = JSON.parse(raw);
    return {
      shortValidationConfirmed: parsed.shortValidationConfirmed === true,
      source: 'llm'
    };
  } catch {
    return {
      shortValidationConfirmed: false,
      source: 'llm_fallback'
    };
  }
}

// Main chat endpoint.
// This route orchestrates the request parsing, safety analysis, mode detection,
// response generation, memory update, and persistence of both user and assistant messages.
async function handleChatPost(req, res) {
  return llmUsageContext.run(createLlmUsageAccumulator(), async () => {
    const onTokenCallbackForChat =
      typeof req.onTokenCallbackForChat === 'function'
        ? req.onTokenCallbackForChat
        : null;
    const chatTransport = onTokenCallbackForChat ? 'stream' : 'classic';
    const requestData = parseChatRequest(req);
    const requestId = String(requestData.requestId || '').trim();
    // traceId: server-generated per-request, always present even without a client requestId.
    const traceId =
      requestId ||
      `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const chatLogger = childLogger({
      scope: 'chat',
      transport: chatTransport,
      conversationId: requestData.conversationId || null,
      requestId: requestId || null,
      traceId
    });

    if (requestData.logsEnabled === true) {
      chatLogger.info({
        event: 'chat_input_received',
        transport: chatTransport
      });
    }
    res.setHeader('x-trace-id', traceId);

    if (requestId) {
      registerActiveChatRequest(requestId, requestData.userId || 'u_anon');
      req.on('aborted', () => {
        cancelActiveChatRequest(requestId, requestData.userId || 'u_anon');
      });
    }

    // Check biometric unlock token if user has biometric lock enabled
    try {
      const userSession = await getUserSession(req);
      if (userSession?.user?.biometricLockEnabled === true) {
        req.userSession = userSession;
        const tokenValidation = validateBiometricTokenIfNeeded(req);
        if (!tokenValidation.valid) {
          return res.status(403).json({
            error: 'Biometric unlock required',
            reason: tokenValidation.reason
          });
        }
      }
    } catch (err) {
      // Non-blocking: If session check fails, continue (user may be anonymous)
      chatLogger.debug({
        event: 'biometric_check_skipped',
        error: err.message
      });
    }

    const chatStartTime = Date.now();
    let chatLastStage = 'request_parsed';
    let chatStageMarkTime = chatStartTime;
    let logsEnabledForCatch = requestData.logsEnabled === true;
    let authenticatedUsageUserId = '';
    const chatStageTimings = [];
    const CHAT_SLOW_LOG_THRESHOLD_MS = 4000;

    function markChatStage(stage) {
      const now = Date.now();
      chatStageTimings.push({
        stage,
        deltaMs: now - chatStageMarkTime
      });
      chatStageMarkTime = now;
      chatLastStage = stage;
      publishChatProgressStage(requestId, stage, 'in_progress');
    }

    function summarizeChatStageTimings(stageTimings = []) {
      const safeStages = Array.isArray(stageTimings)
        ? stageTimings
            .map((entry) => ({
              stage: typeof entry?.stage === 'string' ? entry.stage : null,
              deltaMs: Number.isFinite(entry?.deltaMs)
                ? Math.max(0, Math.round(entry.deltaMs))
                : null
            }))
            .filter((entry) => entry.stage && entry.deltaMs !== null)
        : [];

      const sortedByDelta = safeStages
        .slice()
        .sort((a, b) => b.deltaMs - a.deltaMs);

      const totalMs = safeStages.reduce((sum, entry) => sum + entry.deltaMs, 0);

      return {
        stageCount: safeStages.length,
        totalMs,
        maxStage: sortedByDelta[0] || null,
        topStages: sortedByDelta.slice(0, 6)
      };
    }

    async function resolveUsageUserId() {
      if (authenticatedUsageUserId) {
        return authenticatedUsageUserId;
      }

      try {
        const session = req.userSession || (await getUserSession(req));
        authenticatedUsageUserId = String(session?.userId || '').trim();
        return authenticatedUsageUserId;
      } catch {
        return '';
      }
    }

    async function registerUsageConsumptionFromTurn({
      writerUsage = null
    } = {}) {
      if (chatTransport === 'stream') {
        appendLlmUsageToCurrentRequest(writerUsage);
      }

      const accumulator = llmUsageContext.getStore();
      const totalTokens = Number(accumulator?.totalTokens);
      const chargedTokens = Number(accumulator?.chargedTokens);
      const safeTotalTokens =
        Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0;
      const safeChargedTokens =
        Number.isFinite(chargedTokens) && chargedTokens > 0 ? chargedTokens : 0;
      const deltaTokens = Math.max(0, safeTotalTokens - safeChargedTokens);

      if (!(deltaTokens > 0)) {
        chatLogger.debug({
          event: 'usage_capture_skipped',
          reason: 'no_delta_tokens',
          totalTokens: safeTotalTokens,
          chargedTokens: safeChargedTokens,
          transport: chatTransport
        });
        return;
      }

      if (accumulator && typeof accumulator === 'object') {
        accumulator.chargedTokens = safeChargedTokens + deltaTokens;
      }

      const usageUserId = await resolveUsageUserId();
      if (!usageUserId) {
        chatLogger.warn({
          event: 'usage_capture_skipped',
          reason: 'missing_usage_user',
          deltaTokens,
          transport: chatTransport
        });
        return;
      }

      const simulatedAmount = tokensToSimulatedEur(deltaTokens);
      if (!(simulatedAmount > 0)) {
        chatLogger.warn({
          event: 'usage_capture_skipped',
          reason: 'non_positive_amount',
          usageUserId,
          deltaTokens,
          transport: chatTransport
        });
        return;
      }

      try {
        const userSnap = await usersRef.child(usageUserId).once('value');
        const userData = userSnap.val();
        if (!userData || typeof userData !== 'object') {
          chatLogger.warn({
            event: 'usage_capture_skipped',
            reason: 'missing_user_data',
            usageUserId,
            deltaTokens,
            simulatedAmount,
            transport: chatTransport
          });
          return;
        }

        const rawUsageEnvelope =
          userData.usageEnvelope && typeof userData.usageEnvelope === 'object'
            ? userData.usageEnvelope
            : buildDefaultUsageEnvelope();
        const renewed = applyMonthlyRenewal(rawUsageEnvelope, new Date());
        const consumed = consumeEnvelope(renewed.state, simulatedAmount);
        const usageMonthKey = getUsageMonthKey(new Date());

        const previousMeter = normalizeUsageMeter(userData.usageMeter);
        const nextMeter = {
          totalTokens: previousMeter.totalTokens + Math.round(deltaTokens),
          totalSimulatedEur: previousMeter.totalSimulatedEur + simulatedAmount,
          updatedAt: new Date().toISOString()
        };

        const rawMonthlyHistory =
          userData.usageMonthlyHistory &&
          typeof userData.usageMonthlyHistory === 'object' &&
          !Array.isArray(userData.usageMonthlyHistory)
            ? userData.usageMonthlyHistory
            : {};

        const nextMonthlyHistory = { ...rawMonthlyHistory };
        if (usageMonthKey) {
          const previousMonthEntry =
            nextMonthlyHistory[usageMonthKey] &&
            typeof nextMonthlyHistory[usageMonthKey] === 'object'
              ? nextMonthlyHistory[usageMonthKey]
              : {};
          const previousMonthTokens = Number(previousMonthEntry.tokens || 0);
          const previousMonthEur = Number(
            previousMonthEntry.totalSimulatedEur || 0
          );

          nextMonthlyHistory[usageMonthKey] = {
            tokens:
              (Number.isFinite(previousMonthTokens) && previousMonthTokens > 0
                ? Math.round(previousMonthTokens)
                : 0) + Math.round(deltaTokens),
            totalSimulatedEur:
              (Number.isFinite(previousMonthEur) && previousMonthEur > 0
                ? previousMonthEur
                : 0) + simulatedAmount,
            updatedAt: new Date().toISOString()
          };
        }

        await usersRef.child(usageUserId).update({
          usageEnvelope: toUsageEnvelopeStorageShape(consumed.state),
          usageMeter: nextMeter,
          usageMonthlyHistory: nextMonthlyHistory,
          updatedAt: new Date().toISOString()
        });

        chatLogger.info({
          event: 'usage_capture_applied',
          usageUserId,
          deltaTokens: Math.round(deltaTokens),
          simulatedAmount,
          totalTokensAfter: nextMeter.totalTokens,
          totalSimulatedEurAfter: nextMeter.totalSimulatedEur,
          transport: chatTransport,
          isPrivateConversation: isPrivateConversationForCatch === true,
          requestId: requestId || null
        });
      } catch (error) {
        chatLogger.warn({
          event: 'usage_capture_failed',
          usageUserId,
          deltaTokens,
          simulatedAmount,
          transport: chatTransport,
          isPrivateConversation: isPrivateConversationForCatch === true,
          requestId: requestId || null,
          error: error && error.message ? error.message : String(error)
        });
      }
    }

    function logChatDecision(event, payload = {}) {
      if (!logsEnabledForCatch) {
        return;
      }

      chatLogger.info(
        {
          event,
          ...payload
        },
        'chat-decision'
      );
    }

    const requestIssues = validateChatRequestShape(req.body);
    if (requestIssues.length > 0) {
      publishChatProgressTerminal(requestId, 'error');
      chatLogger.warn(
        {
          issues: requestIssues
        },
        'chat-request-shape'
      );

      return res.status(400).json({
        error: 'Invalid chat request',
        issues: requestIssues
      });
    }

    throwIfCanceled();

    const basePromptRegistryForCatch = buildDefaultPromptRegistry();

    // Values preserved for the fallback error path.
    // If the main pipeline fails, we still return a minimally valid response.
    let modeForCatch = 'exploration_open';
    let suicideLevelForCatch = 'N0';
    let previousMemoryForCatch = normalizeMemory(
      '',
      basePromptRegistryForCatch
    );
    let previousMemoryRewriteDebugForCatch = null;
    let flagsForCatch = normalizeSessionFlags({});
    let promptRegistryForCatch = basePromptRegistryForCatch;
    let conversationIdForCatch = requestData.conversationId;
    let userIdForCatch = requestData.userId || 'u_anon';
    let convRefForCatch = requestData.convRef;
    let isPrivateConversationForCatch =
      requestData.isPrivateConversation === true;
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
          stage: typeof entry?.stage === 'string' ? entry.stage : null,
          deltaMs: Number.isFinite(entry?.deltaMs) ? entry.deltaMs : null
        }))
        .filter((entry) => entry.stage);
    }

    function normalizeDebugMetaForStorage(
      debugMeta = {},
      promptRegistry = buildDefaultPromptRegistry()
    ) {
      const safe = debugMeta && typeof debugMeta === 'object' ? debugMeta : {};

      return {
        topChips: Array.isArray(safe.topChips)
          ? safe.topChips
              .map((chip) => String(chip || '').trim())
              .filter(Boolean)
          : [],
        memory: normalizeMemory(safe.memory, promptRegistry),
        memoryBeforeSanitization:
          typeof safe.memoryBeforeSanitization === 'string'
            ? normalizeMemory(safe.memoryBeforeSanitization, promptRegistry)
            : null,
        memoryAncientCleanupDeletedIds: Array.isArray(
          safe.memoryAncientCleanupDeletedIds
        )
          ? safe.memoryAncientCleanupDeletedIds
              .map((id) => String(id || '').trim())
              .filter(Boolean)
          : [],
        memoryState: normalizeMemoryStateShape(
          safe.memoryState,
          '',
          Date.now()
        ),
        intersessionMemoryRuntime:
          typeof safe.intersessionMemoryRuntime === 'string'
            ? safe.intersessionMemoryRuntime.trim()
            : null,
        directivityText:
          typeof safe.directivityText === 'string' ? safe.directivityText : '',
        conversationState: normalizeConversationState(safe.conversationState),
        effectiveConversationState: normalizeConversationState(
          safe.effectiveConversationState
        ),
        consecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(
          safe.consecutiveNonExplorationTurns
        ),
        interpretationRejection: safe.interpretationRejection === true,
        needsSoberReadjustment: safe.needsSoberReadjustment === true,
        relationalAdjustmentActive: safe.relationalAdjustmentActive === true,
        pipelineStages: normalizePipelineStagesForStorage(safe.pipelineStages),
        explorationCalibrationLevel: Number.isInteger(
          safe.explorationCalibrationLevel
        )
          ? clampExplorationDirectivityLevel(safe.explorationCalibrationLevel)
          : null,
        directivityInputLevel: Number.isInteger(safe.directivityInputLevel)
          ? clampExplorationDirectivityLevel(safe.directivityInputLevel)
          : null,
        directivityUsedLevel: Number.isInteger(safe.directivityUsedLevel)
          ? clampExplorationDirectivityLevel(safe.directivityUsedLevel)
          : null,
        directivityNextLevel: Number.isInteger(safe.directivityNextLevel)
          ? clampExplorationDirectivityLevel(safe.directivityNextLevel)
          : null,
        directivityNextWindow: Array.isArray(safe.directivityNextWindow)
          ? safe.directivityNextWindow
              .filter((v) => typeof v === 'boolean')
              .slice(-4)
          : [],
        relanceAsyncStatus:
          typeof safe.relanceAsyncStatus === 'string'
            ? safe.relanceAsyncStatus
            : null,
        relanceAppliedAtTurnEntrySourceTurn: Number.isInteger(
          safe.relanceAppliedAtTurnEntrySourceTurn
        )
          ? safe.relanceAppliedAtTurnEntrySourceTurn
          : null,
        relanceAppliedAtTurnEntryStatus:
          typeof safe.relanceAppliedAtTurnEntryStatus === 'string'
            ? safe.relanceAppliedAtTurnEntryStatus
            : null,
        relanceAsyncTargetTurn: Number.isInteger(safe.relanceAsyncTargetTurn)
          ? safe.relanceAsyncTargetTurn
          : null,
        explorationSignal:
          typeof safe.explorationSignal === 'string'
            ? safe.explorationSignal
            : null,
        analyzerDeterministicEvidence: Array.isArray(
          safe.analyzerDeterministicEvidence
        )
          ? safe.analyzerDeterministicEvidence
              .map((v) => String(v || '').trim())
              .filter(Boolean)
          : [],
        // Posture contract (V3)
        intent: typeof safe.intent === 'string' ? safe.intent : null,
        forbidden: Array.isArray(safe.forbidden) ? safe.forbidden : [],
        confidenceSignal:
          typeof safe.confidenceSignal === 'number'
            ? Math.max(0, Math.min(1, safe.confidenceSignal))
            : 1.0,
        relancePolicy:
          typeof safe.relancePolicy === 'string'
            ? safe.relancePolicy
            : 'selective',
        useDirectAddress: safe.useDirectAddress === true,
        actionCollapseGuardActive: safe.actionCollapseGuardActive === true,
        writerIntentHints: Array.isArray(safe.writerIntentHints)
          ? safe.writerIntentHints
              .map((hint) => String(hint || '').trim())
              .filter(Boolean)
          : [],
        writerIntentHintsInactive: Array.isArray(safe.writerIntentHintsInactive)
          ? safe.writerIntentHintsInactive
              .map((entry) => {
                if (!entry || typeof entry !== 'object') return null;
                const hint = String(entry.hint || '').trim();
                const reason = String(entry.reason || '').trim();
                return hint && reason ? { hint, reason } : null;
              })
              .filter(Boolean)
          : [],
        stateTransitionFrom:
          typeof safe.stateTransitionFrom === 'string'
            ? safe.stateTransitionFrom
            : null,
        stateTransitionValid: safe.stateTransitionValid !== false,
        stateTransitionRequested:
          typeof safe.stateTransitionRequested === 'string'
            ? safe.stateTransitionRequested
            : null,
        allianceSignal: normalizeAllianceState(safe.allianceSignal),
        engagementLevel: normalizeEngagementLevel(safe.engagementLevel),
        attentionWindow: normalizeAttentionWindow(safe.attentionWindow),
        dependencyRiskScore: clampDependencyRiskScore(safe.dependencyRiskScore),
        dependencyRiskLevel: normalizeDependencyRiskLevel(
          safe.dependencyRiskLevel
        ),
        externalSupportMode: normalizeExternalSupportMode(
          safe.externalSupportMode
        ),
        closureIntent: safe.closureIntent === true,
        affiliationScore:
          typeof safe.affiliationScore === 'number'
            ? safe.affiliationScore
            : null,
        affiliationFinalScore:
          typeof safe.affiliationFinalScore === 'number'
            ? safe.affiliationFinalScore
            : null,
        affiliationWindow: normalizeAffiliationWindow(safe.affiliationWindow),
        affiliationEstablished: safe.affiliationEstablished === true,
        emotionalDecentering: safe.emotionalDecentering === true,
        formalAddress: safe.formalAddress === true,
        contactInsightMoment: safe.contactInsightMoment === true,
        contactSelfCriticismLevel:
          typeof safe.contactSelfCriticismLevel === 'string'
            ? safe.contactSelfCriticismLevel
            : 'low',
        aggressiveDischargeDetected: safe.aggressiveDischargeDetected === true,
        postDischargeTransitionActive:
          safe.postDischargeTransitionActive === true,
        secondaryTension:
          safe.secondaryTension &&
          typeof safe.secondaryTension === 'object' &&
          !Array.isArray(safe.secondaryTension)
            ? safe.secondaryTension
            : null,
        n2TurnType:
          typeof safe.n2TurnType === 'string' ? safe.n2TurnType : null,
        emergencyNumbersIncluded: safe.emergencyNumbersIncluded === true,
        postCrisisSupportActive: safe.postCrisisSupportActive === true,
        postCrisisSupportCarryTurn: safe.postCrisisSupportCarryTurn === true,
        emergencySupportText:
          typeof safe.emergencySupportText === 'string'
            ? safe.emergencySupportText
            : null,
        majorHarmRiskLevel:
          safe.majorHarmRiskLevel === 'H1' || safe.majorHarmRiskLevel === 'H2'
            ? safe.majorHarmRiskLevel
            : 'H0',
        majorHarmImminenceBand: [
          'none',
          'immediate',
          'short_term',
          'capability_opportunity'
        ].includes(safe.majorHarmImminenceBand)
          ? safe.majorHarmImminenceBand
          : 'none',
        majorHarmTargetsPeople: safe.majorHarmTargetsPeople === true,
        requestId: typeof safe.requestId === 'string' ? safe.requestId : null,
        traceId: typeof safe.traceId === 'string' ? safe.traceId : null,
        uncertaintyExpressionPolicy:
          typeof safe.uncertaintyExpressionPolicy === 'string'
            ? safe.uncertaintyExpressionPolicy
            : null,
        uncertaintyDrivers: Array.isArray(safe.uncertaintyDrivers)
          ? safe.uncertaintyDrivers.map((v) => String(v || '')).filter(Boolean)
          : [],
        isolationScore:
          typeof safe.isolationScore === 'number'
            ? Math.max(0, Math.min(100, Math.round(safe.isolationScore)))
            : 0,
        attachmentScore:
          typeof safe.attachmentScore === 'number'
            ? Math.max(0, Math.min(100, Math.round(safe.attachmentScore)))
            : 0,
        dependencyCareMessagePending:
          safe.dependencyCareMessagePending === 'medium' ||
          safe.dependencyCareMessagePending === 'high'
            ? safe.dependencyCareMessagePending
            : false
      };
    }

    async function persistFallbackAssistantMessage(
      reply,
      debug,
      debugMeta = {}
    ) {
      if (!conversationIdForCatch || isPrivateConversationForCatch) {
        return;
      }

      await messagesRef.push({
        role: 'assistant',
        content: isEditedForCatch ? reply + '\n[MODIFIÉ]' : reply,
        timestamp: Date.now(),
        userId: userIdForCatch,
        conversationId: conversationIdForCatch,
        debug: Array.isArray(debug) ? debug : [],
        debugMeta: normalizeDebugMetaForStorage(
          debugMeta,
          promptRegistryForCatch
        )
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
      memory = '',
      memoryBeforeSanitization = null,
      memoryAncientCleanupDeletedIds = [],
      suicideLevel = 'N0',
      conversationState = 'exploration_open',
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
        memoryBeforeSanitization:
          typeof memoryBeforeSanitization === 'string'
            ? normalizeMemory(memoryBeforeSanitization, promptRegistry)
            : null,
        memoryAncientCleanupDeletedIds: Array.isArray(
          memoryAncientCleanupDeletedIds
        )
          ? memoryAncientCleanupDeletedIds
              .map((id) => String(id || '').trim())
              .filter(Boolean)
          : [],
        directivityText: buildDirectivityText({
          conversationState,
          explorationCalibrationLevel,
          explorationDirectivityLevel,
          explorationRelanceWindow
        }),
        interpretationRejection: interpretationRejection === true,
        needsSoberReadjustment: needsSoberReadjustment === true,
        relationalAdjustmentActive: relationalAdjustmentActive === true,
        pipelineStages: chatStageTimings
          .map((entry) => ({
            stage: typeof entry?.stage === 'string' ? entry.stage : null,
            deltaMs: Number.isFinite(entry?.deltaMs) ? entry.deltaMs : null
          }))
          .filter((entry) => entry.stage),
        explorationCalibrationLevel:
          explorationCalibrationLevel !== null &&
          explorationCalibrationLevel !== undefined
            ? clampExplorationDirectivityLevel(explorationCalibrationLevel)
            : null,
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
      markChatStage('request_destructured');
      throwIfCanceled();

      // Validate that the request is tied to a conversation.
      if (!conversationId) {
        return res.status(400).json({ error: 'Missing conversationId' });
      }

      const currentTurnNumber = nextConversationTurnNumber(conversationId);

      const memorySyncGateResult = await waitForConversationMemorySync(
        conversationId,
        MEMORY_SYNC_GATE_TIMEOUT_MS
      );
      if (memorySyncGateResult.waited) {
        logChatDecision('memory_sync_gate', {
          waitedMs: memorySyncGateResult.waitMs,
          timedOut: memorySyncGateResult.timedOut === true
        });
      }

      const relanceSyncGateResult = await waitForConversationRelanceSync(
        conversationId,
        RELANCE_SYNC_GATE_TIMEOUT_MS
      );
      if (relanceSyncGateResult.waited) {
        logChatDecision('relance_async_gate', {
          waitedMs: relanceSyncGateResult.waitMs,
          timedOut: relanceSyncGateResult.timedOut === true
        });
      }
      throwIfCanceled();

      // Normalize memory and flags with the active registry so all later steps use the same rules.
      const activePromptRegistry = buildDefaultPromptRegistry();
      const { flags: requestFlags } = normalizeChatMemoryAndFlags(
        req,
        activePromptRegistry
      );
      const relanceStateResolution = consumeRelanceAsyncStateForTurn(
        conversationId,
        currentTurnNumber
      );
      let flags = normalizeSessionFlags(requestFlags);
      let relanceAppliedAtTurnEntry = null;

      if (
        relanceStateResolution.appliedState &&
        typeof relanceStateResolution.appliedState === 'object'
      ) {
        const appliedState = relanceStateResolution.appliedState;
        flags = normalizeSessionFlags({
          ...flags,
          explorationRelanceWindow: Array.isArray(
            appliedState.explorationRelanceWindow
          )
            ? appliedState.explorationRelanceWindow
            : flags.explorationRelanceWindow,
          explorationDirectivityLevel: Number.isInteger(
            appliedState.explorationDirectivityLevel
          )
            ? appliedState.explorationDirectivityLevel
            : flags.explorationDirectivityLevel
        });

        relanceAppliedAtTurnEntry = {
          sourceTurnNumber: Number.isInteger(appliedState.sourceTurnNumber)
            ? appliedState.sourceTurnNumber
            : null,
          targetTurnNumber: Number.isInteger(appliedState.targetTurnNumber)
            ? appliedState.targetTurnNumber
            : null,
          isRelance: appliedState.isRelance === true,
          status:
            typeof appliedState.status === 'string'
              ? appliedState.status
              : 'ready'
        };

        logChatDecision('relance_async_applied', {
          currentTurnNumber,
          sourceTurnNumber: relanceAppliedAtTurnEntry.sourceTurnNumber,
          targetTurnNumber: relanceAppliedAtTurnEntry.targetTurnNumber,
          status: relanceAppliedAtTurnEntry.status,
          isRelance: relanceAppliedAtTurnEntry.isRelance,
          explorationDirectivityLevel: flags.explorationDirectivityLevel,
          explorationRelanceWindow: flags.explorationRelanceWindow
        });
      }

      if (relanceStateResolution.droppedReason) {
        logChatDecision('relance_async_state_dropped', {
          currentTurnNumber,
          reason: relanceStateResolution.droppedReason,
          sourceTurnNumber: Number.isInteger(
            relanceStateResolution.droppedState?.sourceTurnNumber
          )
            ? relanceStateResolution.droppedState.sourceTurnNumber
            : null,
          targetTurnNumber: Number.isInteger(
            relanceStateResolution.droppedState?.targetTurnNumber
          )
            ? relanceStateResolution.droppedState.targetTurnNumber
            : null
        });
      }

      let previousMemory = normalizeMemory(
        isPrivateConversation === true ? req.body?.memory : '',
        activePromptRegistry
      );
      let previousMemoryState = normalizeMemoryStateShape(
        req.body?.memoryState,
        '',
        Date.now()
      );
      let previousMemoryRewriteDebug = null;
      let previousConversationActivityMs = Date.now();
      let hasPersistedConversationMemory = false;
      const convMemoryPromise =
        !isPrivateConversation && convRef
          ? convRef
              .once('value')
              .then((s) => {
                const d = s.val();
                if (!d || typeof d !== 'object') return null;
                return {
                  memory:
                    typeof d.memory === 'string' && d.memory.trim()
                      ? d.memory
                      : null,
                  memoryState:
                    d.memoryState && typeof d.memoryState === 'object'
                      ? d.memoryState
                      : null,
                  memoryRewriteDebug:
                    d.memoryRewriteDebug &&
                    typeof d.memoryRewriteDebug === 'object'
                      ? d.memoryRewriteDebug
                      : null,
                  updatedAtMs: Number.isFinite(
                    Date.parse(String(d.updatedAt || ''))
                  )
                    ? Date.parse(String(d.updatedAt || ''))
                    : null
                };
              })
              .catch(() => null)
          : Promise.resolve(null);
      const shouldLoadUserProfile =
        !isPrivateConversation && userId && userId !== 'u_anon';
      const userProfilePromise = shouldLoadUserProfile
        ? usersRef
            .child(String(userId))
            .once('value')
            .then((snap) => {
              const data = snap.val();
              return data && typeof data === 'object' ? data : {};
            })
            .catch(() => null)
        : Promise.resolve(null);
      markChatStage('request_normalized');
      throwIfCanceled();

      previousMemoryForCatch = previousMemory;

      // For non-private conversations, use the memory stored in Firebase (written by the previous turn).
      // Falls back to req.body.memory if Firebase has no memory yet (first turn).
      if (!isPrivateConversation && convMemoryPromise) {
        const convMemoryFromDb = await convMemoryPromise;
        if (convMemoryFromDb && typeof convMemoryFromDb === 'object') {
          if (
            typeof convMemoryFromDb.memory === 'string' &&
            convMemoryFromDb.memory.trim()
          ) {
            previousMemory = normalizeMemory(
              convMemoryFromDb.memory,
              activePromptRegistry
            );
            previousMemoryForCatch = previousMemory;
            hasPersistedConversationMemory = true;
          }
          previousMemoryState = normalizeMemoryStateShape(
            convMemoryFromDb.memoryState,
            '',
            Date.now()
          );
          previousMemoryRewriteDebug = convMemoryFromDb.memoryRewriteDebug;
          if (
            Number.isFinite(convMemoryFromDb.updatedAtMs) &&
            convMemoryFromDb.updatedAtMs > 0
          ) {
            previousConversationActivityMs = convMemoryFromDb.updatedAtMs;
          }
        }
      }
      if (isPrivateConversation && conversationId) {
        let cachedPrivateMemory = privateConversationMemoryCache.get(
          String(conversationId)
        );
        if (!cachedPrivateMemory) {
          cachedPrivateMemory = await readPrivateConversationMemory(conversationId);
          if (cachedPrivateMemory) {
            privateConversationMemoryCache.set(
              String(conversationId),
              cachedPrivateMemory
            );
          }
        }
        if (
          cachedPrivateMemory &&
          typeof cachedPrivateMemory.memory === 'string' &&
          cachedPrivateMemory.memory.trim()
        ) {
          previousMemory = normalizeMemory(
            cachedPrivateMemory.memory,
            activePromptRegistry
          );
          previousMemoryState = normalizeMemoryStateShape(
            cachedPrivateMemory.memoryState,
            '',
            Date.now()
          );
          previousMemoryRewriteDebug =
            cachedPrivateMemory.memoryRewriteDebug || null;
          hasPersistedConversationMemory = true;
          if (
            Number.isFinite(cachedPrivateMemory.updatedAt) &&
            cachedPrivateMemory.updatedAt > 0
          ) {
            previousConversationActivityMs = cachedPrivateMemory.updatedAt;
          }
          previousMemoryForCatch = previousMemory;
          previousMemoryRewriteDebugForCatch = previousMemoryRewriteDebug;
        }
      }
      if (
        isPrivateConversation !== true &&
        hasPersistedConversationMemory !== true
      ) {
        previousMemory = normalizeMemory('', activePromptRegistry);
        previousMemoryState = normalizeMemoryStateShape(null, '', Date.now());
        previousMemoryRewriteDebug = null;
        previousMemoryForCatch = previousMemory;
        previousMemoryRewriteDebugForCatch = null;

        logChatDecision('memory_seed_reset_non_private_without_db_memory', {
          conversationId,
          reason: 'no_persisted_memory'
        });
      }

      const recentHistoryCountForMemorySeed = Array.isArray(recentHistory)
        ? recentHistory.length
        : 0;
      if (
        isPrivateConversation === true &&
        recentHistoryCountForMemorySeed === 0 &&
        hasPersistedConversationMemory !== true
      ) {
        previousMemory = normalizeMemory('', activePromptRegistry);
        previousMemoryState = normalizeMemoryStateShape(null, '', Date.now());
        previousMemoryRewriteDebug = null;
        previousMemoryForCatch = previousMemory;
        previousMemoryRewriteDebugForCatch = null;

        logChatDecision('memory_first_turn_seed_reset', {
          conversationId,
          isPrivateConversation: isPrivateConversation === true,
          reason: 'no_persisted_memory'
        });
      }
      previousMemoryRewriteDebugForCatch = previousMemoryRewriteDebug;
      if (!isPrivateConversation && shouldLoadUserProfile) {
        let userData = await userProfilePromise;
        if (userData && userData.intersessionRefreshForced === true) {
          // Race condition guard: if intersessionRefreshForced, reload fresh from Firebase
          // to avoid using stale cached data from the initial userProfilePromise snapshot
          try {
            const freshSnap = await usersRef
              .child(String(userId))
              .once('value');
            userData =
              freshSnap.val() && typeof freshSnap.val() === 'object'
                ? freshSnap.val()
                : userData;
          } catch {
            // Fall back to cached userData if fresh fetch fails
          }
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
          const convSnap = await convRef.once('value');
          const convData = convSnap.val() || {};

          if (convData.titleLocked === true) {
            return;
          }

          const messagesSnap = await messagesRef
            .orderByChild('conversationId')
            .equalTo(conversationId)
            .once('value');

          const conversationMessages = Object.values(messagesSnap.val() || {})
            .filter((m) => m && typeof m.content === 'string')
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

          const userMessages = conversationMessages
            .filter((m) => m.role === 'user')
            .map((m) => String(m.content || '').trim())
            .filter(Boolean);

          if (userMessages.length === 0) {
            return;
          }

          const currentTitle = String(convData.title || '').trim();
          const firstUserMessage = userMessages[0] || '';

          const shouldGenerateTitle =
            !currentTitle ||
            currentTitle === 'Nouvelle conversation' ||
            currentTitle === 'Conversation sans titre' ||
            currentTitle === 'Conversation' ||
            currentTitle === firstUserMessage;

          if (!shouldGenerateTitle) {
            return;
          }

          let forbiddenTitles = Array.isArray(titleDenyList)
            ? titleDenyList.slice(0, 200)
            : [];

          try {
            const allConversationsSnap = await db
              .ref('conversations')
              .once('value');
            const allConversations = allConversationsSnap.val() || {};
            const titlesFromDb = Object.entries(allConversations)
              .filter(([id, value]) => {
                if (id === conversationId) return false;
                if (!value || typeof value !== 'object') return false;
                if (
                  typeof value.deletedAt === 'string' &&
                  value.deletedAt.trim()
                )
                  return false;
                return String(value.userId || '') === String(userId || '');
              })
              .map(([, value]) => String(value.title || '').trim())
              .filter(Boolean);

            forbiddenTitles = [...forbiddenTitles, ...titlesFromDb];
          } catch (denyErr) {
            console.warn(
              'Erreur chargement deny-list titres:',
              denyErr.message
            );
          }

          const generatedTitle = await generateConversationTitle(
            conversationMessages,
            {
              forbiddenTitles
            }
          );

          if (!generatedTitle || !generatedTitle.trim()) {
            return;
          }

          await convRef.update({
            title: generatedTitle.trim(),
            updatedAt: new Date().toISOString()
          });

          if (logsEnabledForCatch) {
            console.log(
              'AUTO TITLE UPDATED:',
              conversationId,
              '->',
              generatedTitle.trim()
            );
          }
        } catch (titleErr) {
          console.error('Erreur auto-title /chat:', titleErr.message);
        }
      }

      if (!isPrivateConversation) {
        const userMessagePushPromise = messagesRef.push({
          role: 'user',
          content: isEdited ? message + '\n[MODIFIÉ]' : message,
          timestamp: Date.now(),
          userId,
          conversationId
        });

        const conversationMetaUpdatePromise = convRef
          ? convRef.transaction((current) => {
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
            })
          : Promise.resolve(null);

        const [pushedRef] = await Promise.all([
          userMessagePushPromise,
          conversationMetaUpdatePromise
        ]);

        userMessagePersistedForCatch = true;
        userMessageRefForCatch = pushedRef;
      }

      const effectiveMailsEnabled =
        mailsEnabled !== false &&
        (adminMailsCacheReady ? getCachedAdminMailsEnabled() : false);
      const suppressAdminMailAlert = await shouldSuppressAdminEmailAlertForUser(
        req,
        userId
      );

      if (
        !isPrivateConversation &&
        emailNotifier.enabled &&
        effectiveMailsEnabled &&
        adminVisitedSinceLastAlert &&
        adminUiActive !== true &&
        !suppressAdminMailAlert
      ) {
        adminVisitedSinceLastAlert = false;
        emailNotifier.sendNewMessageAlert();
      }

      // Persist the assistant message and attach debug metadata.
      async function persistAssistantMessage(
        reply,
        debug,
        debugMeta = {},
        conversationState = null,
        messageId = null
      ) {
        if (isPrivateConversation) {
          return null;
        }

        const persistedMessageId =
          typeof messageId === 'string' && messageId.trim()
            ? messageId.trim()
            : messagesRef.push().key;

        if (!persistedMessageId) {
          throw new Error('Assistant message key generation failed');
        }

        await messagesRef.child(persistedMessageId).set({
          role: 'assistant',
          content: isEdited ? reply + '\n[MODIFIÉ]' : reply,
          timestamp: Date.now(),
          userId,
          conversationId,
          debug: Array.isArray(debug) ? debug : [],
          debugMeta: normalizeDebugMetaForStorage(
            debugMeta,
            activePromptRegistry
          ),
          stateSnapshot:
            conversationState && typeof conversationState === 'object'
              ? {
                  memory:
                    typeof conversationState.memory === 'string'
                      ? normalizeMemory(
                          conversationState.memory,
                          activePromptRegistry
                        )
                      : '',
                  memoryState:
                    conversationState.memoryState &&
                    typeof conversationState.memoryState === 'object'
                      ? conversationState.memoryState
                      : null,
                  flags: normalizeSessionFlags(conversationState.flags || {})
                }
              : null
        });

        assistantMessagePersistedForCatch = true;

        const conversationPatch = {
          updatedAt: new Date().toISOString()
        };

        if (typeof conversationState?.memory === 'string') {
          conversationPatch.memory = normalizeMemory(
            conversationState.memory,
            activePromptRegistry
          );
        }

        if (
          conversationState?.memoryState &&
          typeof conversationState.memoryState === 'object'
        ) {
          conversationPatch.memoryState = conversationState.memoryState;
        }

        if (
          conversationState?.flags &&
          typeof conversationState.flags === 'object'
        ) {
          conversationPatch.flags = normalizeSessionFlags(
            conversationState.flags
          );
        }

        await convRef.update(conversationPatch);

        return persistedMessageId;
      }

      // Fire-and-forget wrapper: generates a deterministic messageId synchronously,
      // then persists in background without blocking the response path.
      function persistAssistantMessageAsync(
        reply,
        debug,
        debugMeta = {},
        conversationState = null
      ) {
        if (isPrivateConversation) return null;
        const messageId = messagesRef.push().key;
        if (!messageId) {
          throw new Error('Assistant message key reservation failed');
        }
        persistAssistantMessage(
          reply,
          debug,
          debugMeta,
          conversationState,
          messageId
        ).catch((err) => {
          console.error(
            '[PERSIST_ASYNC][FAILED]',
            err && err.message ? err.message : String(err)
          );
        });
        return messageId;
      }

      function buildResponseDebugMeta(params) {
        const debugMeta = _buildResponseDebugMeta({
          ...params,
          pipelineStages: chatStageTimings,
          requestId,
          traceId,
          normalizeMemory: (m) =>
            normalizeMemory(m, params.promptRegistry || activePromptRegistry)
        });

        warnRuntimeContract('debugMeta', collectDebugMetaIssues(debugMeta), {
          traceId,
          requestId
        });

        return debugMeta;
      }

      const recentHistoryCount = Array.isArray(recentHistory)
        ? recentHistory.length
        : 0;
      const isFirstTurn = recentHistoryCount === 0;

      function waitMs(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      async function persistConversationMemoryWithRetry(
        memoryValue,
        promptRegistry,
        maxRetries = 2,
        memoryState = null,
        memoryRewriteDebug = null
      ) {
        if (!convRef || isPrivateConversation) return;

        const normalizedMemory = normalizeMemory(memoryValue, promptRegistry);
        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          try {
            await convRef.update({
              memory: normalizedMemory,
              memoryState:
                memoryState && typeof memoryState === 'object'
                  ? memoryState
                  : null,
              memoryRewriteDebug:
                memoryRewriteDebug && typeof memoryRewriteDebug === 'object'
                  ? memoryRewriteDebug
                  : null,
              updatedAt: new Date().toISOString()
            });
            return;
          } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
              await waitMs(120 * (attempt + 1));
            }
          }
        }

        throw lastError || new Error('memory_persist_retry_failed');
      }

      function scheduleBackgroundMemoryUpdate(memorySnapshot, replyText) {
        const backgroundMemoryTask = (async () => {
          try {
            // PRODUCT DECISION (memory audit baseline): memory update is intentionally non-blocking.
            // The user-facing reply must not wait for UPDATE_MEMORY/merge/persistence.
            // Consequence: debug memory can lag by one turn; this is expected behavior, not a defect.
            const updatedMemory = await updateMemory(
              memorySnapshot,
              [
                ...recentHistory,
                { role: 'user', content: message },
                { role: 'assistant', content: replyText }
              ],
              activePromptRegistry,
              'normal',
              '',
              null,
              previousMemoryState
            );
            const rawMem =
              typeof updatedMemory?.memoryText === 'string'
                ? updatedMemory.memoryText
                : memorySnapshot;

            const mergedStateResult = mergeMemoryStateWithFinalizedText({
              previousMemoryState,
              finalizedMemoryText: rawMem,
              deleteAncientMovementsById: Array.isArray(
                updatedMemory?.deleteAncientMovementsById
              )
                ? updatedMemory.deleteAncientMovementsById
                : [],
              nowMs: Date.now(),
              lastActivityMs: previousConversationActivityMs,
              ttlMs: MEMORY_INACTIVITY_TTL_MS
            });
            const persistedMemoryText = normalizeMemory(
              mergedStateResult.memoryText,
              activePromptRegistry
            );
            const crisisMemoryRewriteDebug = {
              beforeSanitization:
                typeof updatedMemory?.memoryBeforeSanitization === 'string'
                  ? normalizeMemory(
                      updatedMemory.memoryBeforeSanitization,
                      activePromptRegistry
                    )
                  : null,
              deletedAncientIds: Array.isArray(
                updatedMemory?.deleteAncientMovementsById
              )
                ? updatedMemory.deleteAncientMovementsById
                : [],
              source:
                typeof updatedMemory?.source === 'string'
                  ? updatedMemory.source
                  : null,
              capturedAt: new Date().toISOString()
            };

            if (isPrivateConversation && conversationId) {
              privateConversationMemoryCache.set(String(conversationId), {
                memory: persistedMemoryText,
                memoryState: mergedStateResult.memoryState,
                memoryRewriteDebug: crisisMemoryRewriteDebug,
                updatedAt: Date.now()
              });
              try {
                await persistPrivateConversationMemory(conversationId, {
                  memory: persistedMemoryText,
                  memoryState: mergedStateResult.memoryState,
                  memoryRewriteDebug: crisisMemoryRewriteDebug,
                  updatedAt: new Date().toISOString()
                });
              } catch (persistPrivateErr) {
                console.warn('[CHAT][PRIVATE_MEMORY_PERSIST_FAILED]', {
                  conversationId,
                  error:
                    persistPrivateErr && persistPrivateErr.message
                      ? persistPrivateErr.message
                      : String(persistPrivateErr)
                });
              }
              return;
            }

            await persistConversationMemoryWithRetry(
              persistedMemoryText,
              activePromptRegistry,
              2,
              mergedStateResult.memoryState,
              crisisMemoryRewriteDebug
            );
          } catch {
            // Non-bloquant : la reponse utilisateur ne depend pas de cette mise a jour memoire.
          } finally {
            await registerUsageConsumptionFromTurn();
          }
        })();

        if (conversationId) {
          trackConversationMemorySync(conversationId, backgroundMemoryTask);
        }
      }

      async function sendChatJsonResponse(
        reply,
        memory,
        flags,
        debug,
        debugMeta,
        botMessageId,
        signals
      ) {
        await registerUsageConsumptionFromTurn();
        maybeGenerateConversationTitle();
        publishChatProgressTerminal(requestId, 'done');

        return res.json({
          conversationId,
          reply,
          memory,
          flags,
          debug,
          debugMeta,
          botMessageId,
          signals
        });
      }

      function buildCrisisResponseDebugMeta({
        memory,
        suicideLevel,
        majorHarmRiskLevel = 'H0',
        majorHarmImminenceBand = 'none',
        majorHarmTargetsPeople = false,
        n2TurnType = null,
        emergencyNumbersIncluded = false,
        postCrisisSupportActive = false,
        emergencySupportText = null
      }) {
        return buildResponseDebugMeta({
          memory,
          suicideLevel,
          majorHarmRiskLevel,
          majorHarmImminenceBand,
          majorHarmTargetsPeople,
          conversationState: 'n2_crisis',
          isRecallRequest: false,
          explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
          explorationRelanceWindow: newFlags.explorationRelanceWindow,
          rewriteSource: null,
          memoryRewriteSource: null,
          modelConflict: false,
          promptRegistry: activePromptRegistry,
          n2TurnType,
          emergencyNumbersIncluded,
          postCrisisSupportActive,
          emergencySupportText
        });
      }

      function buildN2CrisisPostureDecision() {
        return {
          conversationState: 'n2_crisis',
          detectedState: 'n2_crisis',
          finalDirectivityLevel: 0,
          finalExplorationSignal: 'interpretation',
          intent: 'orienter vers les ressources de crise',
          forbidden: [
            'relance',
            'open_question',
            'exploration_hypothesis',
            'reflect'
          ],
          toneConstraint: 'contained',
          relancePolicy: 'forbidden',
          confidenceSignal: 1.0,
          relationalAdjustmentActive: false,
          interpretationRejectionModeActive: false,
          needsSoberReadjustment: false,
          humanFieldGuardActive: false,
          formalAddress: false
        };
      }

      function buildOverrideDebug(suicideLevel) {
        return buildDebug('override', {
          suicideLevel
        });
      }

      async function handleN2CrisisRoute() {
        newFlags.acuteCrisis = true;
        newFlags.crisisFollowupTurnCount = 0;
        newFlags.postCrisisSupportCarryTurn = false;
        newFlags.dischargeState = { wasDischarge: false };
        flagsForCatch = normalizeSessionFlags(newFlags);

        logChatDecision('override_n2', {
          acuteCrisisAfter: true
        });

        const debug = buildOverrideDebug('N2');

        let n2PromptRegistry = activePromptRegistry;
        try {
          const emergencyText = await resolveEmergencySupportText();
          if (emergencyText) {
            n2PromptRegistry = {
              ...activePromptRegistry,
              N2_RESPONSE_LLM: activePromptRegistry.N2_RESPONSE_LLM.replace(
                '{{EMERGENCY_NUMBERS}}',
                emergencyText
              )
            };
          }
        } catch {
          // Non-bloquant : on continue avec les numéros FR par défaut si la résolution échoue
        }

        let reply;
        let writerUsage = null;
        try {
          const n2Result = await generateReply({
            message,
            history: recentHistory,
            memory: previousMemory,
            postureDecision: buildN2CrisisPostureDecision(),
            promptRegistry: n2PromptRegistry,
            onTokenCallback: onTokenCallbackForChat
          });
          reply = n2Result.reply;
          writerUsage = n2Result.usage || null;
        } catch {
          reply = n2Response();
        }
        await registerUsageConsumptionFromTurn({ writerUsage });

        const responseMemory = previousMemory;
        scheduleBackgroundMemoryUpdate(previousMemory, reply);

        const responseDebugMeta = buildCrisisResponseDebugMeta({
          memory: responseMemory,
          suicideLevel: 'N2',
          n2TurnType: null,
          emergencyNumbersIncluded: true,
          postCrisisSupportActive: false,
          emergencySupportText: null
        });

        const botMessageId = persistAssistantMessageAsync(
          reply,
          debug,
          responseDebugMeta,
          { memory: responseMemory, flags: newFlags }
        );
        return sendChatJsonResponse(
          reply,
          responseMemory,
          newFlags,
          debug,
          responseDebugMeta,
          botMessageId,
          'état:n2_crisis'
        );
      }

      async function handleAcuteCrisisFollowupRoute() {
        newFlags.acuteCrisis = true;
        newFlags.postCrisisSupportCarryTurn = true;
        newFlags.dischargeState = { wasDischarge: false };
        flagsForCatch = normalizeSessionFlags(newFlags);

        logChatDecision('override_acute_crisis_followup', {
          suicideLevel: suicide.suicideLevel,
          crisisResolved: false
        });

        const debug = buildOverrideDebug(suicide.suicideLevel);
        const n2TurnType = classifyN2TurnType(message);
        const crisisFollowupTurnCount = Number.isInteger(
          flags.crisisFollowupTurnCount
        )
          ? flags.crisisFollowupTurnCount
          : 0;
        const includeNumbers = false;
        newFlags.crisisFollowupTurnCount = crisisFollowupTurnCount + 1;

        const followupEmergencyText = await resolveEmergencySupportText();

        let reply;
        let writerUsage = null;
        try {
          reply = await acuteCrisisFollowupResponseLLM({
            message,
            history: recentHistory,
            turnType: n2TurnType,
            includeNumbers,
            emergencyText: followupEmergencyText,
            promptRegistry: activePromptRegistry
          });
        } catch {
          reply = acuteCrisisFollowupResponse();
        }

        await registerUsageConsumptionFromTurn({ writerUsage });

        const responseMemory = previousMemory;
        scheduleBackgroundMemoryUpdate(previousMemory, reply);

        const responseDebugMeta = buildCrisisResponseDebugMeta({
          memory: responseMemory,
          suicideLevel: suicide.suicideLevel,
          n2TurnType,
          emergencyNumbersIncluded: includeNumbers,
          postCrisisSupportActive: true,
          emergencySupportText: followupEmergencyText
        });

        const botMessageId = persistAssistantMessageAsync(
          reply,
          debug,
          responseDebugMeta,
          { memory: responseMemory, flags: newFlags }
        );
        return sendChatJsonResponse(
          reply,
          responseMemory,
          newFlags,
          debug,
          responseDebugMeta,
          botMessageId,
          'état:n2_crisis'
        );
      }

      async function handleImminentMajorHarmRoute(safety) {
        newFlags.acuteCrisis = false;
        newFlags.postCrisisSupportCarryTurn = false;
        newFlags.dischargeState = { wasDischarge: false };
        flagsForCatch = normalizeSessionFlags(newFlags);

        logChatDecision('override_major_harm', {
          harmRiskLevel: safety?.harmRiskLevel || 'H0',
          imminenceBand: safety?.imminenceBand || 'none',
          targetsPeople: safety?.targetsPeople === true,
          isSelfDefenseClaimed: safety?.isSelfDefenseClaimed === true
        });

        const debug = buildOverrideDebug(suicide?.suicideLevel || 'N0');

        let reply;
        let writerUsage = null;
        try {
          reply = await imminentMajorHarmResponseLLM(
            message,
            recentHistory,
            activePromptRegistry,
            onTokenCallbackForChat
          );
        } catch {
          reply =
            "Je ne peux pas t'aider \u00e0 pr\u00e9parer ou commettre une action qui met des personnes en danger. Cela peut avoir de lourdes cons\u00e9quences p\u00e9nales et humaines, pour toi comme pour les personnes vis\u00e9es. Qu'est-ce qui se passe en toi juste avant cette mont\u00e9e vers le passage \u00e0 l'acte ?";
        }

        await registerUsageConsumptionFromTurn({ writerUsage });

        const responseMemory = previousMemory;
        scheduleBackgroundMemoryUpdate(previousMemory, reply);

        const responseDebugMeta = buildResponseDebugMeta({
          memory: responseMemory,
          suicideLevel: suicide?.suicideLevel || 'N0',
          majorHarmRiskLevel: safety?.harmRiskLevel || 'H0',
          majorHarmImminenceBand: safety?.imminenceBand || 'none',
          majorHarmTargetsPeople: safety?.targetsPeople === true,
          conversationState: 'exploration_restrained',
          isRecallRequest: false,
          explorationDirectivityLevel: 3,
          explorationRelanceWindow: newFlags.explorationRelanceWindow,
          rewriteSource: null,
          memoryRewriteSource: null,
          modelConflict: false,
          promptRegistry: activePromptRegistry
        });

        const botMessageId = persistAssistantMessageAsync(
          reply,
          debug,
          responseDebugMeta,
          { memory: responseMemory, flags: newFlags }
        );
        return sendChatJsonResponse(
          reply,
          responseMemory,
          newFlags,
          debug,
          responseDebugMeta,
          botMessageId,
          'securite:risque_majeur_imminent'
        );
      }

      async function analyzeSafetyAndBuildCrisisPrelude() {
        markChatStage('safety_analysis');
        const [safety, suicide] = await Promise.all([
          analyzeImminentMajorHarmRisk(
            message,
            recentHistory,
            activePromptRegistry
          ),
          analyzeSuicideRisk(message, recentHistory, flags, activePromptRegistry)
        ]);
        throwIfCanceled();

        logChatDecision('major_harm_analysis_result', {
          harmRiskLevel: safety?.harmRiskLevel || 'H0',
          imminenceBand: safety?.imminenceBand || 'none',
          targetsPeople: safety?.targetsPeople === true,
          needsImmediateSafetyFrame: safety?.needsImmediateSafetyFrame === true,
          isSelfDefenseClaimed: safety?.isSelfDefenseClaimed === true
        });

        logChatDecision('suicide_analysis_result', {
          suicideLevel: suicide.suicideLevel,
          needsClarification: suicide.needsClarification === true,
          crisisResolved: suicide.crisisResolved === true,
          acuteCrisisBefore: flags.acuteCrisis === true
        });
        suicideLevelForCatch = suicide.suicideLevel;

        const nextFlags = normalizeSessionFlags(flags);
        nextFlags.explorationCalibrationLevel = 0;

        const safetyDecision = buildSafetyRoutingDecision({
          safety,
          suicide,
          flags
        });
        const crisisDecision = buildCrisisRoutingDecision(suicide, flags);

        if (safetyDecision.route === 'major_harm') {
          logChatDecision('priority_rule_selected', {
            phase: 'post_safety',
            ruleId: safetyDecision.ruleId,
            priority: safetyDecision.priority,
            safetyImminence: safetyDecision.safetyImminence,
            suicideImminence: safetyDecision.suicideImminence
          });
        } else if (crisisDecision.route) {
          logChatDecision('priority_rule_selected', {
            phase: 'post_suicide',
            ruleId: crisisDecision.ruleId,
            priority: crisisDecision.priority
          });
        }

        return {
          safety,
          safetyDecision,
          suicide,
          crisisDecision,
          newFlags: nextFlags
        };
      }

      function handleResolvedAcuteCrisisState() {
        const postCrisisSupportCarryTurnActive =
          flags.postCrisisSupportCarryTurn === true &&
          crisisDecision.route !== 'n1_clarification';
        newFlags.acuteCrisis = false;
        newFlags.postCrisisSupportCarryTurn = false;
        flagsForCatch = normalizeSessionFlags(newFlags);
        logChatDecision('acute_crisis_resolved', {
          suicideLevel: suicide.suicideLevel,
          postCrisisSupportCarryTurnActive
        });

        req.__postCrisisSupportCarryTurnActive =
          postCrisisSupportCarryTurnActive;
      }

      function logN1PipelineEntry() {
        logChatDecision('n1_entering_pipeline', {
          suicideLevel: suicide.suicideLevel,
          needsClarification: suicide.needsClarification === true
        });
      }

      function getStoredIntersessionCompact(userData) {
        if (!userData || typeof userData !== 'object') {
          return '';
        }

        const compactStored =
          typeof userData.intersessionMemoryCompact === 'string'
            ? userData.intersessionMemoryCompact.trim()
            : '';
        if (compactStored) {
          return compactStored;
        }

        const source = normalizeIntersessionSourceFromUserData(
          userData,
          buildDefaultPromptRegistry()
        );
        return buildIntersessionCompactRuntime(source).trim();
      }

      function appendIntersessionFailureNote(compactText = '') {
        const base =
          String(compactText || '').trim() || INTERSESSION_COMPACT_EMPTY_NOTE;
        if (base.includes('Derniere mise a jour memoire echouee.')) {
          return base;
        }
        return `${base}\n${INTERSESSION_COMPACT_FAILURE_NOTE}`;
      }

      async function runIntersessionCompactAttempt(
        memorySource,
        timeoutMs = 10000
      ) {
        const defaults = buildDefaultPromptRegistry();
        const systemPrompt = String(
          activePromptRegistry.COMPACT_INTERSESSION_RUNTIME_MEMORY ||
            defaults.COMPACT_INTERSESSION_RUNTIME_MEMORY ||
            ''
        ).trim();
        const source = String(memorySource || '').trim();
        const userPrompt = `
[MEMOIRE_INTERSESSION_SOURCE]
${source || '(vide)'}

[CONTRAT]
Reponds strictement en JSON: {"items": ["..."]}
`;

        let timeoutHandle = null;
        const requestPromise = client.chat.completions.create({
          model: MODEL_IDS.analysis,
          max_completion_tokens: 500,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        });

        const timeoutPromise = new Promise((_, reject) => {
          timeoutHandle = setTimeout(
            () => {
              reject(new Error(`intersession_compact_timeout_${timeoutMs}ms`));
            },
            Math.max(1000, timeoutMs)
          );
        });

        try {
          const response = await Promise.race([requestPromise, timeoutPromise]);
          const raw = String(
            response?.choices?.[0]?.message?.content || ''
          ).trim();
          const items = extractRuntimeCompactItems(raw);
          const finishReason =
            typeof response?.choices?.[0]?.finish_reason === 'string'
              ? response.choices[0].finish_reason
              : null;

          if (!raw) {
            throw new Error('intersession_compact_empty_output');
          }

          if (!Array.isArray(items)) {
            throw new Error('intersession_compact_invalid_items');
          }

          return {
            ok: true,
            items,
            raw,
            finishReason,
            model: typeof response?.model === 'string' ? response.model : null
          };
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      }

      async function getFreshUserDataIfRefreshForced(userData) {
        if (!userData || userData.intersessionRefreshForced !== true) {
          return userData;
        }

        try {
          const freshSnap = await usersRef.child(String(userId)).once('value');
          return freshSnap.val() && typeof freshSnap.val() === 'object'
            ? freshSnap.val()
            : userData;
        } catch {
          // Fall back to cached userData if fresh fetch fails.
          return userData;
        }
      }

      async function loadCurrentUserIntersessionMemory() {
        const cachedUserData = await userProfilePromise;
        const userData = await getFreshUserDataIfRefreshForced(cachedUserData);
        return getStoredIntersessionCompact(userData);
      }

      async function prepareIntersessionMemoryForTurn(flagsSnapshot) {
        if (!userId || userId === 'u_anon' || isPrivateConversation === true) {
          return {
            intersessionMemoryForThisTurn: '',
            intersessionMemoryRuntime: '',
            nextTurnsUntilIntersessionRefresh: Number.isInteger(
              flagsSnapshot?.turnsUntilIntersessionRefresh
            )
              ? Math.max(0, flagsSnapshot.turnsUntilIntersessionRefresh)
              : 0
          };
        }

        const currentTurnsUntil = Number.isInteger(
          flagsSnapshot?.turnsUntilIntersessionRefresh
        )
          ? flagsSnapshot.turnsUntilIntersessionRefresh
          : 0;
        const cachedUserData = await userProfilePromise;
        const userData = await getFreshUserDataIfRefreshForced(cachedUserData);
        const source = normalizeIntersessionSourceFromUserData(
          userData,
          buildDefaultPromptRegistry()
        );
        const storedCompact = getStoredIntersessionCompact(userData);
        const compactMissing = !storedCompact;
        const outdated = userData?.intersessionCompactOutdated === true;
        const forcedByManualEdit = userData?.intersessionRefreshForced === true;
        const mustRefreshCompact =
          compactMissing || outdated || forcedByManualEdit;

        let runtimeCompact =
          storedCompact ||
          (source ? buildIntersessionCompactRuntime(source).trim() : '');

        if (mustRefreshCompact) {
          const refreshReason = compactMissing
            ? 'compact_missing'
            : forcedByManualEdit
              ? 'manual_edit_force'
              : 'outdated_flag';

          console.info('[INTERSESSION_COMPACT_REFRESH_START]', {
            userId,
            reason: refreshReason,
            compactMissing,
            outdated,
            forcedByManualEdit
          });

          const attempts = [];
          let successPayload = null;
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            const startedAtMs = Date.now();
            try {
              const attemptResult = await runIntersessionCompactAttempt(
                source,
                10000
              );
              const durationMs = Date.now() - startedAtMs;
              attempts.push({
                attempt,
                status: 'success',
                durationMs,
                finishReason: attemptResult.finishReason || null,
                itemCount: Array.isArray(attemptResult.items)
                  ? attemptResult.items.length
                  : 0
              });
              console.info('[INTERSESSION_COMPACT_ATTEMPT]', {
                userId,
                attempt,
                status: 'success',
                durationMs,
                finishReason: attemptResult.finishReason || null,
                itemCount: Array.isArray(attemptResult.items)
                  ? attemptResult.items.length
                  : 0
              });
              successPayload = attemptResult;
              break;
            } catch (error) {
              const durationMs = Date.now() - startedAtMs;
              const message =
                error && error.message ? error.message : String(error);
              attempts.push({
                attempt,
                status: 'failed',
                durationMs,
                error: message
              });
              console.warn('[INTERSESSION_COMPACT_ATTEMPT]', {
                userId,
                attempt,
                status: 'failed',
                durationMs,
                error: message
              });
            }
          }

          if (successPayload) {
            runtimeCompact = formatRuntimeCompactMemory(successPayload.items);
            try {
              await usersRef.child(userId).update({
                intersessionMemoryCompact: runtimeCompact,
                intersessionCompactOutdated: false,
                intersessionRefreshForced: false
              });
            } catch (error) {
              console.warn('[INTERSESSION_COMPACT_PERSIST_FAILED]', {
                userId,
                error: error && error.message ? error.message : String(error)
              });
            }

            console.info('[INTERSESSION_COMPACT_REFRESH_RESULT]', {
              userId,
              status: 'success',
              attempts: attempts.length,
              itemCount: Array.isArray(successPayload.items)
                ? successPayload.items.length
                : 0
            });
          } else {
            runtimeCompact = appendIntersessionFailureNote(storedCompact || '');
            console.error('[INTERSESSION_COMPACT_FALLBACK_USED]', {
              userId,
              status: 'fallback',
              attempts: attempts.length,
              keptOutdated: true,
              injectedFailureNote: true
            });
          }
        }

        const safeRuntimeCompact =
          String(runtimeCompact || '').trim() ||
          INTERSESSION_COMPACT_EMPTY_NOTE;
        console.info('[INTERSESSION_LONGTERM_INJECTION]', {
          userId,
          hasFailureNote: safeRuntimeCompact.includes(
            'Derniere mise a jour memoire echouee.'
          ),
          compactLength: safeRuntimeCompact.length
        });

        return {
          intersessionMemoryForThisTurn: safeRuntimeCompact,
          intersessionMemoryRuntime: safeRuntimeCompact,
          nextTurnsUntilIntersessionRefresh: Math.max(0, currentTurnsUntil - 1)
        };
      }

      let emergencySupportTextPromise = null;
      async function resolveEmergencySupportText() {
        if (emergencySupportTextPromise) {
          return emergencySupportTextPromise;
        }

        emergencySupportTextPromise = (async () => {
          try {
            let userCountryCode = null;
            const userData = await userProfilePromise;
            if (userData && typeof userData.country === 'string') {
              userCountryCode = normalizeCountryCode(userData.country);
            }
            const emergencyInfo =
              lookupEmergencyNumbers(userCountryCode) ||
              lookupEmergencyNumbers('FR');
            return buildEmergencyNumbersText(emergencyInfo) || null;
          } catch {
            return null;
          }
        })();

        return emergencySupportTextPromise;
      }

      // 1) Analyse securite : risque majeur imminent et risque suicidaire.
      // Cette étape peut déclencher des réponses priorisées sans aller plus loin.
      const crisisPrelude = await analyzeSafetyAndBuildCrisisPrelude();
      const safety = crisisPrelude.safety;
      const safetyDecision = crisisPrelude.safetyDecision;
      const suicide = crisisPrelude.suicide;
      const crisisDecision = crisisPrelude.crisisDecision;
      let newFlags = crisisPrelude.newFlags;

      if (safetyDecision.route === 'major_harm') {
        return handleImminentMajorHarmRoute(safety);
      }

      // Severe suicide risk override path.
      // If the analysis returns N2, we bypass normal generation and reply with a crisis response.
      if (crisisDecision.route === 'n2') {
        return handleN2CrisisRoute();
      }

      // 2) Crisis follow-up path for an already active acute crisis.
      // If the crisis is not resolved, keep the bot in crisis-handling mode.
      if (flags.acuteCrisis === true) {
        if (crisisDecision.route === 'acute_followup') {
          return handleAcuteCrisisFollowupRoute();
        }

        handleResolvedAcuteCrisisState();
      }

      // 3) N1 signal flows into the main pipeline.
      // "n1_crisis" is enforced inside buildPostureDecision.
      if (crisisDecision.route === 'n1_clarification') {
        logN1PipelineEntry();
      }

      const intersessionMemoryPreparationPromise =
        prepareIntersessionMemoryForTurn(newFlags);
      const intersessionFallbackSeedPromise = (async () => {
        if (isPrivateConversation === true || !userId || userId === 'u_anon') {
          return '';
        }
        const userData = await userProfilePromise;
        return getStoredIntersessionCompact(userData);
      })();
      const shortAffiliationValidationPromise = hasShortAffiliationMarker(
        message
      )
        ? withAnalyzerTiming(
            'affiliation_short_validation',
            analyzeAffiliationShortValidationCoherence(
              message,
              recentHistory,
              activePromptRegistry
            )
          )
        : Promise.resolve({ shortValidationConfirmed: true });

      // 2) Analyse de rappel memoire : identifier si l'utilisateur demande
      // explicitement un rappel conversationnel et quelle memoire mobiliser.
      markChatStage('recall_analysis');
      const recallRoutingPromise = (async () => {
        const recallIntersessionMemory =
          await loadCurrentUserIntersessionMemory();
        return analyzeRecallRouting(
          message,
          recentHistory,
          previousMemory,
          recallIntersessionMemory,
          activePromptRegistry
        );
      })();
      const recallBranchHistoryPromise = recallRoutingPromise.then(
        async (resolvedRecallRouting) => {
          if (resolvedRecallRouting?.isLongTermMemoryRecall !== true) {
            return [];
          }

          return loadConversationBranchHistoryForRecall({
            conversationId,
            isPrivateConversation,
            conversationBranchHistory,
            recentHistory
          });
        }
      );

      // Phase 2: run all analyzers in parallel, including proposeState (which now
      // integrates contact detection alongside info detection).
      markChatStage('mode_analysis');
      throwIfCanceled();

      const effectiveExplorationDirectivityLevel =
        newFlags.explorationDirectivityLevel;

      let finalDirectivityLevel = effectiveExplorationDirectivityLevel;
      let finalExplorationSignal = 'interpretation';
      const currentAttentionQualityTurnsUntilRefresh = Number.isInteger(
        newFlags.attentionQualityTurnsUntilRefresh
      )
        ? Math.max(0, newFlags.attentionQualityTurnsUntilRefresh)
        : 0;
      const shouldRunAttentionQuality =
        currentAttentionQualityTurnsUntilRefresh === 0;

      const currentDependencyAnalysisTurnsUntilRefresh = Number.isInteger(
        newFlags.dependencyAnalysisTurnsUntilRefresh
      )
        ? Math.max(0, newFlags.dependencyAnalysisTurnsUntilRefresh)
        : 0;
      const shouldRunDependencyAnalysis =
        currentDependencyAnalysisTurnsUntilRefresh === 0;

      // withAnalyzerTiming wraps each Promise to record individual analyzer durations in chatStageTimings.
      function withAnalyzerTiming(name, promise) {
        const t = Date.now();
        return promise.then((result) => {
          chatStageTimings.push({
            stage: `analyzer_${name}`,
            deltaMs: Date.now() - t
          });
          return result;
        });
      }
      async function runPrimaryAnalyzers() {
        const [
          stateProposal,
          closureIntentAnalysis,
          allianceRuptureAnalysis,
          relationalAdjustmentAnalysis,
          technicalContextAnalysis,
          userRegisterAnalysis,
          emotionalDecenteringResult,
          attentionAnalysis,
          dependencyRiskAnalysis
        ] = await Promise.all([
          withAnalyzerTiming(
            'propose_state',
            proposeState(
              message,
              recentHistory,
              newFlags.dischargeState,
              activePromptRegistry
            )
          ),
          withAnalyzerTiming('closure_intent', analyzeClosureIntent(message)),
          withAnalyzerTiming(
            'alliance_rupture',
            analyzeAllianceRupture(message, recentHistory, activePromptRegistry)
          ),
          withAnalyzerTiming(
            'relational_adjustment',
            analyzeRelationalAdjustmentNeed(
              message,
              recentHistory,
              previousMemory,
              false,
              activePromptRegistry
            )
          ),
          withAnalyzerTiming(
            'technical_context',
            analyzeTechnicalContext(message)
          ),
          withAnalyzerTiming('user_register', analyzeUserRegister(message)),
          withAnalyzerTiming(
            'emotional_decentering',
            analyzeEmotionalDecentering(message, recentHistory)
          ),
          shouldRunAttentionQuality
            ? withAnalyzerTiming(
                'attention_quality',
                analyzeAttentionQuality(
                  message,
                  recentHistory,
                  activePromptRegistry
                )
              )
            : Promise.resolve(null),
          shouldRunDependencyAnalysis
            ? withAnalyzerTiming(
                'dependency_risk',
                (async () => {
                  const depIntersessionMemory =
                    await loadCurrentUserIntersessionMemory();
                  return analyzeDependencyRisk(
                    message,
                    recentHistory,
                    depIntersessionMemory,
                    activePromptRegistry
                  );
                })()
              )
            : Promise.resolve(null)
        ]);

        return {
          stateProposal,
          closureIntentAnalysis,
          allianceRuptureAnalysis,
          relationalAdjustmentAnalysis,
          technicalContextAnalysis,
          userRegisterAnalysis,
          emotionalDecenteringResult,
          attentionAnalysis,
          dependencyRiskAnalysis
        };
      }

      const {
        stateProposal,
        closureIntentAnalysis,
        allianceRuptureAnalysis,
        relationalAdjustmentAnalysis,
        technicalContextAnalysis,
        userRegisterAnalysis,
        emotionalDecenteringResult,
        attentionAnalysis,
        dependencyRiskAnalysis
      } = await runPrimaryAnalyzers();
      throwIfCanceled();

      newFlags.closureIntent = closureIntentAnalysis?.closureIntent === true;

      warnRuntimeContract(
        'stateProposal',
        collectStateProposalIssues(stateProposal),
        {
          traceId,
          requestId
        }
      );

      newFlags.attentionQualityTurnsUntilRefresh = shouldRunAttentionQuality
        ? 3
        : Math.max(0, currentAttentionQualityTurnsUntilRefresh - 1);

      // C2 - mise a jour du score de dependance si l'analyzer a tourne ce tour.
      // Gate discharge : on n'incremente jamais en etat de decharge, decrements autorises.
      if (shouldRunDependencyAnalysis && dependencyRiskAnalysis) {
        const isInDischarge =
          newFlags.dischargeState?.wasDischarge === true ||
          String(newFlags.conversationState || '').startsWith('discharge_');
        const blockIncrements =
          isInDischarge ||
          dependencyRiskAnalysis.contextIsHyperbolicDischarge === true;

        const DELTA = {
          strong: { up: 10, down: -12 },
          present: { up: 4, down: -6 },
          absent: { up: 0, down: 0 }
        };

        let isoScore = newFlags.isolationScore;
        let attScore = newFlags.attachmentScore;

        if (!blockIncrements) {
          isoScore += DELTA[dependencyRiskAnalysis.isolationSignal]?.up || 0;
          attScore += DELTA[dependencyRiskAnalysis.attachmentSignal]?.up || 0;
        }
        isoScore +=
          DELTA[dependencyRiskAnalysis.isolationCounterSignal]?.down || 0;
        attScore +=
          DELTA[dependencyRiskAnalysis.attachmentCounterSignal]?.down || 0;

        newFlags.isolationScore = Math.max(
          0,
          Math.min(100, Math.round(isoScore))
        );
        newFlags.attachmentScore = Math.max(
          0,
          Math.min(100, Math.round(attScore))
        );
        newFlags.dependencyRiskScore = Math.round(
          (newFlags.isolationScore + newFlags.attachmentScore) / 2
        );
        newFlags.dependencyRiskLevel =
          newFlags.dependencyRiskScore <= 30
            ? 'low'
            : newFlags.dependencyRiskScore <= 65
              ? 'medium'
              : 'high';

        // Dependency care message trigger (x1/convo, 66+ absorbe 31+ si saut direct).
        // On utilise currentFlags pour lire l'�tat AVANT ce tour � les newFlags viennent d'�tre calcul�s.
        const _careTriggered = flags.dependencyCareTriggered || 'none';
        if (
          newFlags.dependencyRiskLevel === 'high' &&
          _careTriggered !== 'high'
        ) {
          newFlags.dependencyCareTriggered = 'high';
          newFlags.dependencyCareMessagePending = 'high';
          newFlags.dependencyCareMessagePendingTurns = 0;
        } else if (
          newFlags.dependencyRiskLevel === 'medium' &&
          _careTriggered === 'none'
        ) {
          newFlags.dependencyCareTriggered = 'medium';
          newFlags.dependencyCareMessagePending = 'medium';
          newFlags.dependencyCareMessagePendingTurns = 0;
        }
      }
      newFlags.dependencyAnalysisTurnsUntilRefresh = shouldRunDependencyAnalysis
        ? 4
        : Math.max(0, currentDependencyAnalysisTurnsUntilRefresh - 1);

      // C3 arbitrage : �lit l'�tat actif depuis les candidats C2 (discharge > info > exploration).
      // nonElectedCandidates[0] est le candidat C2 non-�lu le plus fort (confiance >= medium) ;
      // il sera pass� � buildPostureDecision comme tension secondaire candidate.
      const electedState = electActiveStateFromCandidates(
        stateProposal.stateCandidates,
        stateProposal.contactAnalysis
      );
      const secondaryTension =
        (electedState.nonElectedCandidates &&
          electedState.nonElectedCandidates[0]) ||
        null;

      // Phase 2b: exploration calibration stays exploration-only.
      // Interpretation rejection/readjustment is also available in info states.
      let calibrationAnalysis;
      let interpretationRejection;
      if (electedState.detectedState === 'exploration') {
        [calibrationAnalysis, interpretationRejection] = await Promise.all([
          withAnalyzerTiming(
            'exploration_calibration',
            analyzeExplorationCalibration({
              message,
              history: recentHistory,
              memory: previousMemory,
              explorationDirectivityLevel: effectiveExplorationDirectivityLevel,
              explorationRelanceWindow: newFlags.explorationRelanceWindow,
              promptRegistry: activePromptRegistry
            })
          ),
          withAnalyzerTiming(
            'interpretation_rejection',
            analyzeInterpretationRejection({
              message,
              history: recentHistory,
              memory: previousMemory,
              promptRegistry: activePromptRegistry
            })
          )
        ]);
      } else if (
        typeof electedState.detectedState === 'string' &&
        electedState.detectedState.startsWith('info_')
      ) {
        calibrationAnalysis = {
          calibrationLevel: effectiveExplorationDirectivityLevel,
          explorationSignal: 'interpretation'
        };
        interpretationRejection = await withAnalyzerTiming(
          'interpretation_rejection',
          analyzeInterpretationRejection({
            message,
            history: recentHistory,
            memory: previousMemory,
            promptRegistry: activePromptRegistry
          })
        );
      } else {
        calibrationAnalysis = {
          calibrationLevel: effectiveExplorationDirectivityLevel,
          explorationSignal: 'interpretation'
        };
        interpretationRejection = {
          isInterpretationRejection: false,
          relationalFrictionSignal: 'none',
          rejectsUnderlyingPhenomenon: false
        };
      }
      throwIfCanceled();

      const emotionalDecenteringAnalysis = emotionalDecenteringResult || {
        emotionalDecentering: false
      };

      const contactAnalysis = electedState.contactAnalysis;
      const dischargeAnalysis = electedState.dischargeAnalysis;
      const detectedState = electedState.detectedState;
      const explorationAnalysis =
        stateProposal && typeof stateProposal.explorationAnalysis === 'object'
          ? stateProposal.explorationAnalysis
          : { everydayConcreteShare: false, lowContextOpening: false };
      newFlags.dischargeState = {
        wasDischarge:
          typeof detectedState === 'string' &&
          detectedState.startsWith('discharge_')
      };

      const detectedPsychoeducationType =
        detectedState === 'info_psychoeducation'
          ? electedState.psychoeducationType || null
          : null;
      const detectedInfoContextFlags =
        detectedState === 'info_features'
          ? Array.isArray(electedState.infoContextFlags)
            ? electedState.infoContextFlags
            : []
          : [];

      // Source de routage info pour observabilit? admin
      let infoRoutingSource = null;
      const tieBreakReason =
        typeof electedState.tieBreakReason === 'string'
          ? electedState.tieBreakReason
          : null;
      if (
        typeof detectedState === 'string' &&
        detectedState.startsWith('info_')
      ) {
        const src = electedState.infoSource;
        const subSrc = electedState.infoSignalSource;
        if (src === 'deterministic_app_features') {
          infoRoutingSource = 'd?terministe';
        } else if (src === 'llm_fallback') {
          infoRoutingSource = 'LLM (fallback)';
        } else if (subSrc === 'llm_fallback') {
          infoRoutingSource = 'LLM / signal fallback';
        } else {
          infoRoutingSource = 'LLM';
        }
      }
      const interpretationAvailableInState =
        detectedState === 'exploration' ||
        (typeof detectedState === 'string' &&
          detectedState.startsWith('info_'));
      const safeInterpretationRejection = interpretationAvailableInState
        ? interpretationRejection || {
            isInterpretationRejection: false,
            relationalFrictionSignal: 'none'
          }
        : {
            isInterpretationRejection: false,
            relationalFrictionSignal: 'none'
          };

      modeForCatch = detectedState;

      // Affiliation scoring: short lexical markers need contextual confirmation (LLM).
      const shortValidationAnalysis = await shortAffiliationValidationPromise;
      const shortValidationConfirmed =
        shortValidationAnalysis.shortValidationConfirmed === true;

      const affiliationDetails = computeAffiliationTurnDetails(message, {
        shortValidationConfirmed,
        attachmentLevel: deriveAttachmentLevelFromScore(
          newFlags.attachmentScore
        ),
        attachmentBoostStreak: newFlags.affiliationAttachmentBoostStreak
      });
      const previousAffiliationScore =
        Array.isArray(newFlags.affiliationWindow) &&
        newFlags.affiliationWindow.length > 0
          ? Number(
              newFlags.affiliationWindow[newFlags.affiliationWindow.length - 1]
            )
          : null;
      const previousAffiliationFinalScore = computeAffiliationFinalScore(
        Array.isArray(newFlags.affiliationWindow)
          ? newFlags.affiliationWindow
          : []
      );
      const previousAffiliationEstablished = computeAffiliationEstablished(
        Array.isArray(newFlags.affiliationWindow)
          ? newFlags.affiliationWindow
          : []
      );
      const currentAllianceSignalForAffiliation = normalizeAllianceState(
        allianceRuptureAnalysis?.allianceSignal || newFlags.allianceSignal
      );
      const AFFILIATION_MAX_DROP_PER_TURN = 0.2;
      const AFFILIATION_ESTABLISHED_FLOOR = 0.41;

      let affiliationScore = affiliationDetails.score;
      if (
        currentAllianceSignalForAffiliation !== 'rupture' &&
        Number.isFinite(previousAffiliationScore)
      ) {
        const minAllowedScore = Math.max(
          0,
          previousAffiliationScore - AFFILIATION_MAX_DROP_PER_TURN
        );
        if (affiliationScore < minAllowedScore) {
          const rawAffiliationScore = affiliationScore;
          affiliationScore = minAllowedScore;
          logChatDecision('affiliation_drop_limited', {
            allianceSignal: currentAllianceSignalForAffiliation,
            previousAffiliationScore,
            rawAffiliationScore,
            minAllowedScore,
            appliedAffiliationScore: affiliationScore,
            maxDropPerTurn: AFFILIATION_MAX_DROP_PER_TURN
          });
        }
      }

      if (
        currentAllianceSignalForAffiliation !== 'rupture' &&
        secondaryTension?.family !== 'alliance_rupture' &&
        previousAffiliationEstablished === true &&
        affiliationScore < AFFILIATION_ESTABLISHED_FLOOR
      ) {
        const rawAffiliationScore = affiliationScore;
        affiliationScore = AFFILIATION_ESTABLISHED_FLOOR;
        logChatDecision('affiliation_established_floor_applied', {
          allianceSignal: currentAllianceSignalForAffiliation,
          previousAffiliationFinalScore,
          previousAffiliationEstablished,
          rawAffiliationScore,
          affiliationEstablishedFloor: AFFILIATION_ESTABLISHED_FLOOR,
          appliedAffiliationScore: affiliationScore
        });
      }

      newFlags.affiliationAttachmentBoostStreak =
        affiliationDetails.nextAttachmentBoostStreak;
      const newAffiliationWindow = normalizeAffiliationWindow([
        ...(newFlags.affiliationWindow || []),
        affiliationScore
      ]);
      const affiliationFinalScore =
        computeAffiliationFinalScore(newAffiliationWindow);
      const affiliationEstablished =
        computeAffiliationEstablished(newAffiliationWindow);

      const recallRouting = await recallRoutingPromise;
      throwIfCanceled();

      logChatDecision('recall_routing', {
        isRecallAttempt: recallRouting.isRecallAttempt === true,
        isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall === true,
        calledMemory: recallRouting.calledMemory || 'none'
      });

      const postRecallPriorityRule = resolveChatPriorityRule({
        phase: 'post_recall',
        recallRouting
      });

      if (postRecallPriorityRule) {
        logChatDecision('priority_rule_selected', {
          phase: 'post_recall',
          ruleId: postRecallPriorityRule.id,
          priority: postRecallPriorityRule.priority
        });
      }

      // Recall signals flow into the main pipeline. When isRecallAttempt, a recall
      // injection block is added to the writer prompt alongside the current state.
      // recall, branch history is loaded eagerly and merged into the memory context.
      let memoryForReply = previousMemory;
      if (recallRouting.isLongTermMemoryRecall === true) {
        const recallConversationBranchHistory =
          await recallBranchHistoryPromise;
        const normalizedBranchHistory = normalizeConversationBranchHistory(
          recallConversationBranchHistory
        );
        const branchTranscript =
          normalizedBranchHistory.length > 0
            ? normalizedBranchHistory
                .map(
                  (m) =>
                    `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.content}`
                )
                .join('\n')
            : '(indisponible)';
        const baseMem = normalizeMemory(previousMemory, activePromptRegistry);
        memoryForReply = [
          baseMem ? `Memoire resumee :\n${baseMem}` : '',
          `Transcript complet de la branche courante :\n${branchTranscript}`
        ]
          .filter(Boolean)
          .join('\n\n');
      }

      if (recallRouting.isRecallAttempt === true) {
        logChatDecision('recall_entering_pipeline', {
          isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall === true,
          calledMemory: recallRouting.calledMemory || 'none'
        });
      }

      // Phase 3: Deterministic arbitrator ? consolidate all analyzer outputs into a
      // PostureDecision struct. No LLM calls, no side effects outside this block.
      const previousConversationState = normalizeConversationState(
        flags.conversationState
      );
      const postureDecision = buildPostureDecision({
        detectedState,
        contactAnalysis,
        emotionalDecenteringAnalysis,
        affiliationWindow: newAffiliationWindow,
        affiliationEstablished,
        relationalAdjustmentAnalysis,
        calibrationAnalysis,
        technicalContextDetected:
          technicalContextAnalysis?.technicalContextDetected === true,
        userRegisterAnalysis,
        interpretationRejection: safeInterpretationRejection,
        effectiveExplorationDirectivityLevel,
        previousConversationState,
        currentConsecutiveNonExplorationTurns:
          normalizeConsecutiveNonExplorationTurns(
            newFlags.consecutiveNonExplorationTurns
          ),
        currentExplorationRelanceWindow: newFlags.explorationRelanceWindow,
        // Phase B structural flags ? persistent fallback values (overridden by C2 per-turn analysis)
        allianceSignal: newFlags.allianceSignal,
        engagementLevel: newFlags.engagementLevel,
        attentionWindow: newFlags.attentionWindow,
        closureIntent: newFlags.closureIntent,
        dependencyCareMessagePending:
          newFlags.dependencyCareMessagePending ||
          flags.dependencyCareMessagePending ||
          false,
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
        explorationAnalysis,
        previousFormalAddress: newFlags.formalAddress === true,
        dependencyRiskLevel: flags.dependencyRiskLevel,
        secondaryTension
      });

      warnRuntimeContract(
        'postureDecision',
        collectPostureDecisionIssues(postureDecision),
        {
          traceId,
          requestId,
          detectedState
        }
      );

      finalDirectivityLevel = postureDecision.finalDirectivityLevel;
      finalExplorationSignal = postureDecision.finalExplorationSignal;
      const { conversationState, consecutiveNonExplorationTurns } =
        postureDecision;

      Object.assign(newFlags, postureDecision.flagUpdates);

      // Observabilite: garder ce signal pour les logs pipeline.
      const hadEmptyOngoingBeforeTurn =
        !Array.isArray(previousMemoryState?.onGoingMovements) ||
        previousMemoryState.onGoingMovements.length === 0;

      flagsForCatch = normalizeSessionFlags(newFlags);

      // Injection du hint de lucidit� relationnelle (dependencyCare).
      // On lit currentFlags (valeur Firebase de ce tour) pour �viter l'injection au tour m�me
      // o� le seuil est franchi ("pas de but en blanc").
      const _carePending = flags.dependencyCareMessagePending || false;
      if (_carePending) {
        const _careBlockingStates = [
          'n1_crisis',
          'n2_crisis',
          'discharge_regulated',
          'discharge_dysregulated',
          'alliance_rupture'
        ];
        const _careEligible = !_careBlockingStates.includes(
          postureDecision.conversationState
        );
        if (_careEligible) {
          if (!Array.isArray(postureDecision.writerIntentHints))
            postureDecision.writerIntentHints = [];
          const _careHintToken =
            _carePending === 'high'
              ? 'dependency_care_expressed_high'
              : 'dependency_care_expressed_medium';
          postureDecision.writerIntentHints.push(_careHintToken);
          const _carePendingTurns =
            (flags.dependencyCareMessagePendingTurns || 0) + 1;
          newFlags.dependencyCareMessagePendingTurns = _carePendingTurns;
          if (_carePendingTurns >= 2) {
            // Apr�s 2 tours �ligibles, on consid�re le message livr� ou d�finitivement diff�r�.
            newFlags.dependencyCareMessagePending = false;
            newFlags.dependencyCareMessagePendingTurns = 0;
          }
        }
      }

      const turnSignals = buildTurnSignals(postureDecision, {
        allianceSignal: newFlags.allianceSignal,
        relationalAdjustmentActive:
          relationalAdjustmentAnalysis?.needsRelationalAdjustment === true,
        interpretationRejectionActive:
          safeInterpretationRejection.isInterpretationRejection === true,
        insightMoment: contactAnalysis?.insightMoment === true,
        selfCriticismLevel: contactAnalysis?.selfCriticismLevel || 'low',
        emotionalDecentering:
          emotionalDecenteringAnalysis?.emotionalDecentering === true,
        dependencyRiskLevel: newFlags.dependencyRiskLevel || 'low'
      });

      if (postureDecision.relationalAdjustmentActive) {
        logChatDecision('relational_adjustment_caps_directivity', {
          previousLevel: postureDecision.preAdjustmentDirectivityLevel,
          cappedLevel: postureDecision.finalDirectivityLevel,
          relationalAdjustmentActive: true
        });
      }

      logChatDecision('mode_detected', {
        detectedState,
        tieBreakReason,
        isContact: contactAnalysis.isContact === true,
        relationalAdjustmentActive: postureDecision.relationalAdjustmentActive,
        previousWasDischarge: flags.dischargeState?.wasDischarge === true,
        currentWasDischarge: newFlags.dischargeState?.wasDischarge === true,
        previousConversationState,
        conversationState,
        consecutiveNonExplorationTurns,
        finalDirectivityLevel,
        finalExplorationSignal,
        relancePolicy: postureDecision.relancePolicy,
        actionCollapseGuardActive: postureDecision.actionCollapseGuardActive
      });

      if (postureDecision.stateTransitionValid === false) {
        console.warn('[CHAT][STATE_TRANSITION_OUT_OF_GRAPH]', {
          conversationId,
          previousConversationState: postureDecision.previousConversationState,
          requestedConversationState:
            postureDecision.requestedConversationState,
          enforcedConversationState: postureDecision.conversationState
        });
      }

      // 4) Generation principale de la reponse selon le mode detecte.
      markChatStage('reply_generation');

      // Blocs 3+4 : injection m?moire longue terme (intersession compress?e).
      // turnsUntilIntersessionRefresh === 0 ? injection. Sinon, d?cr?ment? chaque tour.
      // intersessionRefreshForced (Firebase) permet un refresh imm?diat apr?s ?dition directe.
      let intersessionPreparationTimedOut = false;
      const intersessionPreparationResult = await Promise.race([
        intersessionMemoryPreparationPromise,
        wait(INTERSESSION_PREPARATION_WAIT_TIMEOUT_MS).then(() => {
          intersessionPreparationTimedOut = true;
          return null;
        })
      ]);

      let intersessionMemoryForThisTurn = '';
      let intersessionMemoryRuntime = '';
      let nextTurnsUntilIntersessionRefresh = Number.isInteger(
        newFlags.turnsUntilIntersessionRefresh
      )
        ? Math.max(0, newFlags.turnsUntilIntersessionRefresh)
        : 0;

      if (
        intersessionPreparationResult &&
        typeof intersessionPreparationResult === 'object'
      ) {
        intersessionMemoryForThisTurn =
          typeof intersessionPreparationResult.intersessionMemoryForThisTurn ===
          'string'
            ? intersessionPreparationResult.intersessionMemoryForThisTurn
            : '';
        intersessionMemoryRuntime =
          typeof intersessionPreparationResult.intersessionMemoryRuntime ===
          'string'
            ? intersessionPreparationResult.intersessionMemoryRuntime
            : '';
        nextTurnsUntilIntersessionRefresh = Number.isInteger(
          intersessionPreparationResult.nextTurnsUntilIntersessionRefresh
        )
          ? Math.max(
              0,
              intersessionPreparationResult.nextTurnsUntilIntersessionRefresh
            )
          : nextTurnsUntilIntersessionRefresh;
      } else {
        const fallbackCompactSeed = await Promise.race([
          intersessionFallbackSeedPromise,
          wait(INTERSESSION_FALLBACK_SEED_WAIT_TIMEOUT_MS).then(() => '')
        ]);

        const safeFallbackCompact = String(fallbackCompactSeed || '').trim();
        intersessionMemoryForThisTurn = safeFallbackCompact;
        intersessionMemoryRuntime = safeFallbackCompact;

        logChatDecision('intersession_preparation_budget_fallback', {
          timedOut: intersessionPreparationTimedOut === true,
          waitBudgetMs: INTERSESSION_PREPARATION_WAIT_TIMEOUT_MS,
          usedStoredCompactFallback: safeFallbackCompact.length > 0
        });
      }

      newFlags.turnsUntilIntersessionRefresh =
        nextTurnsUntilIntersessionRefresh;

      const generatedBase = await generateReply({
        message,
        history: recentHistory,
        memory:
          recallRouting.isRecallAttempt === true
            ? memoryForReply
            : previousMemory,
        postureDecision,
        interpretationRejection: safeInterpretationRejection,
        intersessionMemoryForTurn: intersessionMemoryForThisTurn,
        promptRegistry: activePromptRegistry,
        onTokenCallback: onTokenCallbackForChat
      });
      throwIfCanceled();
      await registerUsageConsumptionFromTurn({
        writerUsage: generatedBase.usage || null
      });

      let reply = generatedBase.reply;

      postureDecision.memoryUpdateDecision = 'update';
      postureDecision.memoryUpdateReason =
        'deterministic_runtime_always_update';
      postureDecision.memoryUpdateSource = 'runtime';

      logChatDecision('memory_update_decision', {
        decision: postureDecision.memoryUpdateDecision,
        reason: postureDecision.memoryUpdateReason,
        source: postureDecision.memoryUpdateSource,
        previousMemoryStateCounts: {
          sessionStableContext: Array.isArray(
            previousMemoryState?.sessionStableContext
          )
            ? previousMemoryState.sessionStableContext.length
            : 0,
          onGoingMovements: Array.isArray(previousMemoryState?.onGoingMovements)
            ? previousMemoryState.onGoingMovements.length
            : 0,
          ancientMovements: Array.isArray(previousMemoryState?.ancientMovements)
            ? previousMemoryState.ancientMovements.length
            : 0
        }
      });

      const relanceTargetTurnNumber = currentTurnNumber + 1;
      const relanceBaseFlagsSnapshot = normalizeSessionFlags(newFlags);
      const relanceAppliedAtTurnEntrySourceTurn = Number.isInteger(
        relanceAppliedAtTurnEntry?.sourceTurnNumber
      )
        ? relanceAppliedAtTurnEntry.sourceTurnNumber
        : null;
      const relanceAppliedAtTurnEntryStatus =
        typeof relanceAppliedAtTurnEntry?.status === 'string'
          ? relanceAppliedAtTurnEntry.status
          : null;
      let relanceAsyncStatusForDebug =
        detectedState === 'exploration' ? 'pending' : 'not_requested';
      let relancePreparedNextDirectivityLevelForDebug =
        null;
      let relancePreparedNextWindowForDebug =
        null;
      const relanceStatePreparedForNextTurn = conversationRelanceAsyncState.get(
        String(conversationId || '').trim()
      );

      if (relanceAppliedAtTurnEntrySourceTurn !== null) {
        relanceAsyncStatusForDebug =
          detectedState === 'exploration'
            ? 'applied_at_entry_and_pending'
            : 'applied_at_entry';
      }

      if (
        detectedState === 'exploration' &&
        relanceStatePreparedForNextTurn &&
        typeof relanceStatePreparedForNextTurn === 'object' &&
        Number.isInteger(relanceStatePreparedForNextTurn.targetTurnNumber) &&
        relanceStatePreparedForNextTurn.targetTurnNumber ===
          relanceTargetTurnNumber
      ) {
        relancePreparedNextWindowForDebug = Array.isArray(
          relanceStatePreparedForNextTurn.explorationRelanceWindow
        )
          ? relanceStatePreparedForNextTurn.explorationRelanceWindow
          : null;
        relancePreparedNextDirectivityLevelForDebug = Number.isInteger(
          relanceStatePreparedForNextTurn.explorationDirectivityLevel
        )
          ? relanceStatePreparedForNextTurn.explorationDirectivityLevel
          : null;
        relanceAsyncStatusForDebug =
          relanceAppliedAtTurnEntrySourceTurn !== null
            ? 'applied_at_entry_and_ready_for_next'
            : 'ready_for_next_turn';
      }

      if (detectedState === 'exploration') {
        const relanceBackgroundTask = (async () => {
          const relanceStartedAt = Date.now();
          const safeConversationId = String(conversationId || '').trim();

          try {
            const relanceAnalysis = await Promise.race([
              analyzeExplorationRelance({
                message,
                reply,
                history: recentHistory,
                memory: previousMemory,
                promptRegistry: activePromptRegistry
              }),
              wait(RELANCE_ASYNC_TIMEOUT_MS).then(() => {
                const timeoutError = new Error('relance_async_timeout');
                timeoutError.code = 'relance_async_timeout';
                throw timeoutError;
              })
            ]);

            const relanceNextFlags = registerExplorationRelance(
              relanceBaseFlagsSnapshot,
              relanceAnalysis?.isRelance === true
            );

            const currentTurnSeen = Number(
              conversationTurnCounters.get(safeConversationId)
            );
            const effectiveTargetTurnNumber =
              Number.isInteger(currentTurnSeen) &&
              currentTurnSeen >= relanceTargetTurnNumber
                ? currentTurnSeen + 1
                : relanceTargetTurnNumber;

            conversationRelanceAsyncState.set(safeConversationId, {
              targetTurnNumber: effectiveTargetTurnNumber,
              sourceTurnNumber: currentTurnNumber,
              explorationRelanceWindow: relanceNextFlags.explorationRelanceWindow,
              explorationDirectivityLevel:
                relanceNextFlags.explorationDirectivityLevel,
              isRelance: relanceAnalysis?.isRelance === true,
              status: 'ready',
              producedAt: Date.now()
            });

            logChatDecision('relance_async_result', {
              status:
                effectiveTargetTurnNumber === relanceTargetTurnNumber
                  ? 'ready'
                  : 'ready_deferred',
              currentTurnNumber,
              targetTurnNumber: effectiveTargetTurnNumber,
              isRelance: relanceAnalysis?.isRelance === true,
              explorationRelanceWindow: relanceNextFlags.explorationRelanceWindow,
              explorationDirectivityLevel:
                relanceNextFlags.explorationDirectivityLevel,
              latencyMs: Date.now() - relanceStartedAt
            });
          } catch (err) {
            const fallbackFlags = normalizeSessionFlags(relanceBaseFlagsSnapshot);
            const currentTurnSeen = Number(
              conversationTurnCounters.get(safeConversationId)
            );
            const effectiveTargetTurnNumber =
              Number.isInteger(currentTurnSeen) &&
              currentTurnSeen >= relanceTargetTurnNumber
                ? currentTurnSeen + 1
                : relanceTargetTurnNumber;

            if (
              !Number.isInteger(currentTurnSeen) ||
              currentTurnSeen <= effectiveTargetTurnNumber
            ) {
              conversationRelanceAsyncState.set(safeConversationId, {
                targetTurnNumber: effectiveTargetTurnNumber,
                sourceTurnNumber: currentTurnNumber,
                explorationRelanceWindow: fallbackFlags.explorationRelanceWindow,
                explorationDirectivityLevel:
                  fallbackFlags.explorationDirectivityLevel,
                isRelance: false,
                status: 'fallback_retained_previous_level',
                producedAt: Date.now()
              });
            }

            logChatDecision('relance_async_result', {
              status:
                effectiveTargetTurnNumber === relanceTargetTurnNumber
                  ? 'fallback_retained_previous_level'
                  : 'fallback_retained_previous_level_deferred',
              currentTurnNumber,
              targetTurnNumber: effectiveTargetTurnNumber,
              explorationRelanceWindow: fallbackFlags.explorationRelanceWindow,
              explorationDirectivityLevel:
                fallbackFlags.explorationDirectivityLevel,
              latencyMs: Date.now() - relanceStartedAt,
              error: err && err.message ? err.message : String(err)
            });
          } finally {
            await registerUsageConsumptionFromTurn();
          }
        })();

        trackConversationRelanceSync(
          conversationId,
          relanceBackgroundTask,
          relanceTargetTurnNumber
        );
      }

      const analyzerDeterministicEvidence = [
        ...(Array.isArray(
          stateProposal?.dischargeAnalysis?.deterministicEvidence
        )
          ? stateProposal.dischargeAnalysis.deterministicEvidence
          : []),
        ...(Array.isArray(stateProposal?.contactAnalysis?.deterministicEvidence)
          ? stateProposal.contactAnalysis.deterministicEvidence
          : []),
        ...(Array.isArray(emotionalDecenteringAnalysis?.deterministicEvidence)
          ? emotionalDecenteringAnalysis.deterministicEvidence
          : []),
        ...(Array.isArray(relationalAdjustmentAnalysis?.deterministicEvidence)
          ? relationalAdjustmentAnalysis.deterministicEvidence
          : []),
        ...(Array.isArray(allianceRuptureAnalysis?.deterministicEvidence)
          ? allianceRuptureAnalysis.deterministicEvidence
          : []),
        ...(Array.isArray(safeInterpretationRejection?.deterministicEvidence)
          ? safeInterpretationRejection.deterministicEvidence
          : []),
        ...(Array.isArray(recallRouting?.deterministicEvidence)
          ? recallRouting.deterministicEvidence
          : [])
      ]
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .filter((entry) => !/\|\s*match:\s*none\s*$/i.test(entry));

      const debug = buildDebug(
        postureDecision.requestedBaseState || detectedState,
        {
          suicideLevel: suicide.suicideLevel,
          calledMemory: recallRouting.calledMemory,
          interpretationRejection:
            safeInterpretationRejection.isInterpretationRejection,
          needsSoberReadjustment: postureDecision.needsSoberReadjustment,
          relationalAdjustmentActive:
            relationalAdjustmentAnalysis?.needsRelationalAdjustment === true,
          explorationCalibrationLevel: newFlags.explorationCalibrationLevel,
          explorationDirectivityLevel: finalDirectivityLevel,
          explorationRelanceWindow: newFlags.explorationRelanceWindow
        }
      );

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
            relanceAnalysis: null
          })
        );

        debug.push(`trace.explorationSignal: ${finalExplorationSignal}`);
      }

      // 5) Mise a jour memoire (fire-and-forget unifie).
      // The response always exposes the memory used for this turn (N-1), while
      // update/finalization/persistence runs in background for the next turn.
      // Runtime rule: movement memory is refreshed every turn.
      let newMemory = previousMemory;
      const effectiveMemoryPrioritySignalForDebug =
        postureDecision.memoryPrioritySignal || 'normal';
      newFlags.dependencyAnalysisTurnsUntilRefresh = 1;
      markChatStage('memory_update');

      const memoryClinicalSignals = {
        risque_dependance: newFlags.dependencyRiskLevel || 'low',
        decentrage_emotionnel:
          emotionalDecenteringAnalysis?.emotionalDecentering === true,
        agressivite_vers_bot:
          dischargeAnalysis?.aggressiveDischargeDirectedToBot === true
      };

      const _prevMem = previousMemory;
      const _history = recentHistory;
      const _message = message;
      const _reply = reply;
      const _registry = activePromptRegistry;
      const _interSession = intersessionMemoryForThisTurn;
      const _prevMemState = previousMemoryState;
      const _lastActivityMs = previousConversationActivityMs;
      const _prioritySignal = effectiveMemoryPrioritySignalForDebug;

      let backgroundMemoryTask = (async () => {
        try {
          const memoryUpdateContract = await updateMemory(
            _prevMem,
            [
              ..._history,
              { role: 'user', content: _message },
              { role: 'assistant', content: _reply }
            ],
            _registry,
            _prioritySignal,
            _interSession,
            memoryClinicalSignals,
            _prevMemState
          );
          const rawMem =
            typeof memoryUpdateContract?.memoryText === 'string'
              ? memoryUpdateContract.memoryText
              : _prevMem;

          const mergedStateResult = mergeMemoryStateWithFinalizedText({
            previousMemoryState: _prevMemState,
            finalizedMemoryText: rawMem,
            deleteAncientMovementsById: Array.isArray(
              memoryUpdateContract?.deleteAncientMovementsById
            )
              ? memoryUpdateContract.deleteAncientMovementsById
              : [],
            nowMs: Date.now(),
            lastActivityMs: _lastActivityMs,
            ttlMs: MEMORY_INACTIVITY_TTL_MS
          });
          const reactivationTrace = buildMemoryReactivationTrace({
            previousMemoryState: _prevMemState,
            memoryUpdateContract,
            mergedMemoryState: mergedStateResult.memoryState,
            currentUserMessage: _message,
            memoryPrioritySignal: _prioritySignal
          });
          const persistedMemoryText = normalizeMemory(
            mergedStateResult.memoryText,
            _registry
          );

          if (
            reactivationTrace.reactivationDetected === true ||
            reactivationTrace.mergedOutsideCurrentUser.length > 0
          ) {
            logChatDecision('memory_reactivation_trace', {
              decision: 'update',
              reason: postureDecision.memoryUpdateReason,
              source: postureDecision.memoryUpdateSource,
              ...reactivationTrace
            });
          }

          logChatDecision('memory_update_result', {
            decision: 'update',
            reason: postureDecision.memoryUpdateReason,
            source: postureDecision.memoryUpdateSource,
            contractSource:
              typeof memoryUpdateContract?.source === 'string'
                ? memoryUpdateContract.source
                : 'unknown',
            contractLlmMeta:
              memoryUpdateContract?.llmMeta &&
              typeof memoryUpdateContract.llmMeta === 'object'
                ? memoryUpdateContract.llmMeta
                : null,
            reactivationTraceSummary: {
              detected: reactivationTrace.reactivationDetected === true,
              likelySource: reactivationTrace.likelySource,
              contractOverlapCount:
                reactivationTrace.overlapContractWithAncient.length,
              mergedOverlapCount:
                reactivationTrace.overlapMergedWithAncient.length,
              mergedOutsideCurrentUserCount:
                reactivationTrace.mergedOutsideCurrentUser.length
            },
            deleteAncientCount: Array.isArray(
              memoryUpdateContract?.deleteAncientMovementsById
            )
              ? memoryUpdateContract.deleteAncientMovementsById.length
              : 0,
            purgedByInactivity: mergedStateResult.purgedByInactivity === true,
            nextMemoryStateCounts: {
              sessionStableContext: Array.isArray(
                mergedStateResult?.memoryState?.sessionStableContext
              )
                ? mergedStateResult.memoryState.sessionStableContext.length
                : 0,
              onGoingMovements: Array.isArray(
                mergedStateResult?.memoryState?.onGoingMovements
              )
                ? mergedStateResult.memoryState.onGoingMovements.length
                : 0,
              ancientMovements: Array.isArray(
                mergedStateResult?.memoryState?.ancientMovements
              )
                ? mergedStateResult.memoryState.ancientMovements.length
                : 0
            }
          });

          if (isPrivateConversation && conversationId) {
            privateConversationMemoryCache.set(String(conversationId), {
              memory: persistedMemoryText,
              memoryState: mergedStateResult.memoryState,
              memoryRewriteDebug: {
                beforeSanitization: null,
                deletedAncientIds: Array.isArray(
                  memoryUpdateContract?.deleteAncientMovementsById
                )
                  ? memoryUpdateContract.deleteAncientMovementsById
                  : [],
                source:
                  typeof memoryUpdateContract?.source === 'string'
                    ? memoryUpdateContract.source
                    : null,
                capturedAt: new Date().toISOString()
              },
              updatedAt: Date.now()
            });

                try {
                  await persistPrivateConversationMemory(conversationId, {
                    memory: persistedMemoryText,
                    memoryState: mergedStateResult.memoryState,
                    memoryRewriteDebug: {
                      beforeSanitization: null,
                      deletedAncientIds: Array.isArray(
                        memoryUpdateContract?.deleteAncientMovementsById
                      )
                        ? memoryUpdateContract.deleteAncientMovementsById
                        : [],
                      source:
                        typeof memoryUpdateContract?.source === 'string'
                          ? memoryUpdateContract.source
                          : null,
                      capturedAt: new Date().toISOString()
                    },
                    updatedAt: new Date().toISOString()
                  });
                } catch (persistPrivateErr) {
                  console.warn('[CHAT][PRIVATE_MEMORY_PERSIST_FAILED]', {
                    conversationId,
                    error:
                      persistPrivateErr && persistPrivateErr.message
                        ? persistPrivateErr.message
                        : String(persistPrivateErr)
                  });
                }
            return;
          }

          await persistConversationMemoryWithRetry(
            persistedMemoryText,
            _registry,
            2,
            mergedStateResult.memoryState,
            {
              beforeSanitization: null,
              deletedAncientIds: Array.isArray(
                memoryUpdateContract?.deleteAncientMovementsById
              )
                ? memoryUpdateContract.deleteAncientMovementsById
                : [],
              source:
                typeof memoryUpdateContract?.source === 'string'
                  ? memoryUpdateContract.source
                  : null,
              capturedAt: new Date().toISOString()
            }
          );
        } catch (e) {
          console.warn(
            '[CHAT][MEMORY_BG_FAILED]',
            e && e.message ? e.message : e
          );
          logChatDecision('memory_update_failed', {
            decision: 'update',
            reason: postureDecision.memoryUpdateReason,
            source: postureDecision.memoryUpdateSource,
            error: e && e.message ? e.message : String(e)
          });
        } finally {
          await registerUsageConsumptionFromTurn();
        }
      })();

      if (conversationId && backgroundMemoryTask) {
        trackConversationMemorySync(conversationId, backgroundMemoryTask);
      }
      const postCrisisSupportCarryTurnActive =
        req.__postCrisisSupportCarryTurnActive === true;
      const emergencySupportText = postCrisisSupportCarryTurnActive
        ? await resolveEmergencySupportText()
        : null;

      const responseDebugMeta = buildResponseDebugMeta({
        memory: newMemory,
        suicideLevel: suicide.suicideLevel,
        conversationState: postureDecision.conversationState,
        effectiveConversationState: postureDecision.effectiveConversationState,
        consecutiveNonExplorationTurns: newFlags.consecutiveNonExplorationTurns,
        interpretationRejection:
          safeInterpretationRejection.isInterpretationRejection,
        needsSoberReadjustment: postureDecision.needsSoberReadjustment,
        relationalAdjustmentActive:
          relationalAdjustmentAnalysis?.needsRelationalAdjustment === true,
        isRecallRequest: recallRouting.isRecallAttempt === true,
        explorationCalibrationLevel: newFlags.explorationCalibrationLevel,
        explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
        explorationRelanceWindow: newFlags.explorationRelanceWindow,
        directivityInputLevel: effectiveExplorationDirectivityLevel,
        directivityUsedLevel: finalDirectivityLevel,
        directivityNextLevel: relancePreparedNextDirectivityLevelForDebug,
        directivityNextWindow: relancePreparedNextWindowForDebug,
        relanceAsyncStatus: relanceAsyncStatusForDebug,
        relanceAppliedAtTurnEntrySourceTurn,
        relanceAppliedAtTurnEntryStatus,
        relanceAsyncTargetTurn:
          detectedState === 'exploration' ? relanceTargetTurnNumber : null,
        explorationSignal: finalExplorationSignal,
        memoryBeforeSanitization:
          typeof previousMemoryRewriteDebug?.beforeSanitization === 'string'
            ? previousMemoryRewriteDebug.beforeSanitization
            : null,
        memoryAncientCleanupDeletedIds: Array.isArray(
          previousMemoryRewriteDebug?.deletedAncientIds
        )
          ? previousMemoryRewriteDebug.deletedAncientIds
          : [],
        // PRODUCT DECISION (memory audit baseline): response debug exposes the memory state
        // available at turn start (previousMemoryState). The merged memory state generated during
        // this turn is persisted asynchronously for the next turn and is not injected here.
        // This one-turn offset is intentional for runtime latency and stability.
        memoryState: previousMemoryState,
        intersessionMemoryRuntime,
        analyzerDeterministicEvidence,
        // Posture contract fields (V3)
        intent: postureDecision.intent,
        forbidden: postureDecision.forbidden,
        confidenceSignal: postureDecision.confidenceSignal,
        uncertaintyExpressionPolicy:
          postureDecision.uncertaintyExpressionPolicy,
        uncertaintyDrivers: postureDecision.uncertaintyDrivers,
        relancePolicy: postureDecision.relancePolicy,
        useDirectAddress: postureDecision.useDirectAddress === true,
        actionCollapseGuardActive: postureDecision.actionCollapseGuardActive,
        stateTransitionFrom: postureDecision.previousConversationState,
        stateTransitionValid: postureDecision.stateTransitionValid,
        stateTransitionRequested:
          postureDecision.stateTransitionValid === false
            ? postureDecision.requestedConversationState
            : null,
        // Phase B structural flags
        allianceSignal: newFlags.allianceSignal,
        engagementLevel: newFlags.engagementLevel,
        attentionWindow: newFlags.attentionWindow,
        dependencyRiskScore: newFlags.dependencyRiskScore,
        dependencyRiskLevel: newFlags.dependencyRiskLevel,
        isolationScore: newFlags.isolationScore,
        attachmentScore: newFlags.attachmentScore,
        dependencyCareMessagePending:
          newFlags.dependencyCareMessagePending || false,
        externalSupportMode: newFlags.externalSupportMode,
        closureIntent: newFlags.closureIntent,
        infoRoutingSource,
        infoContextFlags: Array.isArray(postureDecision.infoContextFlags)
          ? postureDecision.infoContextFlags
          : [],
        promptRegistry: activePromptRegistry,
        // Lot 8 fields
        affiliationScore: affiliationScore,
        affiliationFinalScore,
        affiliationWindow: newAffiliationWindow,
        affiliationEstablished,
        emotionalDecentering:
          emotionalDecenteringAnalysis?.emotionalDecentering === true,
        formalAddress: postureDecision.formalAddress === true,
        // Writer hints from posture decision
        writerIntentHints: postureDecision.writerIntentHints,
        writerIntentHintsInactive: postureDecision.writerIntentHintsInactive,
        // Contact analyzer sub-fields
        contactInsightMoment: contactAnalysis?.insightMoment === true,
        contactSelfCriticismLevel:
          typeof contactAnalysis?.selfCriticismLevel === 'string'
            ? contactAnalysis.selfCriticismLevel
            : 'low',
        // C3 limiting_belief gate
        aggressiveDischargeDetected:
          postureDecision.aggressiveDischargeDetected === true,
        postDischargeTransitionActive:
          postureDecision.postDischargeTransitionActive === true,
        lowContextOpeningGuardActive:
          postureDecision.lowContextOpeningGuardActive === true,
        // Tension secondaire
        secondaryTension: postureDecision.secondaryTension || null,
        postCrisisSupportActive: postCrisisSupportCarryTurnActive,
        postCrisisSupportCarryTurn: postCrisisSupportCarryTurnActive,
        emergencySupportText
      });

      const elapsedMs = Date.now() - chatStartTime;
      if (logsEnabled || elapsedMs >= CHAT_SLOW_LOG_THRESHOLD_MS) {
        const stageSummary = summarizeChatStageTimings(chatStageTimings);
        chatLogger.info(
          {
            event: 'pipeline_summary',
            elapsedMs,
            slowRequest: elapsedMs >= CHAT_SLOW_LOG_THRESHOLD_MS,
            recentHistoryCount,
            isFirstTurn,
            suicideLevel: suicide.suicideLevel,
            detectedState: detectedState,
            conversationState: responseDebugMeta.conversationState,
            effectiveConversationState:
              responseDebugMeta.effectiveConversationState,
            interpretationRejection:
              responseDebugMeta.interpretationRejection === true,
            needsSoberReadjustment:
              responseDebugMeta.needsSoberReadjustment === true,
            relationalAdjustmentActive:
              responseDebugMeta.relationalAdjustmentActive === true,
            memoryUpdateDecision: postureDecision.memoryUpdateDecision,
            memoryUpdateReason: postureDecision.memoryUpdateReason,
            memoryUpdateSource: postureDecision.memoryUpdateSource,
            hadEmptyOngoingBeforeTurn,
            confidenceSignal: responseDebugMeta.confidenceSignal,
            explorationCalibrationLevel:
              responseDebugMeta.explorationCalibrationLevel,
            explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
            rewriteSource: responseDebugMeta.rewriteSource,
            stageTimings: chatStageTimings,
            stageSummary
          },
          'pipeline'
        );
      }

      markChatStage('persist_response');
      throwIfCanceled();

      const botMessageId = persistAssistantMessageAsync(
        reply,
        debug,
        responseDebugMeta,
        { memory: newMemory, flags: newFlags }
      );

      return sendChatJsonResponse(
        reply,
        newMemory,
        newFlags,
        debug,
        responseDebugMeta,
        botMessageId,
        turnSignals
      );
    } catch (err) {
      if (err && err.code === 'chat_request_canceled') {
        publishChatProgressTerminal(requestId, 'canceled');
        // Mark the user message with [ENVOI STOPPE] if it was persisted
        if (userMessageRefForCatch && userMessagePersistedForCatch) {
          try {
            const snapshot = await userMessageRefForCatch.once('value');
            const messageData = snapshot.val();
            if (messageData && typeof messageData.content === 'string') {
              let newContent = messageData.content;
              // Replace [MODIFI\u00c9] with [ENVOI STOPPE] if present, otherwise append it
              if (
                newContent.includes('[MODIFI\u00c9]') ||
                newContent.includes('[MODIFI?]')
              ) {
                newContent = newContent.replace(
                  /\n?\[(MODIFI\u00c9|MODIFI\?)\]$/,
                  '\n[ENVOI STOPPE]'
                );
              } else {
                newContent = newContent.trim() + '\n[ENVOI STOPPE]';
              }
              await userMessageRefForCatch.update({ content: newContent });
            }
          } catch (markErr) {
            chatLogger.warn({
              event: 'stop_marking_failed',
              error:
                markErr && markErr.message ? markErr.message : String(markErr)
            });
          }
        }

        return res.status(499).json({
          error: 'Chat request canceled',
          canceled: true,
          requestId: requestId || null
        });
      }

      chatLogger.error({
        event: 'chat_error',
        error: err && err.message ? err.message : String(err)
      });
      publishChatProgressTerminal(requestId, 'error');
      chatLogger.error({
        event: 'chat_error_context',
        lastStage: chatLastStage,
        elapsedMs: Date.now() - chatStartTime,
        stageTimings: chatStageTimings
      });

      const isQuotaExhausted =
        err &&
        (err.code === 'insufficient_quota' ||
          err.type === 'insufficient_quota');
      const fallbackReply = isQuotaExhausted
        ? "Le service est temporairement indisponible car le quota API est épuisé. Je ne peux pas traiter de nouveau message tant que ce quota n'est pas rétabli."
        : suicideLevelForCatch === 'N1'
          ? n1Fallback()
          : 'Un problème technique est survenu. Réessaie dans un instant.';
      const fallbackDebugMeta = buildFallbackResponseDebugMeta({
        memory: previousMemoryForCatch,
        memoryBeforeSanitization:
          typeof previousMemoryRewriteDebugForCatch?.beforeSanitization ===
          'string'
            ? previousMemoryRewriteDebugForCatch.beforeSanitization
            : null,
        memoryAncientCleanupDeletedIds: Array.isArray(
          previousMemoryRewriteDebugForCatch?.deletedAncientIds
        )
          ? previousMemoryRewriteDebugForCatch.deletedAncientIds
          : [],
        suicideLevel: 'N0',
        conversationState: modeForCatch,
        isRecallRequest: false,
        explorationCalibrationLevel: flagsForCatch.explorationCalibrationLevel,
        explorationDirectivityLevel:
          flagsForCatch.explorationDirectivityLevel || 0,
        explorationRelanceWindow: flagsForCatch.explorationRelanceWindow || [],
        rewriteSource: null,
        memoryRewriteSource: null,
        modelConflict: false,
        promptRegistry: promptRegistryForCatch
      });

      if (
        !isQuotaExhausted &&
        userMessagePersistedForCatch &&
        !assistantMessagePersistedForCatch
      ) {
        try {
          await persistFallbackAssistantMessage(
            fallbackReply,
            ['error'],
            fallbackDebugMeta
          );
          chatLogger.warn({
            event: 'fallback_persisted',
            lastStage: chatLastStage
          });
        } catch (persistErr) {
          chatLogger.error({
            event: 'fallback_persist_failed',
            lastStage: chatLastStage,
            error:
              persistErr && persistErr.message
                ? persistErr.message
                : String(persistErr)
          });
        }
      }
      if (isQuotaExhausted) {
        return res.status(503).json({
          error: 'OpenAI quota exhausted',
          code: 'insufficient_quota',
          status: 'service_unavailable',
          serviceUnavailable: true,
          serviceUnavailableReason: 'quota_exhausted',
          userMessage:
            "Le service est temporairement indisponible car le quota API est épuisé. Aucun nouveau message ne peut être traité tant que ce quota n'est pas rétabli. Recharge la page après rétablissement du quota.",
          memory: previousMemoryForCatch,
          flags: flagsForCatch,
          debug: ['error'],
          debugMeta: fallbackDebugMeta
        });
      }

      // Fallback path: if any part of the /chat pipeline throws, return a safe
      // generic reply plus preserved memory/flags instead of crashing the server.
      return res.json({
        reply: fallbackReply,
        memory: previousMemoryForCatch,
        flags: flagsForCatch,
        debug: ['error'],
        debugMeta: fallbackDebugMeta
      });
    } finally {
      if (requestId) {
        finalizeActiveChatRequest(requestId);
      }

      if (logsEnabledForCatch) {
        chatLogger.info({
          event: 'chat_trace',
          totalMs: Date.now() - chatStartTime,
          lastStage: chatLastStage,
          stageTimings: chatStageTimings
        });
      }
    }
  });
}

app.post('/chat', requireUserAuth, handleChatPost);

app.post('/chat/stream', requireUserAuth, async (req, res) => {
  if (appConfig.enableChatStreaming !== true) {
    return res.status(405).json({
      error: 'Chat streaming is not enabled',
      code: 'streaming_disabled'
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const streamRequestId = String(req.body?.requestId || '').trim() || null;
  const streamConversationId =
    String(req.body?.conversationId || '').trim() || null;
  logger.info({
    scope: 'chat_stream',
    event: 'chat_stream_opened',
    requestId: streamRequestId,
    conversationId: streamConversationId
  });

  writeSSEEvent(res, 'ready', {
    status: 'connected',
    ts: Date.now()
  });

  req.onTokenCallbackForChat = (token) => {
    writeSSEEvent(res, 'token', { token });
  };

  req.on('close', () => {
    logger.info({
      scope: 'chat_stream',
      event: 'chat_stream_closed',
      requestId: streamRequestId,
      conversationId: streamConversationId,
      writableEnded: res.writableEnded === true
    });
    req.onTokenCallbackForChat = null;
  });

  const streamRes = {
    _statusCode: 200,
    setHeader(name, value) {
      try {
        res.setHeader(name, value);
      } catch {
        // Ignore late header writes once SSE stream is active.
      }
      return this;
    },
    status(code) {
      this._statusCode = Number(code) || 500;
      return this;
    },
    json(payload) {
      if (this._statusCode >= 400) {
        logger.warn({
          scope: 'chat_stream',
          event: 'chat_stream_result_error',
          requestId: streamRequestId,
          conversationId: streamConversationId,
          status: this._statusCode
        });
        writeSSEEvent(res, 'error', {
          status: this._statusCode,
          ...(payload && typeof payload === 'object'
            ? payload
            : { error: 'stream_error' })
        });
      } else {
        logger.info({
          scope: 'chat_stream',
          event: 'chat_stream_result_ok',
          requestId: streamRequestId,
          conversationId: streamConversationId
        });
        writeSSEEvent(res, 'result', payload);
      }
      if (!res.writableEnded) {
        res.end();
      }
      return this;
    }
  };

  try {
    await handleChatPost(req, streamRes);
    if (!res.writableEnded) {
      res.end();
    }
  } catch (err) {
    writeSSEEvent(res, 'error', {
      error: 'streaming_failed',
      message: err && err.message ? err.message : ''
    });
    if (!res.writableEnded) {
      res.end();
    }
  } finally {
    req.onTokenCallbackForChat = null;
  }
});

// Start the HTTP server after all routes and middleware are configured.

app.listen(port, () => {
  logger.info({ event: 'server_started', port, nodeEnv: appConfig.nodeEnv });

  bootstrapAdminSettingsCache();
  startAdminSettingsListener();

  // Auto-refresh for emergency numbers via Wikidata.
  // Boot refresh is opt-in via REFRESH_EMERGENCY_ON_BOOT=true.
  if (REFRESH_EMERGENCY_ON_BOOT) {
    setTimeout(() => {
      safeRefreshEmergencyNumbers('boot');
    }, EMERGENCY_REFRESH_INITIAL_DELAY_MS);
  }

  // Node.js setInterval overflows for values > 2^31-1 ms (~24.8 days), firing immediately in a loop.
  // Cap at 24h; the guard inside safeRefreshEmergencyNumbers (EMERGENCY_REFRESH_MIN_INTERVAL_MS)
  // prevents actual refresh from running more than once per 24h anyway.
  setInterval(() => {
    safeRefreshEmergencyNumbers('interval');
  }, EMERGENCY_REFRESH_MIN_INTERVAL_MS);
});
