require('dotenv').config();

// Main server entry point.
// - initialize Firebase admin with credentials
// - configure Express, static asset headers, and chat pipeline
// - preserve existing behavior while making the code easier to follow
const admin = require('firebase-admin');
const { parseAppConfig, resolveServiceAccount } = require('./lib/config');
const { childLogger } = require('./lib/logger');
const { createSafeConsole } = require('./lib/log-projection');
const console = createSafeConsole(childLogger({scope:'console'}));
const { createHealthHandler } = require('./lib/health');
const {
  createAffiliationShortValidationAnalyzer
} = require('./lib/affiliation-validation');
const { createMistralTransport } = require('./lib/mistral-transport');
const {
  createTitleRequester,
  sanitizeGeneratedTitleCandidate
} = require('./lib/title-generation');
const { createTitleConflictProtection } = require('./lib/title-conflict');
const {
  createInformationRequestAnalyzer
} = require('./lib/information-routing');
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
const {
  resolveConversationMemoryForIntersession,
  selectPostResumeHistory
} = require('./lib/intersession-memory-source');
const {
  NEUTRAL_REQUEST_MESSAGE,
  createResetEmailSender,
  createPasswordResetService,
  resolveResetClientIp
} = require('./lib/password-reset');
const {
  hashPassword,
  isStrongPassword,
  verifyPassword
} = require('./lib/auth-password');
const { createUserSessionCodec, sessionMatchesUser } = require('./lib/auth-session');

const appConfig = parseAppConfig(process.env);
const serviceAccount = resolveServiceAccount(appConfig);
const logger = childLogger({ scope: 'server' });

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: appConfig.firebaseDatabaseUrl
});
const { createDataLifecycle } = require('./lib/data-lifecycle');
const lifecycle = createDataLifecycle(admin.database());
const db = lifecycle.db;
const { createConversationCopies } = require('./lib/conversation-copies');
const conversationCopies = createConversationCopies({ lifecycle });
const messagesRef = db.ref('messages');
const userLabelsRef = db.ref('userLabels');
const usersRef = db.ref('users');
const accountArchivesRef = db.ref('accountArchives');
const accountResetAuditsRef = db.ref('accountResetAudits');
const adminSettingsRef = db.ref('adminSettings');
const branchRecordsRef = db.ref('branches');
const branchSeedSnapshotsRef = db.ref('branchSeeds');
const crypto = require('crypto');
const { createProfessionalAccess, REASONS, idValid } = require('./lib/professional-access');
const ADMIN_SESSION_DURATION = 24 * 60 * 60 * 1000;
const ADMIN_SESSION_SIGNING_SECRET = appConfig.adminSessionSecret;
const professionalAccess = createProfessionalAccess({db, secret: ADMIN_SESSION_SIGNING_SECRET});
const adminSessions = new Map(); // legacy cache never grants authority
const SECONDARY_CONVERSATION_USER_IDS = new Set();
const SECONDARY_CONVERSATION_EMAILS = new Set();
const userSessions = new Map(); // sessionToken -> { userId, createdAt }
const USER_SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30d
const ACCOUNT_RESET_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const USER_SESSION_SIGNING_SECRET = appConfig.userSessionSecret;
if (!USER_SESSION_SIGNING_SECRET || USER_SESSION_SIGNING_SECRET.length < 32) {
  throw new Error('user_signing_secret_required');
}
const userSessionCodec = createUserSessionCodec({
  secret: USER_SESSION_SIGNING_SECRET,
  durationMs: USER_SESSION_DURATION
});
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
const {
  createMemoryHelpers,
  normalizeIntersessionMemorySource
} = require('./lib/memory');
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

function getPasswordResetClientIp(req) {
  return resolveResetClientIp({
    socketAddress: req.socket?.remoteAddress,
    forwardedFor: req.headers['x-forwarded-for'],
    trustedProxyHops: appConfig.resetTrustProxyHops
  });
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
const humanSupportRequestRateLimiter = createInMemoryRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 1
});

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
  const requestId = buildRequestId('req');

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
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

const mistralTransport = createMistralTransport({
  apiKey: appConfig.mistralApiKey,
  onUsage: appendLlmUsageToCurrentRequest
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readModelId(envKey, fallback) {
  const configuredValue = String(process.env[envKey] || '').trim();
  return configuredValue || fallback;
}

const MISTRAL_MODEL_IDS = {
  analysis: readModelId('MISTRAL_MODEL_ANALYSIS', 'mistral-small-latest'),
  generation: readModelId('MISTRAL_MODEL_GENERATION', 'mistral-medium-latest'),
  memory: readModelId('MISTRAL_MODEL_MEMORY', 'mistral-medium-latest'),
  title: readModelId('MISTRAL_MODEL_TITLE', 'mistral-small-latest')
};

const requestTitleFromMistral = createTitleRequester({
  transport: mistralTransport,
  modelId: MISTRAL_MODEL_IDS.title
});

const { analyzeModelConflict, rewriteConflictModelContent } =
  createTitleConflictProtection({
    mistralTransport,
    analysisModelId: MISTRAL_MODEL_IDS.analysis,
    titleModelId: MISTRAL_MODEL_IDS.title,
    normalizeMemory
  });

function createEmailNotifier() {
  const notifyTo = String(process.env.NOTIFY_EMAIL_TO || '').trim();
  const humanRelayTo = String(process.env.HUMAN_RELAY_EMAIL_TO || '').trim();
  const smtpHost = String(
    process.env.NOTIFY_SMTP_HOST || 'smtp.hostinger.com'
  ).trim();
  const smtpPort = Number(process.env.NOTIFY_SMTP_PORT || 465);
  const smtpSecure =
    String(process.env.NOTIFY_SMTP_SECURE || 'true')
      .trim()
      .toLowerCase() === 'true';
  const smtpUser = String(process.env.NOTIFY_SMTP_USER || '').trim();
  const smtpPass = String(process.env.NOTIFY_SMTP_PASSWORD || '').trim();
  const fromAddress = String(process.env.NOTIFY_EMAIL_FROM || smtpUser).trim();

  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
    return {
      enabled: false,
      humanRelayEnabled: false,
      sendNewMessageAlert: async () => false,
      sendHumanSupportRequest: async () => false,
      sendPasswordReset: null
    };
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: smtpUser,
      pass: smtpPass
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000
  });

  async function send(to, subject, text) {
    if (!to) return false;

    try {
      await transporter.sendMail({
        from: fromAddress,
        to,
        subject,
        text
      });
      return true;
    } catch (err) {
      logger.error({ event: 'notify_email_error', error: err.message });
      return false;
    }
  }

  const sendPasswordReset = createResetEmailSender({
    transporter,
    fromAddress,
    logger
  });

  return {
    enabled: true,
    humanRelayEnabled: Boolean(humanRelayTo),
    sendPasswordReset,
    async sendNewMessageAlert() {
      return send(
        notifyTo,
        '[Facilitat.io] Nouveau message utilisateur',
        [
          'Il y a un ou plusieurs nouveaux messages enregistr\u00e9s dans Firebase.',
          "Rappel: une seule alerte est envoy\u00e9e tant que l'admin n'est pas revenue sur /admin.html"
        ].join('\n')
      );
    },
    async sendHumanSupportRequest({
      userId,
      userEmail,
      conversationId,
      isPrivateConversation,
      requestType
    }) {
      if (!humanRelayTo) return false;
      if (!['service_contact', 'human_support'].includes(requestType)) {
        return false;
      }

      const requestLabel =
        requestType === 'service_contact'
          ? "contact avec l'equipe ou le responsable apres un probleme de service"
          : 'accompagnement par un professionnel humain';
      return send(
        humanRelayTo,
        `[Facilitat.io] Demande de relais humain - ${requestType}`,
        [
          `Type de demande (requestType) : ${requestType}`,
          `Libelle : ${requestLabel}`,
          `Identifiant utilisateur : ${String(userId || '').trim()}`,
          `Adresse de contact : ${normalizeEmail(userEmail) || 'indisponible'}`,
          isPrivateConversation === true
            ? 'Conversation : privee (identifiant et contenu non transmis)'
            : `Identifiant de conversation : ${String(conversationId || '').trim() || 'indisponible'}`,
          '',
          "La personne a explicitement consenti a transmettre cette demande de contact.",
          "Aucun contenu de conversation n'est joint."
        ].join('\n')
      );
    }
  };
}

const emailNotifier = createEmailNotifier();
const passwordResetService = createPasswordResetService({
  usersRef,
  findUserByEmail,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  isStrongPassword,
  sendResetEmail: emailNotifier.sendPasswordReset,
  canonicalAppUrl: appConfig.publicAppUrl,
  onJobError: () => logger.error({ event: 'password_reset_job_failed' })
});

function readPositiveIntegerEnv(name, fallback) {
  const raw = Number.parseInt(String(process.env[name] || ''), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function createOffTopicAbuseEmailNotifier() {
  const notifyTo = String(
    process.env.SECURITY_ALERT_EMAIL_TO || 'vigilance@facilitat.io'
  ).trim();
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
      sendOffTopicAbuseAlert: async () => false
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

  return {
    enabled: true,
    async sendOffTopicAbuseAlert({
      userId,
      conversationId,
      requestId,
      offTopicInfoPolicy,
      windowCount,
      windowStartedAt,
      threshold,
      cooldownHours
    }) {
      const safeUserId = String(userId || '').trim();
      if (!safeUserId) return false;

      const startedAtIso =
        Number.isFinite(windowStartedAt) && windowStartedAt > 0
          ? new Date(windowStartedAt).toISOString()
          : null;

      const subject = `[Facilitat.io][Vigilance] Usage hors perimetre repete - ${safeUserId}`;
      const text = [
        'Alerte automatique de vigilance (sans contenu message).',
        '',
        `userId: ${safeUserId}`,
        `conversationId: ${String(conversationId || '').trim() || 'unknown'}`,
        `requestId: ${String(requestId || '').trim() || 'unknown'}`,
        `policy: ${String(offTopicInfoPolicy || 'none')}`,
        `windowCount: ${Number.isInteger(windowCount) ? windowCount : 0}`,
        `windowStartedAt: ${startedAtIso || 'unknown'}`,
        `threshold: ${threshold}`,
        `cooldownHours: ${cooldownHours}`,
        `sentAt: ${new Date().toISOString()}`
      ].join('\n');

      try {
        await transporter.sendMail({
          from: fromAddress,
          to: notifyTo,
          subject,
          text
        });
        return true;
      } catch (err) {
        logger.error({
          event: 'off_topic_abuse_email_error',
          userId: safeUserId,
          error: err.message
        });
        return false;
      }
    }
  };
}

const OFF_TOPIC_ABUSE_WINDOW_MS =
  readPositiveIntegerEnv('OFF_TOPIC_ALERT_WINDOW_HOURS', 6) * 60 * 60 * 1000;
const OFF_TOPIC_ABUSE_THRESHOLD = readPositiveIntegerEnv(
  'OFF_TOPIC_ALERT_THRESHOLD',
  6
);
const OFF_TOPIC_ABUSE_COOLDOWN_HOURS = readPositiveIntegerEnv(
  'OFF_TOPIC_ALERT_COOLDOWN_HOURS',
  24
);
const OFF_TOPIC_ABUSE_COOLDOWN_MS =
  OFF_TOPIC_ABUSE_COOLDOWN_HOURS * 60 * 60 * 1000;
const offTopicAbuseEmailNotifier = createOffTopicAbuseEmailNotifier();

function normalizeOffTopicAbuseMonitoringState(state) {
  const safe = state && typeof state === 'object' ? state : {};
  return {
    windowStartedAt:
      Number.isInteger(safe.windowStartedAt) && safe.windowStartedAt > 0
        ? safe.windowStartedAt
        : 0,
    windowCount:
      Number.isInteger(safe.windowCount) && safe.windowCount > 0
        ? safe.windowCount
        : 0,
    lastSeenAt:
      Number.isInteger(safe.lastSeenAt) && safe.lastSeenAt > 0
        ? safe.lastSeenAt
        : 0,
    lastAlertAt:
      Number.isInteger(safe.lastAlertAt) && safe.lastAlertAt > 0
        ? safe.lastAlertAt
        : 0,
    lastAlertRequestId:
      typeof safe.lastAlertRequestId === 'string' ? safe.lastAlertRequestId : '',
    lastAlertConversationId:
      typeof safe.lastAlertConversationId === 'string'
        ? safe.lastAlertConversationId
        : '',
    totalAlertsSent:
      Number.isInteger(safe.totalAlertsSent) && safe.totalAlertsSent >= 0
        ? safe.totalAlertsSent
        : 0
  };
}

async function evaluateAndNotifyOffTopicAbuse({
  userId,
  conversationId,
  requestId,
  offTopicInfoPolicy
}) {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) {
    return;
  }

  if (
    offTopicInfoPolicy !== 'out_of_scope_recenter' &&
    offTopicInfoPolicy !== 'out_of_scope_micro_bridge_then_recenter'
  ) {
    return;
  }

  const now = Date.now();
  const userAbuseRef = usersRef.child(safeUserId).child('offTopicAbuseMonitoring');
  let shouldSendAlert = false;
  let txState = null;

  try {
    const txResult = await userAbuseRef.transaction((current) => {
      const safe = normalizeOffTopicAbuseMonitoringState(current);
      const inWindow =
        safe.windowStartedAt > 0 && now - safe.windowStartedAt <= OFF_TOPIC_ABUSE_WINDOW_MS;
      const nextWindowStartedAt = inWindow ? safe.windowStartedAt : now;
      const nextWindowCount = inWindow ? safe.windowCount + 1 : 1;

      const cooldownReady =
        safe.lastAlertAt <= 0 || now - safe.lastAlertAt >= OFF_TOPIC_ABUSE_COOLDOWN_MS;
      const thresholdReached = nextWindowCount >= OFF_TOPIC_ABUSE_THRESHOLD;

      shouldSendAlert = cooldownReady && thresholdReached;

      return {
        windowStartedAt: nextWindowStartedAt,
        windowCount: nextWindowCount,
        lastSeenAt: now,
        lastAlertAt: shouldSendAlert ? now : safe.lastAlertAt,
        lastAlertRequestId: shouldSendAlert
          ? String(requestId || '').trim()
          : safe.lastAlertRequestId,
        lastAlertConversationId: shouldSendAlert
          ? String(conversationId || '').trim()
          : safe.lastAlertConversationId,
        totalAlertsSent: shouldSendAlert
          ? safe.totalAlertsSent + 1
          : safe.totalAlertsSent
      };
    });

    if (!txResult || txResult.committed !== true || !txResult.snapshot) {
      return;
    }

    txState = normalizeOffTopicAbuseMonitoringState(txResult.snapshot.val());
  } catch (err) {
    logger.error({
      event: 'off_topic_abuse_monitoring_tx_error',
      userId: safeUserId,
      error: err.message
    });
    return;
  }

  if (!shouldSendAlert || offTopicAbuseEmailNotifier.enabled !== true) {
    return;
  }

  const sent = await offTopicAbuseEmailNotifier.sendOffTopicAbuseAlert({
    userId: safeUserId,
    conversationId,
    requestId,
    offTopicInfoPolicy,
    windowCount: txState ? txState.windowCount : 0,
    windowStartedAt: txState ? txState.windowStartedAt : 0,
    threshold: OFF_TOPIC_ABUSE_THRESHOLD,
    cooldownHours: OFF_TOPIC_ABUSE_COOLDOWN_HOURS
  });

  if (sent) {
    logger.warn({
      event: 'off_topic_abuse_alert_sent',
      userId: safeUserId,
      conversationId: String(conversationId || '').trim() || null,
      requestId: String(requestId || '').trim() || null,
      offTopicInfoPolicy,
      windowCount: txState ? txState.windowCount : null,
      threshold: OFF_TOPIC_ABUSE_THRESHOLD,
      cooldownHours: OFF_TOPIC_ABUSE_COOLDOWN_HOURS
    });
  }
}

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

const healthHandler = createHealthHandler();
app.get('/health', healthHandler);
app.get('/version', healthHandler);

app.get('/admin.html', requireAdministratorPage, (req, res) => {
  if (String(req.query.view || '').trim().toLowerCase() === 'support') {
    return res.redirect('/support-admin.html');
  }

  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(__dirname + '/public/admin.html');
});

app.get('/pros.html', requireProfessionalHubAuth, (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(__dirname + '/public/pros.html');
});

app.get('/support-admin.html', requireSupportAdminAuth, (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(__dirname + '/public/support-admin.html');
});

app.get('/facilitation-admin.html', requireFacilitationAdminAuth, (req, res) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(__dirname + '/public/facilitation-admin.html');
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

function buildUserSessionToken(userId, authVersion = 0, createdAt = Date.now()) {
  return userSessionCodec.build(userId, authVersion, createdAt);
}

function parseAndValidateUserSessionToken(token) {
  return userSessionCodec.parse(token);
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
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
async function getAdminSession(req) {
  return professionalAccess.session(parseCookies(req).adminSessionId);
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

  if (!sessionMatchesUser(session, userData)) {
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

    if (
      req.headers['x-client-identity'] &&
      req.headers['x-client-identity'] !== session.userId
    )
      return res.status(409).json({ error: 'Client identity changed', code: 'identity_changed' });
    req.userSession = session;
    const { idValid } = require('./lib/professional-access');
    if (req.body?.userId !== undefined && req.body.userId !== session.userId)
      return res.status(403).json({ error: 'Actor mismatch' });
    for (const key of ['id', 'conversationId', 'professionalId'])
      if (req.params?.[key] && !idValid(req.params[key]))
        return res.status(400).json({ error: 'Invalid object reference' });
    for (const key of [
      'conversationId',
      'sourceConversationId',
      'branchConversationId',
      'requestId',
    ])
      if (
        req.body?.[key] !== undefined &&
        req.body[key] !== null &&
        !idValid(req.body[key])
      )
        return res.status(400).json({ error: 'Invalid object reference' });
    const bodyConversationId =
      req.body?.sourceConversationId || req.body?.conversationId;
    const pathConversationId =
      req.path.includes('/conversations/') &&
      !['claim', 'import-local'].includes(req.params?.id)
        ? req.params?.id
        : null;
    const targetId = pathConversationId || bodyConversationId;
    const privateTransit =
      req.body?.isPrivateConversation === true &&
      [
        '/chat',
        '/chat/stream',
        '/chat/stream/interrupted',
        '/session/close',
        '/api/session/beacon',
        '/api/human-support/request',
      ].includes(req.path);
    if (targetId && !privateTransit) {
      const current = (
        await db.ref('conversations').child(targetId).once('value')
      ).val();
      if (
        current &&
        (current.userId !== session.userId ||
          current.deletedAt ||
          current.isPrivate === true)
      )
        return res.status(403).json({ error: 'Object ownership required' });
      if (!current && ['/chat', '/chat/stream'].includes(req.path)) {
        const orphan = (
          await messagesRef
            .orderByChild('conversationId')
            .equalTo(targetId)
            .once('value')
        ).val();
        if (orphan && Object.keys(orphan).length)
          return res
            .status(403)
            .json({ error: 'Historical ownership proof required' });
        const claimed = await db
          .ref('conversations')
          .child(targetId)
          .transaction((old) =>
            old
              ? undefined
              : { userId: session.userId, createdAt: new Date().toISOString() },
          );
        if (!claimed.committed)
          return res.status(409).json({ error: 'Concurrent object claim' });
      } else if (!current)
        return res.status(404).json({ error: 'Object unavailable' });
    }
    if (req.path.startsWith('/api/messages/')) {
      const m = (await messagesRef.child(req.params.id).once('value')).val();
      if (m?.userId !== session.userId)
        return res.status(403).json({ error: 'Message ownership required' });
      const c = (
        await db.ref('conversations').child(m.conversationId).once('value')
      ).val();
      if (c?.userId !== session.userId || c.deletedAt || c.isPrivate === true)
        return res.status(403).json({ error: 'Object ownership required' });
    }
    if (req.path.startsWith('/api/branches/') && req.params.id) {
      const branch = (
        await branchRecordsRef.child(req.params.id).once('value')
      ).val();
      if (!branch || branch.userId !== session.userId)
        return res.status(403).json({ error: 'Branch ownership required' });
      if (
        !idValid(branch.sourceConversationId) ||
        !idValid(branch.branchConversationId)
      )
        return res.status(403).json({ error: 'Branch object mismatch' });
      const source = await readConversationAuthority(
        branch.sourceConversationId,
      );
      if (
        source?.userId !== session.userId ||
        source.deletedAt ||
        source.isPrivate === true
      )
        return res.status(403).json({ error: 'Branch source mismatch' });
      const destination = await readConversationAuthority(
        branch.branchConversationId,
      );
      if (
        destination.exists &&
        (destination.userId !== session.userId ||
          destination.deletedAt ||
          destination.isPrivate === true)
      )
        return res.status(403).json({ error: 'Branch destination mismatch' });
      const seed = (
        await branchSeedSnapshotsRef.child(req.params.id).once('value')
      ).val();
      if (
        seed &&
        (seed.sourceConversationId !== branch.sourceConversationId ||
          (seed.userId && seed.userId !== session.userId) ||
          seed.messages?.some((m) => m.userId && m.userId !== session.userId))
      )
        return res.status(403).json({ error: 'Branch seed mismatch' });
    }
    const sendJson = res.json.bind(res);
    res.json = async (body) => {
      try {
      if (res.statusCode < 400 && !res.locals.lifecycleTransition &&
          !(req.method === 'DELETE') &&
          !await lifecycle.available(session.userId, privateTransit ? null : targetId)) {
        res.status(410);
        return sendJson({ code: 'lifecycle_object_retired', error: 'Object unavailable' });
      }
      return sendJson(body);
      } catch {
        // Some existing handlers intentionally do not await json(). Never leak
        // a rejection or acknowledge content when the final authority read fails.
        if (!res.headersSent) {
          res.status(503);
          return sendJson({ code: 'lifecycle_availability_unknown', error: 'Verification unavailable' });
        }
        if (!res.writableEnded) res.end();
        return res;
      }
    };
    return next();
  } catch (err) {
    if (err.code?.startsWith('lifecycle_')) return res.status(410).json({ code: err.code });
    console.error('Erreur requireUserAuth:', err.message);
    return res.status(500).json({ error: 'Auth check failed' });
  }
}

async function readConversationAuthority(id) {
  const ref = db.ref('conversations').child(id);
  const [owner, privacy, removed] = await Promise.all(
    ['userId', 'isPrivate', 'deletedAt'].map((key) =>
      ref.child(key).once('value'),
    ),
  );
  const userId = owner.val(),
    isPrivate = privacy.val(),
    deletedAt = removed.val();
  // The existence-only fallback quarantines old parent objects without an owner.
  const exists =
    userId !== null ||
    isPrivate !== null ||
    deletedAt !== null ||
    (await ref.once('value')).exists();
  return { userId, isPrivate, deletedAt, exists };
}

async function assertConversationOwner(userId, conversationId) {
  const current = (
    await db.ref('conversations').child(conversationId).once('value')
  ).val();
  if (
    !current ||
    current.userId !== userId ||
    current.deletedAt ||
    current.isPrivate === true
  ) {
    const error = new Error('Object authorization lost');
    error.code = 'object_authority_lost';
    throw error;
  }
  return current;
}
async function updateOwnedConversation(ref, userId, patch) {
  const result = await ref.transaction((current) =>
    current &&
    current.userId === userId &&
    !current.deletedAt &&
    current.isPrivate !== true
      ? { ...current, ...patch }
      : undefined,
  );
  if (!result.committed) {
    const error = new Error('Object authorization lost');
    error.code = 'object_authority_lost';
    throw error;
  }
}
function messageBelongsToConversation(message, userId, conversationId) {
  return (
    !!message &&
    message.userId === userId &&
    message.conversationId === conversationId &&
    message.isPrivate !== true &&
    !message.deletedAt
  );
}

// Les données conversationnelles exigent une session utilisateur serveur.

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
  return String(req.userSession?.userId || '').trim();
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
async function requireAdministratorPage(req, res, next) {
  const session = await getAdminSession(req);
  if (!session?.roles.includes('administrator'))
    return res.status(session ? 403 : 401).end();
  next(); // HTML shell contains no data; every API separately requires a reason.
}
async function requireAdminAuth(req, res, next) {
  const session = await getAdminSession(req);
  const reason = req.headers['x-access-reason'];
  const allowed =
    session?.roles.includes('administrator') && REASONS.has(reason);
  await professionalAccess.journal({
    actor: session,
    role: 'administrator',
    action: 'admin_access',
    object: professionalAccess.reference(
      'object',
      String(
        req.params?.id ||
          req.params?.userId ||
          req.route?.path ||
          'unknown_route',
      ),
    ),
    reason: allowed ? reason : 'administrator_reason_required',
    result: allowed ? 'allowed' : 'denied',
    requestId: req.requestId,
  });
  if (!allowed)
    return res
      .status(session ? 403 : 401)
      .json({
        error: 'Professional authorization required',
        code: 'administrator_reason_required',
      });
  req.professionalSession = session;
  const unmask = req.headers['x-identity-unmask-reason'];
  if (REASONS.has(unmask))
    await professionalAccess.journal({
      actor: session,
      role: 'administrator',
      action: 'identity_unmask',
      object: professionalAccess.reference(
        'route',
        String(req.route?.path || 'unknown_route'),
      ),
      reason: unmask,
      result: 'allowed',
      requestId: req.requestId,
    });
  const json = res.json.bind(res);
  res.json = (payload) => {
    function project(value) {
      if (Array.isArray(value))
        return value.filter((x) => x?.isPrivate !== true).map(project);
      if (!value || typeof value !== 'object') return value;
      if (value.isPrivate === true) return null;
      const out = {};
      for (const [key, v] of Object.entries(value)) {
        if (
          [
            'hasPrivateInteractionSinceLastVisible',
            'lastPrivateInteractionAt',
          ].includes(key)
        )
          continue;
        if (
          !REASONS.has(unmask) &&
          [
            'email',
            'emails',
            'userEmail',
            'firstName',
            'userId',
            'userLabel',
            'displayUser',
            'displayName',
          ].includes(key)
        )
          continue;
        if (
          !REASONS.has(unmask) &&
          ['superId', 'stableSuperId'].includes(key)
        ) {
          out[key] = professionalAccess.reference('user', String(v));
          continue;
        }
        out[key] = project(v);
      }
      return out;
    }
    return json(project(payload));
  };
  next();
}

async function requireProfessionalHubAuth(req, res, next) {
  const session = await getAdminSession(req);

  const hasAccess =
    session &&
    (session.canAccessAdminConversations === true ||
      session.canAccessSupportCases === true ||
      session.canAccessFacilitationAdmin === true);

  if (!hasAccess) {
    const nextUrl = encodeURIComponent(require('./public/js/local-destination').resolve(req.originalUrl,'/pros.html'));
    return res.redirect(`/pros-login.html?next=${nextUrl}`);
  }

  adminVisitedSinceLastAlert = true;
  next();
}

async function requireSupportAdminAuth(req, res, next) {
  const session = await getAdminSession(req);

  if (!session || session.canAccessSupportCases !== true) {
    const nextUrl = encodeURIComponent(require('./public/js/local-destination').resolve(req.originalUrl,'/pros.html'));
    return res.redirect(`/pros-login.html?next=${nextUrl}`);
  }
  adminVisitedSinceLastAlert = true;
  next();
}

async function requireFacilitationAdminAuth(req, res, next) {
  const session = await getAdminSession(req);

  if (!session || session.canAccessFacilitationAdmin !== true) {
    const nextUrl = encodeURIComponent(require('./public/js/local-destination').resolve(req.originalUrl,'/pros.html'));
    return res.redirect(`/pros-login.html?next=${nextUrl}`);
  }
  adminVisitedSinceLastAlert = true;
  next();
}

function parseTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  const asString = String(value || '').trim();
  if (!asString) return 0;

  const asNumber = Number(asString);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber;
  }

  const parsed = Date.parse(asString);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoOrNullFromMs(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function buildFacilitationRef(kind = '', sourceId = '') {
  const safeKind = String(kind || '').trim();
  const safeId = String(sourceId || '').trim();
  if (!safeKind || !safeId) return null;

  const digest = crypto
    .createHmac('sha256', ADMIN_SESSION_SIGNING_SECRET)
    .update(`${safeKind}:${safeId}`)
    .digest('hex')
    .slice(0, 24);

  return `fac_${safeKind}_${digest}`;
}

function isFacilitationSecondaryProfile(userId = '', userEmail = '') {
  const safeUserId = String(userId || '').trim();
  const safeEmail = normalizeEmail(userEmail || '');

  return (
    (safeUserId && SECONDARY_CONVERSATION_USER_IDS.has(safeUserId)) ||
    (safeEmail && SECONDARY_CONVERSATION_EMAILS.has(safeEmail))
  );
}

async function buildFacilitationDirectoryModel() {
  const [usersSnap, labelsSnap, conversationsSnap, messagesSnap] =
    await Promise.all([
      usersRef.once('value'),
      userLabelsRef.once('value'),
      db.ref('conversations').once('value'),
      messagesRef.once('value')
    ]);

  const usersRaw = usersSnap.val() || {};
  const labelsRaw = labelsSnap.val() || {};
  const conversationsRaw = conversationsSnap.val() || {};
  const messagesRaw = messagesSnap.val() || {};

  const conversationById = new Map();
  const userStateById = new Map();

  function getUserState(userId) {
    const safeUserId = String(userId || '').trim();
    if (!safeUserId) return null;

    if (!userStateById.has(safeUserId)) {
      userStateById.set(safeUserId, {
        userId: safeUserId,
        userRef: buildFacilitationRef('user', safeUserId),
        visibleConversationIds: [],
        allConversationIds: [],
        lastVisibleConversationActivityMs: 0,
        lastVisibleUserMessageMs: 0,
        lastAnyUserMessageMs: 0,
        lastAnyUserMessageIsPrivate: false,
        hasName: false,
        displayName: null
      });
    }

    return userStateById.get(safeUserId);
  }

  for (const [conversationId, value] of Object.entries(conversationsRaw)) {
    const safeConversation = value && typeof value === 'object' ? value : {};
    if (safeConversation.isBranch === true) {
      continue;
    }

    const userId = String(safeConversation.userId || '').trim();
    if (!userId) {
      continue;
    }

    const safeUser =
      usersRaw[userId] && typeof usersRaw[userId] === 'object'
        ? usersRaw[userId]
        : {};
    const userEmail = normalizeEmail(safeUser.email || '');
    if (isFacilitationSecondaryProfile(userId, userEmail)) {
      continue;
    }

    const isPrivate = safeConversation.isPrivate === true;
    const updatedAtMs = parseTimestampMs(
      safeConversation.updatedAt || safeConversation.createdAt
    );

    const conversationRef = buildFacilitationRef('conversation', conversationId);
    const displayTitle =
      typeof safeConversation.title === 'string' && safeConversation.title.trim()
        ? safeConversation.title.trim()
        : typeof safeConversation.lastUserMessage === 'string' &&
            safeConversation.lastUserMessage.trim()
          ? safeConversation.lastUserMessage.trim().slice(0, 60)
          : '(sans titre)';

    const conversationMeta = {
      id: conversationId,
      ref: conversationRef,
      userId,
      isPrivate,
      updatedAtMs,
      createdAtMs: parseTimestampMs(safeConversation.createdAt),
      displayTitle,
      messageCount: Number(safeConversation.messageCount || 0),
      lastUserMessageMs: 0
    };

    conversationById.set(conversationId, conversationMeta);

    const state = getUserState(userId);
    if (!state) {
      continue;
    }

    state.allConversationIds.push(conversationId);
    if (!isPrivate) {
      state.visibleConversationIds.push(conversationId);
      if (updatedAtMs > state.lastVisibleConversationActivityMs) {
        state.lastVisibleConversationActivityMs = updatedAtMs;
      }
    }
  }

  for (const [, value] of Object.entries(messagesRaw)) {
    const safeMessage = value && typeof value === 'object' ? value : {};
    if (String(safeMessage.role || '') !== 'user') {
      continue;
    }

    const conversationId = String(safeMessage.conversationId || '').trim();
    if (!conversationId) {
      continue;
    }

    const conversationMeta = conversationById.get(conversationId);
    if (!conversationMeta) {
      continue;
    }

    const state = getUserState(conversationMeta.userId);
    if (!state) {
      continue;
    }

    const messageTimestampMs = parseTimestampMs(safeMessage.timestamp);
    if (messageTimestampMs <= 0) {
      continue;
    }

    if (messageTimestampMs > state.lastAnyUserMessageMs) {
      state.lastAnyUserMessageMs = messageTimestampMs;
      state.lastAnyUserMessageIsPrivate = conversationMeta.isPrivate === true;
    }

    if (!conversationMeta.isPrivate) {
      if (messageTimestampMs > state.lastVisibleUserMessageMs) {
        state.lastVisibleUserMessageMs = messageTimestampMs;
      }
      if (messageTimestampMs > conversationMeta.lastUserMessageMs) {
        conversationMeta.lastUserMessageMs = messageTimestampMs;
      }
    }
  }

  const users = [];
  for (const state of userStateById.values()) {
    if (!Array.isArray(state.visibleConversationIds) || state.visibleConversationIds.length === 0) {
      continue;
    }

    const safeUser =
      usersRaw[state.userId] && typeof usersRaw[state.userId] === 'object'
        ? usersRaw[state.userId]
        : {};
    const firstName =
      typeof safeUser.firstName === 'string' && safeUser.firstName.trim()
        ? safeUser.firstName.trim()
        : null;
    const label =
      typeof labelsRaw[state.userId] === 'string' && labelsRaw[state.userId].trim()
        ? labelsRaw[state.userId].trim()
        : null;

    state.hasName = !!(firstName || label);
    state.displayName = firstName || label || null;

    const publicInteractionMs = Math.max(
      state.lastVisibleUserMessageMs,
      state.lastVisibleConversationActivityMs
    );


    users.push({
      userId: state.userId,
      userRef: state.userRef,
      displayName: state.displayName,
      hasExplicitName: state.hasName,
      visibleConversationCount: state.visibleConversationIds.length,
      lastInteractionMs: publicInteractionMs,
      lastInteractionAt: toIsoOrNullFromMs(publicInteractionMs),
      conversationIds: state.visibleConversationIds.slice()
    });
  }

  users.sort((a, b) => {
    const delta = Number(b.lastInteractionMs || 0) - Number(a.lastInteractionMs || 0);
    if (delta !== 0) return delta;
    return String(a.userId || '').localeCompare(String(b.userId || ''));
  });

  let anonymousCounter = 0;
  const userByRef = new Map();
  for (const user of users) {
    if (!user.displayName) {
      anonymousCounter += 1;
      user.displayName = `Personne accompagnée ${anonymousCounter}`;
    }

    userByRef.set(user.userRef, user);
  }

  const conversationByRef = new Map();
  for (const conversation of conversationById.values()) {
    if (conversation.isPrivate) {
      continue;
    }
    conversationByRef.set(conversation.ref, conversation);
  }

  return {
    users,
    userByRef,
    conversationByRef,
    conversationById
  };
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
  const text = normalizeIntersessionMemorySource(memory);
  if (text) return text;

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
  return normalizeIntersessionMemorySource(
    raw.replace(/^m[ée]moire\s+inter-?session\s*:\s*/i, '')
  );
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
const llmInfoAnalysis = createInformationRequestAnalyzer({
  mistralTransport,
  modelId: MISTRAL_MODEL_IDS.analysis,
  trimInfoAnalysisHistory
});

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
  mistralTransport,
  MISTRAL_MODEL_IDS,
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
  userId = '',
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
    await assertConversationOwner(userId,conversationId);
    const messagesSnap = await messagesRef
      .orderByChild('conversationId')
      .equalTo(conversationId)
      .once('value');

    const branchHistory = Object.values(messagesSnap.val() || {})
      .filter(
        (m) =>
          messageBelongsToConversation(m,userId,conversationId)&&
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
  mistralTransport,
  MISTRAL_MODEL_IDS,
  normalizeIntersessionMemory,
  normalizeMemory
});

const { generateReply } = createWriter({
  mistralTransport,
  MISTRAL_MODEL_IDS,
  normalizeMemory
});
const { generateReply: generateCrisisReply } = createWriter({
  mistralTransport,
  MISTRAL_MODEL_IDS,
  normalizeMemory
});

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
app.post('/session/close', requireUserAuth, async (req, res) => {
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

    return requestTitleFromMistral(sourceText, effectiveForbidden);
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
    const session = await getAdminSession(req);
    if (!session) {
      return res.json({ authenticated: false });
    }

    const canUseAdminUi = session.canUseAdminUi !== false;
    const canBypassTwaGate = session.canBypassTwaGate === true;
    const welcomeAnimationPolicy =
      session.welcomeAnimationPolicy === 'skip' ||
      session.welcomeAnimationPolicy === 'play'
        ? session.welcomeAnimationPolicy
        : null;

    return res.json({
      authenticated: true,
      canBypassTwaGate,
      welcomeAnimationPolicy,
      canUseAdminUi,
      canAccessAdminConversations:
        session.canAccessAdminConversations === true,
      canAccessSupportCases: session.canAccessSupportCases === true,
      canAccessFacilitationAdmin:
        session.canAccessFacilitationAdmin === true,
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

function writeAdminSessionCookie(res, sessionId) {
  res.setHeader(
    'Set-Cookie',
    `adminSessionId=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${Math.floor(ADMIN_SESSION_DURATION / 1000)}`
  );
}

app.post('/api/twa/login', (_req, res) => {
  return res
    .status(403)
    .json({
      error: 'Individual authentication required',
      code: 'legacy_twa_bypass_revoked',
    });
});

async function handleProsLogin(req, res) {
  if (
    typeof req.body?.email !== 'string' ||
    typeof req.body?.password !== 'string'
  )
    return res.status(400).json({ error: 'Invalid pros login request' });
  if (!enforceAuthRateLimit(req, res, 'login', normalizeEmail(req.body.email)))
    return;
  const token = await professionalAccess.login(
    req.body.email,
    req.body.password,
  );
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  writeAdminSessionCookie(res, token);
  return res.json({ success: true, flow: 'pros' });
}

app.post('/api/pros/login', handleProsLogin);

// Legacy alias kept for backward compatibility.
app.post('/api/admin/login', handleProsLogin);

// Admin logout route that clears the session cookie and removes the session.
app.post('/api/admin/logout', async (req, res) => {
  const cookies = parseCookies(req);
  const sessionId = cookies.adminSessionId;

  if (sessionId) {
    await professionalAccess.revoke(sessionId);
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
    const isAdmin = Boolean(await getAdminSession(req));

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

app.post('/api/human-support/request', requireUserAuth, async (req, res) => {
  try {
    const allowedBodyFields = new Set([
      'consent',
      'requestType',
      'conversationId',
      'isPrivateConversation'
    ]);
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => !allowedBodyFields.has(key))
    ) {
      return res.status(400).json({ error: 'Demande de relais invalide' });
    }
    if (req.body?.consent !== true) {
      return res.status(400).json({ error: 'Consentement explicite requis' });
    }

    const requestType =
      req.body?.requestType === 'service_contact'
        ? 'service_contact'
        : req.body?.requestType === 'human_support'
          ? 'human_support'
          : null;
    if (!requestType) {
      return res.status(400).json({ error: 'Type de demande invalide' });
    }
    if (emailNotifier.humanRelayEnabled !== true) {
      return res.status(503).json({ error: 'Relais humain indisponible' });
    }

    const session = req.userSession;
    const isPrivateConversation = req.body?.isPrivateConversation === true;
    const conversationId = String(req.body?.conversationId || '').trim();
    let shareableConversationId = null;

    if (!isPrivateConversation && conversationId) {
      const snapshot = await db
        .ref('conversations')
        .child(conversationId)
        .once('value');
      const conversation = snapshot.val();
      if (
        !conversation ||
        String(conversation.userId || '') !== String(session.userId || '')
      ) {
        return res.status(403).json({ error: 'Conversation non partageable' });
      }
      shareableConversationId = conversationId;
    }

    const rateLimitKey = `human_support|${requestType}|${String(session.userId || '').trim()}`;
    const rateLimitResult = humanSupportRequestRateLimiter.check(rateLimitKey);
    if (!rateLimitResult.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Une demande a deja ete prise en compte recemment'
      });
    }

    const sent = await emailNotifier.sendHumanSupportRequest({
      userId: session.userId,
      userEmail: session.user?.email,
      conversationId: shareableConversationId,
      isPrivateConversation,
      requestType
    });
    if (!sent) {
      humanSupportRequestRateLimiter.reset(rateLimitKey);
      return res.status(502).json({ error: 'Transmission non confirmee' });
    }

    logger.info({
      event: 'human_support_request_sent',
      userId: String(session.userId || ''),
      requestType,
      isPrivateConversation,
      hasShareableConversationId: !!shareableConversationId
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error({ event: 'human_support_request_failed', error: err.message });
    return res.status(500).json({ error: 'Transmission non confirmee' });
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
      authVersion: 0,
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

    const sessionToken = buildUserSessionToken(userId, userRecord.authVersion);
    userSessions.set(sessionToken, {
      userId,
      createdAt: Date.now(),
      authVersion: userRecord.authVersion
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

    const authVersion = Number.isSafeInteger(found.user.authVersion)
      ? found.user.authVersion
      : 0;
    const sessionToken = buildUserSessionToken(found.userId, authVersion);
    userSessions.set(sessionToken, {
      userId: found.userId,
      createdAt: Date.now(),
      authVersion
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

function setPasswordResetResponseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
}

app.post('/api/auth/forgot-password', async (req, res) => {
  setPasswordResetResponseHeaders(res);
  if (!passwordResetService.enabled) {
    return res.status(503).json({ error: 'Le service de réinitialisation est momentanément indisponible.' });
  }
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    passwordResetService.request({ email, ip: getPasswordResetClientIp(req) });
  } catch {
    logger.error({ event: 'password_reset_request_failed' });
  }
  return res.status(202).json({ success: true, message: NEUTRAL_REQUEST_MESSAGE });
});

app.post('/api/auth/reset-password', async (req, res) => {
  setPasswordResetResponseHeaders(res);
  if (!passwordResetService.enabled) {
    return res.status(503).json({ error: 'Le service de réinitialisation est momentanément indisponible.' });
  }
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    const outcome = await passwordResetService.consume({
      token,
      newPassword,
      ip: getPasswordResetClientIp(req)
    });
    if (outcome.status === 'rate_limited') {
      return res.status(429).json({ error: 'Trop de tentatives. Veuillez réessayer plus tard.' });
    }
    if (outcome.status === 'weak_password') {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 10 caractères, avec au moins une lettre et un chiffre.' });
    }
    if (outcome.status === 'expired') {
      return res.status(410).json({ error: 'Ce lien de réinitialisation a expiré.' });
    }
    if (outcome.status !== 'success') {
      return res.status(400).json({ error: 'Ce lien de réinitialisation est invalide ou a déjà été utilisé.' });
    }
    return res.json({ success: true });
  } catch {
    logger.error({ event: 'password_reset_consume_failed' });
    return res.status(400).json({ error: 'Ce lien de réinitialisation est invalide ou a déjà été utilisé.' });
  }
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

    if (!isStrongPassword(newPassword)) {
      return res
        .status(400)
        .json({
          error:
            'Password must contain at least 10 characters, including at least one letter and one number'
        });
    }

    const outcome = await passwordResetService.changePassword({
      userId: session.userId,
      currentPassword,
      newPassword
    });
    if (outcome.status !== 'success') {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (session.token) userSessions.delete(session.token);
    const sessionToken = buildUserSessionToken(session.userId, outcome.authVersion);
    userSessions.set(sessionToken, { userId: session.userId, createdAt: Date.now(), authVersion: outcome.authVersion });
    res.setHeader('Set-Cookie', `userSessionId=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${Math.floor(USER_SESSION_DURATION / 1000)}`);

    return res.json({ success: true, updatedAt: outcome.updatedAt });
  } catch (err) {
    console.error('Erreur /api/auth/change-password:', err.message);
    return res.status(500).json({ error: 'Password change failed' });
  }
});

app.get('/api/account/content-grants', requireUserAuth, async (req, res) => {
  const raw =
    (
      await db.ref('contentGrants').child(req.userSession.userId).once('value')
    ).val() || {};
  const assignments =
      (await db.ref('practitionerAssignments').once('value')).val() || {},
    practitioners = [];
  for (const [id, rows] of Object.entries(assignments))
    if (idValid(id) && rows?.[req.userSession.userId]?.active === true) {
      const i = (
        await db.ref('professionalIdentities').child(id).once('value')
      ).val();
      if (i?.active === true && i.roles?.includes('practitioner'))
        practitioners.push({
          id,
          label:
            typeof i.displayName === 'string' && i.displayName.trim()
              ? i.displayName.trim().slice(0, 120)
              : `Praticien affect\u00e9 ${practitioners.length + 1}`,
          assigned: true,
        });
    }
  for (const id of Object.keys(raw))
    if (idValid(id) && !practitioners.some((p) => p.id === id))
      practitioners.push({
        id,
        label: 'Autorisation existante sans affectation active',
        assigned: false,
      });
  return res.json({ grants: raw, practitioners });
});
app.put(
  '/api/account/content-grants/:professionalId',
  requireUserAuth,
  async (req, res) => {
    const { idValid } = require('./lib/professional-access');
    const professionalId = req.params.professionalId,
      body = req.body || {},
      userId = req.userSession.userId;
    if (
      !idValid(professionalId) ||
      !['conversation_specific', 'accompaniment_period'].includes(body.scope) ||
      !Number.isFinite(body.endsAt) ||
      body.endsAt <= Date.now() ||
      body.endsAt > Date.now() + 366 * 86400000 ||
      !Array.isArray(body.conversationIds) ||
      body.conversationIds.length > 100 ||
      body.conversationIds.some((id) => !idValid(id))
    )
      return res.status(400).json({ error: 'Invalid explicit grant' });
    const [i, a] = await Promise.all([
      db.ref('professionalIdentities').child(professionalId).once('value'),
      db
        .ref('practitionerAssignments')
        .child(professionalId)
        .child(userId)
        .once('value'),
    ]);
    if (
      i.val()?.active !== true ||
      !i.val()?.roles?.includes('practitioner') ||
      a.val()?.active !== true
    )
      return res.status(403).json({ error: 'Active assignment required' });
    for (const id of body.conversationIds) {
      const c = (await db.ref('conversations').child(id).once('value')).val();
      if (!c || c.userId !== userId || c.isPrivate === true || c.deletedAt)
        return res.status(403).json({ error: 'Object ownership required' });
    }
    if (body.scope === 'conversation_specific' && !body.conversationIds.length)
      return res.status(400).json({ error: 'Objects required' });
    const grantRef = db
      .ref('contentGrants')
      .child(userId)
      .child(professionalId);
    const result = await grantRef.transaction((old) => ({
      id: idValid(old?.id) ? old.id : crypto.randomBytes(12).toString('hex'),
      version:
        Number.isSafeInteger(old?.version) && old.version >= 0
          ? old.version + 1
          : 1,
      active: true,
      scope: body.scope,
      conversationIds: body.conversationIds,
      startsAt: Date.now(),
      endsAt: body.endsAt,
      allowIntersessionSummary: body.allowIntersessionSummary === true,
    }));
    return res.json({ grant: result.snapshot.val() });
  },
);
app.delete(
  '/api/account/content-grants/:professionalId',
  requireUserAuth,
  async (req, res) => {
    const { idValid } = require('./lib/professional-access');
    if (!idValid(req.params.professionalId))
      return res.status(400).json({ error: 'Invalid reference' });
    await db
      .ref('contentGrants')
      .child(req.userSession.userId)
      .child(req.params.professionalId)
      .transaction((old) =>
        old
          ? { ...old, active: false, version: (old.version || 0) + 1 }
          : undefined,
      );
    return res.json({ success: true });
  },
);

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

    await lifecycle.removeAccount(oldUserId, { id: newUserId, record: nextUserRecord });

    const previousSessionToken = parseCookies(req).userSessionId;
    if (previousSessionToken) {
      userSessions.delete(previousSessionToken);
    }

    invalidateUserSessionsByUserId(oldUserId);
    res.locals.lifecycleTransition = true;

    const resetAuthVersion = Number.isSafeInteger(nextUserRecord.authVersion) ? nextUserRecord.authVersion : 0;
    const newSessionToken = buildUserSessionToken(newUserId, resetAuthVersion);
    userSessions.set(newSessionToken, {
      userId: newUserId,
      createdAt: Date.now(),
      authVersion: resetAuthVersion
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

    const removedConversationIds = await lifecycle.removeAccount(userId);

    const sessionToken = parseCookies(req).userSessionId;
    if (sessionToken) {
      userSessions.delete(sessionToken);
    }
    invalidateUserSessionsByUserId(userId);
    res.locals.lifecycleTransition = true;

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
      removedConversationCount: removedConversationIds.length
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

        if(value?.isPrivate===true||value?.deletedAt)return false;

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
      .filter(([,value])=>messageBelongsToConversation(value,session.userId,conversationId))
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
                memoryState: value.stateSnapshot.memoryState || null,
                flags: normalizeSessionFlags(value.stateSnapshot.flags || {})
              }
            : null,
        timestamp: Number(value?.timestamp || 0)
      }))
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

    await assertConversationOwner(session.userId,conversationId);
    return res.json({
      conversation: {
        id: conversationId,
        title:
          typeof conversation.title === 'string' ? conversation.title : null,
        updatedAt: conversation.updatedAt || conversation.createdAt || null,
        createdAt: conversation.createdAt || null,
        copyVersion: lifecycle.revision(conversation, 'm2CopyVersion'),
        memoryState: conversation.memoryState || null,
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

// A reply becoming available is not a durable-save acknowledgement. The client
// can read this bounded receipt without fetching conversation content.
app.get('/api/account/conversations/:id/saves/:messageId', requireUserAuth, async (req, res) => {
  if (!idValid(req.params.messageId)) return res.status(400).json({ code: 'invalid_reference' });
  try {
    const m = (await messagesRef.child(req.params.messageId).once('value')).val();
    if (!m) return res.json({ responseSaveStatus: 'uncertain', memoryUpdateStatus: 'not_requested' });
    if (!messageBelongsToConversation(m, req.userSession.userId, req.params.id))
      return res.status(403).json({ code: 'object_authority_lost' });
    return res.json({ responseSaveStatus: 'confirmed', memoryUpdateStatus:
      ['pending', 'completed', 'failed', 'invalid', 'superseded', 'retired', 'not_requested'].includes(m.debugMeta?.memoryUpdateStatus)
        ? m.debugMeta.memoryUpdateStatus : 'not_requested' });
  } catch { return res.status(503).json({ responseSaveStatus: 'uncertain' }); }
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

      const removedConversationIds = await lifecycle.removeConversation(session.userId, conversationId);
      return res.json({ success: true, deletedAt: now, removedConversationIds });
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
    const ids = req.body?.conversationIds;
    const { idValid } = require('./lib/professional-access');
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => !idValid(id))
    )
      return res.status(400).json({ error: 'Invalid claim request' });
    for (const id of ids) {
      const c = (await db.ref('conversations').child(id).once('value')).val();
      if (!c || c.userId !== req.userSession.userId || c.deletedAt)
        return res
          .status(403)
          .json({ error: 'Historical ownership proof required' });
    }
    return res.json({
      claimedConversationIds: [],
      claimedCount: 0,
      alreadyOwnedCount: ids.length,
      skippedCount: 0,
    });
  },
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
      if(req.body.conversations.length>50)return res.status(400).json({error:'Import scope exceeded'});
      const conversations = req.body.conversations;
      const seen=new Set();let totalMessages=0;
      const preparedVersions = {};
      // Validate the complete batch before the first write/delete. Missing
      // parents never authorize reassignment of historical orphan messages.
      for(const c of conversations){
        if(!c||!idValid(c.id)||seen.has(c.id)||(c.conversationId&&c.conversationId!==c.id)||
          (c.userId&&c.userId!==session.userId)||!Array.isArray(c.messages)||c.messages.length>500||
          c.messages.some(m=>!m||m.content?.length>16000||(m.userId&&m.userId!==session.userId)||
            (m.conversationId&&m.conversationId!==c.id)||(m.id!==undefined&&!idValid(m.id))))
          return res.status(400).json({error:'Invalid bounded import association'});
        seen.add(c.id);totalMessages+=c.messages.length;
        if(totalMessages>1000)return res.status(400).json({error:'Import scope exceeded'});
        const parent=(await db.ref('conversations').child(c.id).once('value')).val();
        const children=(await messagesRef.orderByChild('conversationId').equalTo(c.id).once('value')).val()||{};
        if((parent&&(parent.userId!==session.userId||parent.isPrivate===true||parent.deletedAt))||
          (!parent&&Object.keys(children).length)||Object.entries(children).some(([id,m])=>!idValid(id)||!messageBelongsToConversation(m,session.userId,c.id)))
          return res.status(403).json({error:'Historical ownership proof required'});
        preparedVersions[c.id] = parent ? lifecycle.revision(parent, 'm2CopyVersion') : null;
        if(forceOverwrite&&Object.keys(children).length>500)return res.status(400).json({error:'Overwrite scope exceeded'});
      }
      const jobs = [];

      for (const rawConversation of conversations) {
        const safeConversation =
          rawConversation &&
          typeof rawConversation === 'object' &&
          !Array.isArray(rawConversation)
            ? rawConversation
            : null;
        const conversationId = String(safeConversation?.id || '').trim();

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
                : index + 1;

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
                    memoryState: stateSnapshot.memoryState || null,
                    flags: normalizeSessionFlags(stateSnapshot.flags || {})
                  }
                : null
            };
          })
          .filter(Boolean);
        if (sanitizedMessages.length !== rawMessages.length) return res.status(400).json({ code: 'copy_invalid_message' });

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

        jobs.push({ id: conversationId, expectedVersion: preparedVersions[conversationId], messages: sanitizedMessages, record: {
          userId: session.userId,
          title: rawTitle || fallbackTitle,
          titleLocked: safeConversation?.isCustomTitle === true,
          messageCount: sanitizedMessages.length,
          lastUserMessage: lastUserMessage?.content || '',
          memory: normalizedMemory,
          memoryState:safeConversation.memoryState&&typeof safeConversation.memoryState==='object'?safeConversation.memoryState:null,
          flags: normalizedFlags,
          importedFromLocal: true,
          importedFromLocalPrivate: conversationIsPrivate,
          isPrivate:false,
          createdAt: updatedAtIso,
          updatedAt: updatedAtIso
        } });
      }
      const outcome = await conversationCopies.importLocal({ userId: session.userId, jobs, forceOverwrite, operationId: req.body.operationId, payload: req.body });
      return res.json({ success: true, ...outcome });
    } catch (err) {
      console.error(
        'Erreur /api/account/conversations/import-local:',
        err.message
      );
      return copyError(res, err);
    }
  }
);

app.get('/api/branches', requireUserAuth, async (req, res) => {
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

function copyError(res, error) {
  const status = error.status || (error.code?.startsWith('lifecycle_') ? 410 : 503);
  return res.status(status).json({ error: 'Copy operation not confirmed', code: error.code || 'copy_commit_uncertain' });
}
async function createBranchFromRequest(req, res, activate) {
  try {
    const body = req.body;
    if (!body || Array.isArray(body) || !idValid(body.sourceConversationId) || !idValid(body.anchorMessageId) ||
        (body.operationId !== undefined && !idValid(body.operationId)) ||
        (body.seedMessages !== undefined && !Array.isArray(body.seedMessages)) ||
        (body.memory !== undefined && typeof body.memory !== 'string') ||
        (body.flags !== undefined && (!body.flags || typeof body.flags !== 'object' || Array.isArray(body.flags))))
      return res.status(400).json({ code: 'copy_invalid_request' });
    const result = await conversationCopies.branch({ userId: req.userSession.userId,
      sourceId: body.sourceConversationId, anchorId: body.anchorMessageId, requested: body.seedMessages,
      memory: typeof body.memory === 'string' ? normalizeMemory(body.memory, buildDefaultPromptRegistry()) : '',
      flags: normalizeSessionFlags(body.flags || {}), memoryState: body.memoryState ? normalizeMemoryStateShape(body.memoryState, '', Date.now()) : null,
      operationId: body.operationId, activate });
    if (!await lifecycle.available(req.userSession.userId, result.destinationId)) return res.status(410).json({ code: 'lifecycle_object_retired' });
    return res.status(result.replayed ? 200 : 201).json({ success: true, replayed: result.replayed,
      branch: { ...result.branch, id: result.branchId }, memory: result.conversation.memory,
      memoryState: result.conversation.memoryState, flags: result.conversation.flags });
  } catch (error) { return copyError(res, error); }
}
app.post('/api/branches/from-message', requireUserAuth, (req, res) => createBranchFromRequest(req, res, false));
app.post('/api/branches/create-and-activate', requireUserAuth, (req, res) => createBranchFromRequest(req, res, true));

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

    // Keep a bounded subset for feedback snapshots. The full chat-pipeline
    // normalizer is scoped to the /chat handler and is not available here.
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
    adminShare:
      rawFeedback.adminShare === true || rawFeedback.devShare === true,
    devShare: rawFeedback.devShare === true,
    timestamp:
      typeof rawFeedback.timestamp === 'number' ? rawFeedback.timestamp : null,
    context
  };
}

// Store feedback (thumbUp/thumbDown + optional comment) on an existing message.
// If adminShare is false, the call should not reach this endpoint - frontend handles locally only.
app.post('/api/messages/:id/feedback', requireUserAuth, async (req, res) => {
  try {
    const userId = String(req.userSession?.userId || '').trim();
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
    const adminShare =
      req.body.adminShare === true || req.body.devShare === true;
    if (!adminShare) {
      return res.status(400).json({ error: 'adminShare must be true' });
    }
    const mailsEnabled = req.body?.mailsEnabled !== false;
    const adminUiActive = req.body?.adminUiActive === true;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
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
      adminShare,
      devShare: adminShare,
      userId,
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
      adminShare,
      userId
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
app.post('/api/branches/feedback-snapshot', requireUserAuth, async (req, res) => {
  try {
    const userId = String(req.userSession?.userId || '').trim();
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
    const adminShare =
      req.body.adminShare === true || req.body.devShare === true;
    if (!adminShare) {
      return res.status(400).json({ error: 'adminShare must be true' });
    }
    const mailsEnabled = req.body?.mailsEnabled !== false;
    const adminUiActive = req.body?.adminUiActive === true;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
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

    const copyResult = await conversationCopies.feedback({
      userId, operationId: req.body.operationId, payload: req.body,
      record: { title: 'Partage feedback', titleLocked: true, messageCount: 2,
        memory: feedbackContext?.memory || '', flags: normalizeSessionFlags(feedbackContext?.flags || {}) },
      messages: [
        { role: 'user', content: safeUserContent, feedbackSnapshot: true },
        { role: 'assistant', content: safeBotContent, feedbackSnapshot: true,
          debug: feedbackContext?.botDebug || [], debugMeta: feedbackContext?.botDebugMeta || null,
          stateSnapshot: feedbackContext?.botStateSnapshot || null,
          feedback: { type, comment: comment || null, adminShare, devShare: adminShare,
            userId, context: feedbackContext } }
      ]
    });
    const snapshotConversationId = copyResult.destinationId;
    const userMsgRef = { key: copyResult.messageIds[0] }, botMsgRef = { key: copyResult.messageIds[1] };
    if (!await lifecycle.available(userId, snapshotConversationId)) return res.status(410).json({ code: 'lifecycle_object_retired' });

    const effectiveMailsEnabled =
      mailsEnabled !== false &&
      (adminMailsCacheReady ? getCachedAdminMailsEnabled() : false);
    const suppressAdminMailAlert = await shouldSuppressAdminEmailAlertForUser(
      req,
      userId
    );

    if (
      !copyResult.replayed &&
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
      adminShare,
      userId
    });

    return res.status(copyResult.replayed ? 200 : 201).json({
      replayed: copyResult.replayed,
      success: true,
      snapshotConversationId,
      userMessageId: userMsgRef.key,
      botMessageId: botMsgRef.key
    });
  } catch (err) {
    console.error('Erreur /api/branches/feedback-snapshot:', err.message);
    return copyError(res, err);
  }
});

app.post('/api/branches/:id/activate', requireUserAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (Array.isArray(body) || (body.memory !== undefined && typeof body.memory !== 'string') ||
        (body.flags !== undefined && (!body.flags || typeof body.flags !== 'object' || Array.isArray(body.flags))))
      return res.status(400).json({ code: 'copy_invalid_request' });
    const result = await conversationCopies.activate({ userId: req.userSession.userId, branchId: req.params.id,
      memory: typeof body.memory === 'string' ? normalizeMemory(body.memory, buildDefaultPromptRegistry()) : undefined,
      flags: body.flags === undefined ? undefined : normalizeSessionFlags(body.flags),
      memoryState: body.memoryState ? normalizeMemoryStateShape(body.memoryState, '', Date.now()) : undefined });
    if (!await lifecycle.available(req.userSession.userId, result.branch.branchConversationId)) return res.status(410).json({ code: 'lifecycle_object_retired' });
    return res.json({ success: true, replayed: result.replayed, branch: { ...result.branch, id: req.params.id },
      memory: result.conversation.memory, memoryState: result.conversation.memoryState, flags: result.conversation.flags });
  } catch (error) { return copyError(res, error); }
});

app.get('/api/branches/:id', requireUserAuth, async (req, res) => {
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
    const memoryCompact = memorySource;
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
          typeof entry?.memorySource === 'string'
            ? entry.memorySource
            : typeof entry?.memory === 'string'
              ? entry.memory
              : '',
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

// Account intersession memory is authoritative. A conversation snapshot can only
// contribute when the server recorded the account-memory version it started from.
async function resolveAuthoritativeSessionMemoryForIntersession({
  userId,
  conversationId,
  userData
}) {
  const safeConversationId =
    typeof conversationId === 'string' ? conversationId.trim() : '';

  if (!safeConversationId || !userId) {
    return { memory: '', reason: 'missing_conversation' };
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

    if (ownerUserId !== String(userId) || isPrivate || !conversationMemory) {
      return { memory: '', reason: 'conversation_unavailable' };
    }

    return resolveConversationMemoryForIntersession({
      accountMemoryUpdatedAt: userData?.intersessionMemoryUpdatedAt,
      conversationMemory,
      conversationMemoryBaseUpdatedAt:
        convData.intersessionMemoryBaseUpdatedAt
    });
  } catch {
    return { memory: '', reason: 'conversation_lookup_failed' };
  }
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

    const sessionMemoryResolution =
      await resolveAuthoritativeSessionMemoryForIntersession({
        userId: session.userId,
        conversationId: requestedConversationId,
        userData
      });

    if (!sessionMemoryResolution.memory.trim()) {
      return res.json({
        success: true,
        skipped: true,
        reason: sessionMemoryResolution.reason
      });
    }

    const strippedSessionMemory = stripTransientMemoryBlocksForIntersession(
      sessionMemoryResolution.memory
    );

    const previousIntersessionSource = normalizeIntersessionSourceFromUserData(
      userData,
      buildDefaultPromptRegistry()
    );
    const memorySource = await updateIntersessionMemory(
      previousIntersessionSource,
      strippedSessionMemory,
      buildDefaultPromptRegistry()
    );

    await lifecycle.commitMemory(session.userId, userData, {
      intersessionMemorySource: memorySource,
      intersessionMemoryUpdatedAt: new Date().toISOString(),
      intersessionCompactOutdated: true
    }, { conversationId: requestedConversationId });

    return res.json({ success: true });
  } catch (err) {
    console.error('Erreur PUT /api/intersession-memory:', err.message);
    if (err.code === 'memory_superseded') return res.status(409).json({ code: err.code, saved: false });
    if (
      err &&
      (err.code === 'insufficient_quota' || err.type === 'insufficient_quota')
    ) {
      return res.status(503).json({
        error: 'LLM quota exhausted',
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

      const committed = await usersRef.child(session.userId).transaction((current) => {
        if (!current) return undefined;
        const currentSource = normalizeIntersessionSourceFromUserData(current, buildDefaultPromptRegistry());
        const history = Array.isArray(current.intersessionMemoryHistory) ? current.intersessionMemoryHistory : [];
        return { ...current,
          intersessionMemoryHistory: currentSource.trim() ? [{ memorySource: currentSource,
            memoryCompact: currentSource, savedAt: current.intersessionMemoryUpdatedAt || now }, ...history].slice(0, 3) : history,
          intersessionMemorySource: newSourceMemory.trim(),
          intersessionMemoryUpdatedAt: now,
          intersessionRefreshForced: true,
          intersessionCompactOutdated: true,
          m2MemoryRevision: lifecycle.revision(current, 'm2MemoryRevision') + 1
        };
      });
      if (!committed.committed) return res.status(410).json({ code: 'lifecycle_user_retired' });

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
app.post('/api/session/beacon', requireUserAuth, async (req, res) => {
  // Respond immediately - sendBeacon ignores the body anyway.
  res.status(200).json({ ok: true });

  try {
    const session = await getUserSession(req);
    if (!session) return; // unauthenticated - ignore silently

    const requestedConversationId =
      typeof req.body?.conversationId === 'string'
        ? req.body.conversationId.trim()
        : '';
    const beaconTimestamp =
      typeof req.body?.timestamp === 'string' ? req.body.timestamp : null;

    const now = new Date().toISOString();

    if(req.body?.isPrivateConversation===true)return;
    // Public activity only; private activity is never persisted.
    await usersRef.child(session.userId).update({ lastActiveAt: now });

    // Race-condition guard: skip consolidation if a more recent update already exists.
    const snap = await usersRef.child(session.userId).once('value');
    const userData = snap.val() || {};
    const storedUpdatedAt = userData.intersessionMemoryUpdatedAt;

    // Direct manual edit from account is authoritative until /chat consumes it.
    if (userData.intersessionRefreshForced === true) {
      return;
    }

    const sessionMemoryResolution =
      await resolveAuthoritativeSessionMemoryForIntersession({
        userId: session.userId,
        conversationId: requestedConversationId,
        userData
      });

    if (!sessionMemoryResolution.memory.trim()) return;

    if (
      beaconTimestamp &&
      storedUpdatedAt &&
      new Date(storedUpdatedAt) > new Date(beaconTimestamp)
    ) {
      // A more recent consolidation (explicit close) already happened - skip.
      return;
    }

    const strippedMemory = stripTransientMemoryBlocksForIntersession(
      sessionMemoryResolution.memory
    );
    const previousIntersessionMemory = normalizeIntersessionSourceFromUserData(
      userData,
      buildDefaultPromptRegistry()
    );

    const consolidated = await updateIntersessionMemory(
      previousIntersessionMemory,
      strippedMemory,
      buildDefaultPromptRegistry()
    );

    await lifecycle.commitMemory(session.userId, userData, {
      intersessionMemorySource: consolidated,
      intersessionMemoryUpdatedAt: now,
      intersessionCompactOutdated: true
    }, { conversationId: requestedConversationId });
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

async function requirePractitioner(req, res, next) {
  const actor = await getAdminSession(req);
  if (!actor?.roles.includes('practitioner')) {
    await professionalAccess.journal({
      actor,
      action: 'practitioner_access',
      reason: 'practitioner_required',
      result: 'denied',
      requestId: req.requestId,
    });
    return res
      .status(actor ? 403 : 401)
      .json({ error: 'Practitioner authorization required' });
  }
  req.professionalSession = actor;
  next();
}
app.get('/api/facilitation/users', requirePractitioner, async (req, res) => {
  const rows = await professionalAccess.directory(req.professionalSession);
  await professionalAccess.journal({
    actor: req.professionalSession,
    role: 'practitioner',
    action: 'directory',
    reason: 'active_assignments',
    result: 'allowed',
    requestId: req.requestId,
  });
  return res.json({
    users: rows.map((x) => ({ userRef: x.userRef })),
    count: rows.length,
  });
});
app.get(
  '/api/facilitation/users/:userRef/conversations',
  requirePractitioner,
  async (req, res) => {
    const user = await professionalAccess.resolveUser(
      req.professionalSession,
      req.params.userRef,
    );
    if (!user) {
      await professionalAccess.journal({
        actor: req.professionalSession,
        action: 'conversation_list',
        reason: 'grant_required',
        result: 'denied',
        requestId: req.requestId,
      });
      return res.status(404).json({ error: 'Unavailable' });
    }
    const rows = await professionalAccess.conversations(
      req.professionalSession,
      user.userId,
    );
    const visible = [];
    for (const c of rows)
      if (
        await professionalAccess.content(
          req.professionalSession,
          user.userId,
          c,
          'conversation_list',
          req.requestId,
        )
      )
        visible.push({
          conversationRef: professionalAccess.reference('conversation', c.id),
          title: c.title || null,
          lastInteractionAt: c.updatedAt || null,
        });
    return res.json({
      user: { userRef: user.userRef },
      conversations: visible,
      count: visible.length,
    });
  },
);
app.get(
  '/api/facilitation/conversations/:conversationRef/messages',
  requirePractitioner,
  async (req, res) => {
    const actor = req.professionalSession;
    let conversation = null,
      owner = null;
    for (const user of await professionalAccess.directory(actor))
      for (const c of await professionalAccess.conversations(
        actor,
        user.userId,
      ))
        if (
          professionalAccess.reference('conversation', c.id) ===
          req.params.conversationRef
        ) {
          conversation = c;
          owner = user;
        }
    if (
      !conversation ||
      (req.query.userRef && req.query.userRef !== owner.userRef)
    ) {
      await professionalAccess.journal({
        actor,
        action: 'messages',
        reason: 'object_reference_mismatch',
        result: 'denied',
        requestId: req.requestId,
      });
      return res.status(404).json({ error: 'Unavailable' });
    }
    if (
      !(await professionalAccess.content(
        actor,
        owner.userId,
        conversation,
        'messages',
        req.requestId,
      ))
    )
      return res.status(403).json({ error: 'Unavailable' });
    const raw =
      (
        await messagesRef
          .orderByChild('conversationId')
          .equalTo(conversation.id)
          .once('value')
      ).val() || {};
    const messages = Object.values(raw)
      .filter((m) => m.userId === owner.userId && m.isPrivate !== true)
      .map(professionalAccess.projectMessage)
      .sort(
        (a, b) => parseTimestampMs(a.timestamp) - parseTimestampMs(b.timestamp),
      );
    if (
      !(await professionalAccess.content(
        actor,
        owner.userId,
        conversation,
        'messages',
        req.requestId,
      ))
    )
      return res.status(403).json({ error: 'Unavailable' });
    return res.json({
      userRef: owner.userRef,
      conversation: {
        conversationRef: req.params.conversationRef,
        title: conversation.title || null,
      },
      messages,
    });
  },
);
app.get(
  '/api/facilitation/intersession-memory/:userRef',
  requirePractitioner,
  async (req, res) => {
    const actor = req.professionalSession,
      user = await professionalAccess.resolveUser(actor, req.params.userRef);
    if (
      !user ||
      !(await professionalAccess.content(
        actor,
        user.userId,
        null,
        'summary',
        req.requestId,
      ))
    )
      return res.status(403).json({ error: 'Unavailable' });
    const raw = (await usersRef.child(user.userId).once('value')).val() || {};
    if (
      !(await professionalAccess.content(
        actor,
        user.userId,
        null,
        'summary',
        req.requestId,
      ))
    )
      return res.status(403).json({ error: 'Unavailable' });
    return res.json({
      memory: normalizeIntersessionSourceFromUserData(
        raw,
        buildDefaultPromptRegistry(),
      ),
    });
  },
);

// Route to manually set the title of a conversation and lock it.
app.post('/api/conversations/:id/title', requireUserAuth, async (req, res) => {
  try {
    const userId = String(req.userSession?.userId || '').trim();
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
    const snapshot = await convRef.once('value');
    const data = snapshot.val() || null;

    if (!data) {
      return res.status(404).json({ error: 'Conversation introuvable' });
    }

    if (String(data.userId || '').trim() !== userId) {
      return res.status(403).json({ error: 'Conversation ownership mismatch' });
    }

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
app.get('/api/conversations/:id/title', requireUserAuth, async (req, res) => {
  try {
    const userId = String(req.userSession?.userId || '').trim();
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

    if (String(data.userId || '').trim() !== userId) {
      return res.status(403).json({ error: 'Conversation ownership mismatch' });
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
      const memoryCompact = memorySource;
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
          messageCount: value.messageCount || 0,
          copyVersion: lifecycle.revision(value, 'm2CopyVersion')
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

      const removedConversationIds = await lifecycle.removeConversation(existing.userId, conversationId);
      return res.json({ success: true, deletedConversationId: conversationId, removedConversationIds });
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
                    adminShare:
                      value.feedback.adminShare === true ||
                      value.feedback.devShare === true,
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
      const claimedUserId=String(safeConversation?.userId||'').trim();

      if (!idValid(conversationId)||!idValid(safeConversation?.sourceConversationId)) {
        return res.status(400).json({ error: 'Conversation invalide' });
      }
      const source=(await db.ref('conversations').child(safeConversation.sourceConversationId).once('value')).val();
      const userId=source?.userId;
      const destination=(await db.ref('conversations').child(conversationId).once('value')).val();
      if(!idValid(userId)||(claimedUserId&&claimedUserId!==userId)||source.isPrivate===true||source.deletedAt||
        (destination&&(destination.userId!==userId||destination.isPrivate===true||destination.deletedAt)))
        return res.status(403).json({error:'Replay ownership proof required'});

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
              : index + 1;
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
                  memoryState: safeEntry.stateSnapshot.memoryState ? normalizeMemoryStateShape(safeEntry.stateSnapshot.memoryState, '', Date.now()) : null,
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

      if (sanitizedMessages.length === 0 || sanitizedMessages.length !== rawMessages.length) {
        return res
          .status(400)
          .json({ error: 'Aucun message valide a importer' });
      }

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
      const result = await conversationCopies.replay({
        userId, sourceId: safeConversation.sourceConversationId, destinationId: conversationId,
        anchorId: safeConversation.anchorMessageId, operationId: req.body.operationId,
        intent: req.body.writeIntent, expectedVersion: req.body.expectedVersion,
        record: { title: rawTitle || fallbackTitle, titleLocked: false,
          messageCount: sanitizedMessages.filter((item) => item.role === 'user').length,
          lastUserMessage: lastUserMessage?.content || '', memory: normalizedMemory,
          memoryState: safeConversation.memoryState ? normalizeMemoryStateShape(safeConversation.memoryState, '', Date.now()) : null,
          flags: normalizedFlags },
        messages: sanitizedMessages
      });
      if (!await lifecycle.available(userId, conversationId)) return res.status(410).json({ code: 'lifecycle_object_retired' });
      return res.json({ success: true, conversationId, messageIds: result.messageIds,
        replayed: result.replayed, copyVersion: result.conversation.m2CopyVersion,
        fidelity: 'admin_supplied_reconstruction' });

    } catch (err) {
      console.error(
        'Erreur /api/admin/conversations/import-replay:',
        err.message
      );
      return copyError(res, err);
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
  const userId = sessionUserId;
  const convRef =
    conversationId && !isPrivateConversation
      ? db.ref('conversations').child(conversationId)
      : null;
  const recentHistory = trimHistory(req.body?.recentHistory);
  const conversationBranchHistory = normalizeConversationBranchHistory(
    req.body?.conversationBranchHistory,
  );
  const mailsEnabled = req.body?.mailsEnabled !== false;
  const logsEnabled = false; // Client cannot enable sensitive diagnostics.
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
    requestId: requestId
      ? operationKey(userId, requestId)
      : buildRequestId('chat'),
    conversationId,
    isPrivateConversation,
    userId,
    convRef,
    recentHistory,
    conversationBranchHistory,
    titleDenyList,
    mailsEnabled,
    logsEnabled,
    adminUiActive,
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

function operationKey(actor,id) {
  return crypto.createHmac('sha256',USER_SESSION_SIGNING_SECRET).update(JSON.stringify([actor,id])).digest('hex');
}
const activeChatRequests = new Map();
const CHAT_REQUEST_STALE_TTL_MS = 15 * 60 * 1000;
const activeChatProgressStreams = new Map(); // requestId -> Set(response)
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
  trackedPromise = Promise.allSettled([conversationMemorySyncLocks.get(safeConversationId)?.promise, promiseLike])
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

function registerActiveChatRequest(requestId, userId,lease=null) {
  const safeId = String(requestId || '').trim();
  if (!safeId) return;

  activeChatRequests.set(safeId, {
    userId: String(userId || '').trim(),
    lease,
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

function finalizeActiveChatRequest(requestId,lease=null) {
  const safeId = String(requestId || '').trim();
  if (!safeId) return;
  if(lease && activeChatRequests.get(safeId)?.lease!==lease)return;
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

  const canceled = cancelActiveChatRequest(operationKey(userId,requestId), userId);
  if (canceled) {
    publishChatProgressTerminal(operationKey(userId,requestId), 'canceled');
  }
  return res.json({ success: true, requestId, canceled });
});

app.post('/chat/stream/interrupted', (req, res, next) => appConfig.enableChatStreaming === true ? next() : res.status(405).json({code:'streaming_disabled'}), requireUserAuth, async (req, res) => {
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
  const rawRequestId=typeof req.query?.requestId==='string'?req.query.requestId.trim():'';
  const requestId=rawRequestId?operationKey(req.userSession.userId,rawRequestId):'';

  if (!requestId) {
    return res.status(400).json({ error: 'Missing requestId' });
  }

  const active=activeChatRequests.get(requestId);
  if(!active||active.userId!==req.userSession.userId)return res.status(404).json({error:'Operation unavailable'});
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache, no-transform');
  res.setHeader('Connection','keep-alive');
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

  res.on('close', () => {
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

const analyzeAffiliationShortValidationCoherence =
  createAffiliationShortValidationAnalyzer({
    mistralTransport,
    modelId: MISTRAL_MODEL_IDS.analysis,
    hasShortAffiliationMarker,
    trimInfoAnalysisHistory
  });

// Main chat endpoint.
// This route orchestrates the request parsing, safety analysis, mode detection,
// response generation, memory update, and persistence of both user and assistant messages.
async function handleChatPost(req, res) {
  const childTasks = new Set();
  function trackChild(promise) {
    const settled = Promise.resolve(promise).then(() => {}, () => {});
    childTasks.add(settled);
    settled.then(() => childTasks.delete(settled));
    return promise;
  }
  async function checkReturnAuthority() {
    const userId = req.userSession.userId;
    const conversationId = req.body?.isPrivateConversation === true ? null : req.body?.conversationId;
    if (!await lifecycle.available(userId, conversationId))
      throw Object.assign(new Error('lifecycle_object_retired'), { code: 'lifecycle_object_retired' });

  }
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

    const activeRequestLease=crypto.randomBytes(12).toString('hex');
    if(activeChatRequests.has(requestId))return res.status(409).json({error:'Operation already active'});
    if (requestId) {
      registerActiveChatRequest(requestId, requestData.userId,activeRequestLease);
      req.on('aborted', () => {
        cancelActiveChatRequest(requestId, requestData.userId);
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
      // Non-blocking safeguard: requireUserAuth has already established the session.
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
    let userIdForCatch = requestData.userId;
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
        suicideLevel: ['N0', 'N1', 'N2'].includes(safe.suicideLevel)
          ? safe.suicideLevel
          : 'N0',
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
        memoryUpdateDecision: ['update', 'hold'].includes(
          safe.memoryUpdateDecision
        )
          ? safe.memoryUpdateDecision
          : 'unknown',
        memoryUpdateReason:
          typeof safe.memoryUpdateReason === 'string'
            ? safe.memoryUpdateReason
            : null,
        memoryUpdateSource:
          typeof safe.memoryUpdateSource === 'string'
            ? safe.memoryUpdateSource
            : null,
        responseSaveStatus: ['pending', 'confirmed', 'failed', 'uncertain', 'superseded', 'local'].includes(safe.responseSaveStatus) ? safe.responseSaveStatus : null,
        memoryUpdateStatus: ['pending', 'completed', 'failed', 'invalid', 'superseded', 'retired', 'not_requested'].includes(
          safe.memoryUpdateStatus
        )
          ? safe.memoryUpdateStatus
          : 'not_requested',
        memoryUpdateResultSource:
          typeof safe.memoryUpdateResultSource === 'string'
            ? safe.memoryUpdateResultSource
            : null,
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
        offTopicInfoPolicy:
          safe.offTopicInfoPolicy === 'out_of_scope_recenter' ||
          safe.offTopicInfoPolicy ===
            'out_of_scope_micro_bridge_then_recenter'
            ? safe.offTopicInfoPolicy
            : 'none',
        secondaryTensionSuppressedForOffTopic:
          safe.secondaryTensionSuppressedForOffTopic === true,
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

      await assertConversationOwner(userIdForCatch,conversationIdForCatch);

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
        await updateOwnedConversation(convRefForCatch,userIdForCatch,{
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

      if (!isPrivateConversation && conversationId) req.lifecycleTicket = await lifecycle.beginTurn(userId, conversationId);
      logsEnabledForCatch = logsEnabled === true;
      markChatStage('request_destructured');
      throwIfCanceled();

      // Validate that the request is tied to a conversation.
      if (!conversationId) {
        return res.status(400).json({ error: 'Missing conversationId' });
      }

      const conversationCacheKey=isPrivateConversation?null:operationKey(userId,conversationId);
      const currentTurnNumber = nextConversationTurnNumber(conversationCacheKey);

      const memorySyncGateResult = await waitForConversationMemorySync(
        conversationCacheKey,
        MEMORY_SYNC_GATE_TIMEOUT_MS
      );
      if (memorySyncGateResult.waited) {
        logChatDecision('memory_sync_gate', {
          waitedMs: memorySyncGateResult.waitMs,
          timedOut: memorySyncGateResult.timedOut === true
        });
      }

      const relanceSyncGateResult = await waitForConversationRelanceSync(
        conversationCacheKey,
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
        conversationCacheKey,
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
      let privateFinalState={memory:previousMemory,memoryState:previousMemoryState};
      let turnMemoryTask = null;
      let privateMemoryTask=Promise.resolve();
      let privateRelanceTask=Promise.resolve();
      let previousConversationActivityMs = Date.now();
      let hasPersistedConversationMemory = false;
      const convMemoryPromise =
        trackChild(!isPrivateConversation && convRef
          ? convRef
              .once('value')
              .then((s) => {
                const d = s.val();
                if (!d || typeof d !== 'object') return null;
                if(d.userId!==userId||d.deletedAt||d.isPrivate===true)throw new Error('Object authorization lost');
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
                  intersessionMemoryBaseUpdatedAt:
                    typeof d.intersessionMemoryBaseUpdatedAt === 'string'
                      ? d.intersessionMemoryBaseUpdatedAt
                      : null,
                  intersessionMemoryResumeHistoryCount: Number.isInteger(
                    d.intersessionMemoryResumeHistoryCount
                  )
                    ? d.intersessionMemoryResumeHistoryCount
                    : 0,
                  updatedAtMs: Number.isFinite(
                    Date.parse(String(d.updatedAt || ''))
                  )
                    ? Date.parse(String(d.updatedAt || ''))
                    : null
                };
              })
              .catch(() => null)
          : Promise.resolve(null));
      const shouldLoadUserProfile = !isPrivateConversation && !!userId;
      const userProfilePromise = trackChild(shouldLoadUserProfile
        ? usersRef
            .child(String(userId))
            .once('value')
            .then((snap) => {
              const data = snap.val();
              return data && typeof data === 'object' ? data : {};
            })
            .catch(() => null)
        : Promise.resolve(null));
      markChatStage('request_normalized');
      throwIfCanceled();

      previousMemoryForCatch = previousMemory;

      // For non-private conversations, use the memory stored in Firebase (written by the previous turn).
      // Falls back to req.body.memory if Firebase has no memory yet (first turn).
      let convMemoryFromDb = null;
      if (!isPrivateConversation && convMemoryPromise) {
        convMemoryFromDb = await convMemoryPromise;
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
      let intersessionMemoryBaseUpdatedAt = null;
      let memoryHistoryStartIndex = 0;
      if (!isPrivateConversation && shouldLoadUserProfile) {
        const userDataForMemoryBase = await userProfilePromise;
        const accountMemoryUpdatedAt =
          typeof userDataForMemoryBase?.intersessionMemoryUpdatedAt === 'string'
            ? userDataForMemoryBase.intersessionMemoryUpdatedAt
            : '';
        const accountMemoryUpdatedAtMs = Date.parse(accountMemoryUpdatedAt);
        const conversationMemoryBaseUpdatedAt =
          typeof convMemoryFromDb?.intersessionMemoryBaseUpdatedAt === 'string'
            ? convMemoryFromDb.intersessionMemoryBaseUpdatedAt
            : '';
        const conversationMemoryBaseUpdatedAtMs = Date.parse(
          conversationMemoryBaseUpdatedAt
        );
        const mustRebaseFromAccountMemory =
          hasPersistedConversationMemory === true &&
          Number.isFinite(accountMemoryUpdatedAtMs) &&
          (!Number.isFinite(conversationMemoryBaseUpdatedAtMs) ||
            conversationMemoryBaseUpdatedAtMs < accountMemoryUpdatedAtMs);

        if (mustRebaseFromAccountMemory) {
          previousMemory = normalizeMemory('', activePromptRegistry);
          previousMemoryState = normalizeMemoryStateShape(null, '', Date.now());
          previousMemoryRewriteDebug = null;
          previousMemoryForCatch = previousMemory;
          previousMemoryRewriteDebugForCatch = null;
          memoryHistoryStartIndex = Array.isArray(recentHistory)
            ? recentHistory.length
            : 0;
          intersessionMemoryBaseUpdatedAt = accountMemoryUpdatedAt;
          logChatDecision('memory_rebased_from_authoritative_intersession', {
            conversationId,
            resumeHistoryCount: memoryHistoryStartIndex,
            accountMemoryUpdatedAt
          });
        } else {
          memoryHistoryStartIndex = recentHistory.length - selectPostResumeHistory(
            recentHistory,
            convMemoryFromDb?.intersessionMemoryResumeHistoryCount
          ).length;
          intersessionMemoryBaseUpdatedAt =
            Number.isFinite(conversationMemoryBaseUpdatedAtMs)
              ? conversationMemoryBaseUpdatedAt
              : accountMemoryUpdatedAt || new Date().toISOString();
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
        !req.body?.memoryState &&
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
      privateFinalState={memory:previousMemory,memoryState:previousMemoryState};
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
            .filter(m=>messageBelongsToConversation(m,userId,conversationId))
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

          await updateOwnedConversation(convRef,userId,{
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
        const conversationMetaUpdatePromise = convRef
          ? convRef.transaction((current) => {
              const now = new Date().toISOString();

              if(!current||current.userId!==userId || current.deletedAt || current.isPrivate===true)return;
              return {
                ...current,
                updatedAt: now,
                messageCount: (Number(current.messageCount) || 0) + 1,
                lastUserMessage: message
              };
            })
          : Promise.resolve(null);

        const metaResult=await conversationMetaUpdatePromise;
        if(!metaResult?.committed)throw new Error('Object authorization lost');
        await assertConversationOwner(userId,conversationId);
        const pushedRef=await messagesRef.push({role:'user',content:isEdited?message+'\n[MODIFIÉ]':message,timestamp:Date.now(),userId,conversationId});

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
        await assertConversationOwner(userId,conversationId);

        const persistedMessageId =
          typeof messageId === 'string' && messageId.trim()
            ? messageId.trim()
            : messagesRef.push().key;

        if (!persistedMessageId) {
          throw new Error('Assistant message key generation failed');
        }

        const messageRecord = {
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
        };

        const conversationPatch = {
          updatedAt: new Date().toISOString()
        };

        if (
          conversationState?.flags &&
          typeof conversationState.flags === 'object'
        ) {
          conversationPatch.flags = normalizeSessionFlags(
            conversationState.flags
          );
        }

        messageRecord.debugMeta.responseSaveStatus = 'confirmed';
        await lifecycle.commitTurn(userId, conversationId, req.lifecycleTicket, conversationPatch, { message: { id: persistedMessageId, record: messageRecord } });
        assistantMessagePersistedForCatch = true;

        return persistedMessageId;
      }

      // Fire-and-forget wrapper: generates a deterministic messageId synchronously,
      // then persists in background without blocking the response path.
      const assistantMessagePersistenceById = new Map();
      const assistantSaveStatus = new Map();

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
        assistantSaveStatus.set(messageId, 'pending');
        const persistencePromise = trackChild(persistAssistantMessage(
          reply,
          debug,
          debugMeta,
          conversationState,
          messageId
        ).then(() => { assistantSaveStatus.set(messageId, 'confirmed'); return true; }).catch((err) => {
          assistantSaveStatus.set(messageId, err.code === 'memory_superseded' ? 'superseded' : 'uncertain');
          console.error(
            '[PERSIST_ASYNC][FAILED]',
            err && err.message ? err.message : String(err)
          );
        }));
        assistantMessagePersistenceById.set(messageId, persistencePromise);
        return messageId;
      }

      async function persistMemoryUpdateAudit(messageId, audit = {}) {
        if (isPrivateConversation || !messageId) return;
        const saved = await (assistantMessagePersistenceById.get(messageId) || Promise.resolve(false));
        if (!saved) return;
        await messagesRef.child(messageId).child('debugMeta').update({
          memoryUpdateStatus: audit.status,
          memoryUpdateResultSource: audit.resultSource || null
        });
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
            throwIfCanceled();
            await lifecycle.commitTurn(userId, conversationId, req.lifecycleTicket, {
              memory: normalizedMemory,
              memoryState:
                memoryState && typeof memoryState === 'object'
                  ? memoryState
                  : null,
              memoryRewriteDebug:
                memoryRewriteDebug && typeof memoryRewriteDebug === 'object'
                  ? memoryRewriteDebug
                  : null,
              intersessionMemoryBaseUpdatedAt,
              intersessionMemoryResumeHistoryCount: memoryHistoryStartIndex,
              updatedAt: new Date().toISOString()
            }, { memory: true });
            return;
          } catch (err) {
            lastError = err;
            if (['memory_superseded', 'chat_request_canceled'].includes(err.code) || err.code?.startsWith('lifecycle_')) throw err;
            if (attempt < maxRetries) {
              await waitMs(120 * (attempt + 1));
            }
          }
        }

        throw lastError || new Error('memory_persist_retry_failed');
      }

      function scheduleBackgroundMemoryUpdate(memorySnapshot, replyText) {
        const backgroundMemoryTask = trackChild((async () => {
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

            if (isPrivateConversation) {
              privateFinalState={memory:persistedMemoryText,memoryState:mergedStateResult.memoryState};
              return { status: 'completed', resultSource: updatedMemory.source };
            }

            await persistConversationMemoryWithRetry(
              persistedMemoryText,
              activePromptRegistry,
              2,
              mergedStateResult.memoryState,
              crisisMemoryRewriteDebug
            );
            return { status: 'completed', resultSource: updatedMemory.source };
          } catch (error) {
            return { status: error.code === 'memory_result_invalid' ? 'invalid' : error.code === 'memory_superseded' ? 'superseded' : error.code?.startsWith('lifecycle_') ? 'retired' : 'failed', resultSource: 'runtime_error' };
          } finally {
            await registerUsageConsumptionFromTurn();
          }
        })());

        turnMemoryTask = backgroundMemoryTask;
        if (isPrivateConversation) privateMemoryTask=backgroundMemoryTask;
        else if (conversationId) trackConversationMemorySync(conversationCacheKey, backgroundMemoryTask);
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
        let privateAudit = null;
        if(isPrivateConversation) [privateAudit] = await Promise.all([privateMemoryTask,privateRelanceTask]);
        if (turnMemoryTask && botMessageId) trackChild(turnMemoryTask.then((audit) => persistMemoryUpdateAudit(botMessageId, audit)).catch(() => {}));
        if (turnMemoryTask) debugMeta = { ...debugMeta, memoryUpdateDecision: 'update', memoryUpdateStatus: privateAudit?.status || 'pending' };
        await registerUsageConsumptionFromTurn();
        await checkReturnAuthority();
        throwIfCanceled();
        trackChild(maybeGenerateConversationTitle());
        publishChatProgressTerminal(requestId, 'done');

        return res.json({
          conversationId,
          reply,
          memory:isPrivateConversation?privateFinalState.memory:memory,
          memoryState:isPrivateConversation?privateFinalState.memoryState:previousMemoryState,
          flags,debug,debugMeta: { ...debugMeta, responseSaveStatus: isPrivateConversation ? 'local' : assistantSaveStatus.get(botMessageId) || 'uncertain' },botMessageId,signals
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
          memoryState:previousMemoryState,
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
          const n2Result = await generateCrisisReply({
            message,
            history: recentHistory,
            memory: previousMemory,
            postureDecision: buildN2CrisisPostureDecision(),
            promptRegistry: n2PromptRegistry,
            onTokenCallback: onTokenCallbackForChat
          });
          reply = String(n2Result.reply || '').trim() || n2Response();
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
        return await sendChatJsonResponse(
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
        return await sendChatJsonResponse(
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
        return await sendChatJsonResponse(
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

        const source = normalizeIntersessionSourceFromUserData(
          userData,
          buildDefaultPromptRegistry()
        );
        return source;
      }

      function appendIntersessionFailureNote(compactText = '') {
        const base =
          String(compactText || '').trim() || INTERSESSION_COMPACT_EMPTY_NOTE;
        if (base.includes('Derniere mise a jour memoire echouee.')) {
          return base;
        }
        return `${base}\n${INTERSESSION_COMPACT_FAILURE_NOTE}`;
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

      let intersessionMemoryPreparationPromise = null;

      async function loadCurrentUserIntersessionMemory() {
        const cachedUserData = await userProfilePromise;
        const userData = await getFreshUserDataIfRefreshForced(cachedUserData);
        if (
          (userData?.intersessionCompactOutdated === true ||
            userData?.intersessionRefreshForced === true) &&
          intersessionMemoryPreparationPromise
        ) {
          const prepared = await intersessionMemoryPreparationPromise;
          return String(prepared?.intersessionMemoryForThisTurn || '').trim();
        }
        return getStoredIntersessionCompact(userData);
      }

      async function prepareIntersessionMemoryForTurn(flagsSnapshot) {
        if (!userId || isPrivateConversation === true) {
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
        const mustRefreshCompact = false;

        let runtimeCompact = source;

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
              const attemptResult = { finishReason: null, items: [] };
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
              await lifecycle.commitMemory(userId, userData, {
                intersessionMemoryCompact: runtimeCompact,
                intersessionCompactOutdated: false,
                intersessionRefreshForced: false
              }, { advance: false, conversationId });
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

        if (forcedByManualEdit) {
          await lifecycle.commitMemory(userId, userData, {
            intersessionRefreshForced: false,
            intersessionCompactOutdated: false
          }, { advance: false, conversationId });
        }

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
        return await handleImminentMajorHarmRoute(safety);
      }

      // Severe suicide risk override path.
      // If the analysis returns N2, we bypass normal generation and reply with a crisis response.
      if (crisisDecision.route === 'n2') {
        return await handleN2CrisisRoute();
      }

      // 2) Crisis follow-up path for an already active acute crisis.
      // If the crisis is not resolved, keep the bot in crisis-handling mode.
      if (flags.acuteCrisis === true) {
        if (crisisDecision.route === 'acute_followup') {
          return await handleAcuteCrisisFollowupRoute();
        }

        handleResolvedAcuteCrisisState();
      }

      // 3) N1 signal flows into the main pipeline.
      // "n1_crisis" is enforced inside buildPostureDecision.
      if (crisisDecision.route === 'n1_clarification') {
        logN1PipelineEntry();
      }

      intersessionMemoryPreparationPromise = trackChild(prepareIntersessionMemoryForTurn(
        newFlags
      ));
      const intersessionFallbackSeedPromise = trackChild((async () => {
        if (isPrivateConversation === true || !userId) {
          return '';
        }
        const userData = await userProfilePromise;
        return getStoredIntersessionCompact(userData);
      })());
      const shortAffiliationValidationPromise = trackChild(hasShortAffiliationMarker(
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
        : Promise.resolve({ shortValidationConfirmed: true }));

      // 2) Analyse de rappel memoire : identifier si l'utilisateur demande
      // explicitement un rappel conversationnel et quelle memoire mobiliser.
      markChatStage('recall_analysis');
      const recallRoutingPromise = trackChild((async () => {
        const recallIntersessionMemory =
          await loadCurrentUserIntersessionMemory();
        return analyzeRecallRouting(
          message,
          recentHistory,
          previousMemory,
          recallIntersessionMemory,
          activePromptRegistry
        );
      })());
      const recallBranchHistoryPromise = trackChild(recallRoutingPromise.then(
        async (resolvedRecallRouting) => {
          if (resolvedRecallRouting?.isLongTermMemoryRecall !== true) {
            return [];
          }

          return loadConversationBranchHistoryForRecall({
            userId,
            conversationId,
            isPrivateConversation,
            conversationBranchHistory,
            recentHistory
          });
        }
      ));

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
        humanHandoffAvailable: emailNotifier.humanRelayEnabled === true,
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

      evaluateAndNotifyOffTopicAbuse({
        userId,
        conversationId,
        requestId,
        offTopicInfoPolicy: postureDecision.offTopicInfoPolicy
      }).catch((err) => {
        logger.error({
          event: 'off_topic_abuse_monitoring_unhandled_error',
          userId: String(userId || '').trim() || null,
          requestId,
          error: err && err.message ? err.message : String(err)
        });
      });

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
        const relanceBackgroundTask = trackChild((async () => {
          const relanceStartedAt = Date.now();
          const safeConversationId = String(conversationCacheKey || '').trim();

          try {
            const relanceAnalysis = await Promise.race([
              trackChild(analyzeExplorationRelance({
                message,
                reply,
                history: recentHistory,
                memory: previousMemory,
                promptRegistry: activePromptRegistry
              })),
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

            if(isPrivateConversation) {
              newFlags.explorationRelanceWindow=relanceNextFlags.explorationRelanceWindow;
              newFlags.explorationDirectivityLevel=relanceNextFlags.explorationDirectivityLevel;
              return;
            }
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
            if(isPrivateConversation)return;
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
        })());

        if(isPrivateConversation)privateRelanceTask=relanceBackgroundTask;
        else trackConversationRelanceSync(
          conversationCacheKey,
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
      const _history = selectPostResumeHistory(
        recentHistory,
        memoryHistoryStartIndex
      );
      const _message = message;
      const _reply = reply;
      const _registry = activePromptRegistry;
      const _interSession = intersessionMemoryForThisTurn;
      const _prevMemState = previousMemoryState;
      const _lastActivityMs = previousConversationActivityMs;
      const _prioritySignal = effectiveMemoryPrioritySignalForDebug;

      let backgroundMemoryTask = trackChild((async () => {
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

          if (isPrivateConversation) {
              privateFinalState={memory:persistedMemoryText,memoryState:mergedStateResult.memoryState};
              return { status: 'completed', resultSource: memoryUpdateContract.source };
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
          return {
            status: 'completed',
            resultSource:
              typeof memoryUpdateContract?.source === 'string'
                ? memoryUpdateContract.source
                : 'unknown'
          };
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
          return { status: e.code === 'memory_superseded' ? 'superseded' : e.code === 'memory_result_invalid' ? 'invalid' : e.code?.startsWith('lifecycle_') ? 'retired' : 'failed', resultSource: 'runtime_error' };
        } finally {
          await registerUsageConsumptionFromTurn();
        }
      })());

      turnMemoryTask = backgroundMemoryTask;
      if(isPrivateConversation) privateMemoryTask=backgroundMemoryTask;
      else if(conversationId&&backgroundMemoryTask)trackConversationMemorySync(conversationCacheKey,backgroundMemoryTask);
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
        memoryUpdateDecision: postureDecision.memoryUpdateDecision,
        memoryUpdateReason: postureDecision.memoryUpdateReason,
        memoryUpdateSource: postureDecision.memoryUpdateSource,
        memoryUpdateStatus: 'pending',
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
        allianceAssessmentReason: postureDecision.allianceAssessmentReason,
        allianceAssessmentSource: postureDecision.allianceAssessmentSource,
        humanSupportProposal: postureDecision.humanSupportProposal,
        humanSupportProposalReason: postureDecision.humanSupportProposalReason,
        humanSupportProposalEffective:
          postureDecision.humanSupportProposalEffective === true,
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
        offTopicInfoPolicy:
          postureDecision.offTopicInfoPolicy || 'none',
        secondaryTensionSuppressedForOffTopic:
          postureDecision.secondaryTensionSuppressedForOffTopic === true,
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


      return await sendChatJsonResponse(
        reply,
        newMemory,
        newFlags,
        debug,
        responseDebugMeta,
        botMessageId,
        turnSignals
      );
    } catch (err) {
      if (err.code?.startsWith('lifecycle_') || err.code === 'memory_superseded') {
        return res.status(err.code === 'memory_superseded' ? 409 : 410).json({ code: err.code, saved: false });
      }
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
          error: 'LLM quota exhausted',
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

      try { await checkReturnAuthority(); } catch { return res.status(410).json({ code: 'lifecycle_object_retired' }); }
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
      while (childTasks.size) await Promise.allSettled([...childTasks]);
      if (requestId) {
        finalizeActiveChatRequest(requestId,activeRequestLease);
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

app.post('/chat/stream', (req, res, next) => appConfig.enableChatStreaming === true ? next() : res.status(405).json({code:'streaming_disabled'}), requireUserAuth, async (req, res) => {
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

  req.onTokenCallbackForChat = async (token) => {
    if (!await lifecycle.available(req.userSession.userId, req.body?.isPrivateConversation === true ? null : streamConversationId))
      throw Object.assign(new Error('lifecycle_object_retired'), { code: 'lifecycle_object_retired' });
    throwIfChatRequestCanceled(operationKey(req.userSession.userId, streamRequestId));
    writeSSEEvent(res, 'token', { token });
  };

  res.on('close', () => {
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
    once(event,listener){res.once(event,listener);return this;},
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
