'use strict';

const fs = require('fs');
const path = require('path');
const { z } = require('zod');

function booleanFromEnv(defaultValue = false) {
  return z.preprocess(
    (value) => {
      if (typeof value === 'boolean') return value;
      if (value === undefined || value === null || value === '')
        return defaultValue;
      return String(value).trim().toLowerCase();
    },
    z.union([
      z.boolean(),
      z
        .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
        .transform((value) => {
          return ['true', '1', 'yes', 'on'].includes(value);
        })
    ])
  );
}

function integerFromEnv(defaultValue) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '')
      return defaultValue;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : value;
  }, z.number().int().nonnegative());
}

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: integerFromEnv(3000),
    FIREBASE_DATABASE_URL: z
      .string()
      .trim()
      .min(1, 'FIREBASE_DATABASE_URL is required'),
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().trim().optional(),
    FIREBASE_SERVICE_ACCOUNT: z.string().trim().optional(),
    OPENAI_API_KEY: z.string().trim().optional(),
    ADMIN_PASSWORD: z.string().trim().optional(),
    SESSION_SECRET: z.string().trim().optional(),
    ADMIN_SESSION_SECRET: z.string().trim().optional(),
    USER_SESSION_SECRET: z.string().trim().optional(),
    REFRESH_EMERGENCY_ON_BOOT: booleanFromEnv(false),
    BRANCH_ROUTE_DEBUG: booleanFromEnv(false),
    DEV_RUNTIME_GUARDS: booleanFromEnv(false),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: booleanFromEnv(
      process.stdout.isTTY && process.env.NODE_ENV !== 'production'
    ),
    NOTIFY_EMAIL_TO: z.string().trim().optional(),
    NOTIFY_SMTP_HOST: z.string().trim().optional(),
    NOTIFY_SMTP_PORT: integerFromEnv(587),
    NOTIFY_SMTP_SECURE: booleanFromEnv(false),
    NOTIFY_SMTP_USER: z.string().trim().optional(),
    NOTIFY_SMTP_PASSWORD: z.string().trim().optional(),
    NOTIFY_EMAIL_FROM: z.string().trim().optional()
  })
  .superRefine((env, ctx) => {
    if (!env.FIREBASE_SERVICE_ACCOUNT_PATH && !env.FIREBASE_SERVICE_ACCOUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_SERVICE_ACCOUNT_PATH'],
        message:
          'Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH'
      });
    }
  });

function normalizeIssues(error) {
  if (!error || !Array.isArray(error.issues)) return ['invalid_configuration'];
  return error.issues.map((issue) => {
    const pathLabel =
      Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.join('.')
        : 'config';
    return `${pathLabel}: ${issue.message}`;
  });
}

function inspectConfig(env = process.env) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    return {
      ok: false,
      issues: normalizeIssues(result.error),
      config: null
    };
  }

  const config = {
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    firebaseDatabaseUrl: result.data.FIREBASE_DATABASE_URL,
    firebaseServiceAccountPath: result.data.FIREBASE_SERVICE_ACCOUNT_PATH || '',
    firebaseServiceAccountJson: result.data.FIREBASE_SERVICE_ACCOUNT || '',
    openAIApiKey: result.data.OPENAI_API_KEY || '',
    adminPassword: result.data.ADMIN_PASSWORD || '',
    sessionSecret: result.data.SESSION_SECRET || '',
    adminSessionSecret: result.data.ADMIN_SESSION_SECRET || '',
    userSessionSecret: result.data.USER_SESSION_SECRET || '',
    refreshEmergencyOnBoot: result.data.REFRESH_EMERGENCY_ON_BOOT,
    branchRouteDebug: result.data.BRANCH_ROUTE_DEBUG,
    devRuntimeGuards:
      result.data.NODE_ENV !== 'production' ||
      result.data.DEV_RUNTIME_GUARDS === true,
    logLevel: result.data.LOG_LEVEL,
    logPretty: result.data.LOG_PRETTY,
    notifyEmailTo: result.data.NOTIFY_EMAIL_TO || '',
    notifySmtpHost: result.data.NOTIFY_SMTP_HOST || '',
    notifySmtpPort: result.data.NOTIFY_SMTP_PORT,
    notifySmtpSecure: result.data.NOTIFY_SMTP_SECURE,
    notifySmtpUser: result.data.NOTIFY_SMTP_USER || '',
    notifySmtpPassword: result.data.NOTIFY_SMTP_PASSWORD || '',
    notifyEmailFrom: result.data.NOTIFY_EMAIL_FROM || ''
  };

  return {
    ok: true,
    issues: [],
    config
  };
}

function parseAppConfig(env = process.env) {
  const inspected = inspectConfig(env);
  if (!inspected.ok) {
    throw new Error(`Invalid configuration: ${inspected.issues.join(' | ')}`);
  }
  return inspected.config;
}

function resolveServiceAccount(config) {
  const safeConfig = config || parseAppConfig(process.env);

  if (safeConfig.firebaseServiceAccountPath) {
    const absolutePath = path.isAbsolute(safeConfig.firebaseServiceAccountPath)
      ? safeConfig.firebaseServiceAccountPath
      : path.join(__dirname, '..', safeConfig.firebaseServiceAccountPath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_PATH not found: ${absolutePath}`
      );
    }

    return require(absolutePath);
  }

  try {
    return JSON.parse(safeConfig.firebaseServiceAccountJson);
  } catch (err) {
    throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT JSON: ${err.message}`);
  }
}

function summarizeConfig(config) {
  const safeConfig = config || parseAppConfig(process.env);
  return {
    nodeEnv: safeConfig.nodeEnv,
    port: safeConfig.port,
    firebaseDatabaseUrlConfigured: Boolean(safeConfig.firebaseDatabaseUrl),
    firebaseServiceAccountMode: safeConfig.firebaseServiceAccountPath
      ? 'path'
      : 'json',
    branchRouteDebug: safeConfig.branchRouteDebug,
    devRuntimeGuards: safeConfig.devRuntimeGuards,
    logLevel: safeConfig.logLevel,
    logPretty: safeConfig.logPretty,
    notifyEmailEnabled: Boolean(
      safeConfig.notifyEmailTo &&
      safeConfig.notifySmtpHost &&
      safeConfig.notifySmtpUser &&
      safeConfig.notifySmtpPassword
    )
  };
}

module.exports = {
  inspectConfig,
  parseAppConfig,
  resolveServiceAccount,
  summarizeConfig
};
