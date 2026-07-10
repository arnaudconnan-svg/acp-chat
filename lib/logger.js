'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { parseAppConfig } = require('./config');

const appConfig = parseAppConfig(process.env);

function resolveLogDirectory() {
  const configured = String(appConfig.logDir || '').trim();
  if (!configured) {
    return path.join(__dirname, '..', 'logs');
  }
  return path.isAbsolute(configured)
    ? configured
    : path.join(__dirname, '..', configured);
}

function buildDailyLogFilePath(logDir, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return path.join(logDir, `app-${y}-${m}-${d}.jsonl`);
}

function pruneOldLogFiles(logDir, retentionDays = 14) {
  const safeRetentionDays = Number.isFinite(retentionDays)
    ? Math.max(1, Math.round(retentionDays))
    : 14;
  const cutoffMs = Date.now() - safeRetentionDays * 24 * 60 * 60 * 1000;

  let entries = [];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^app-\d{4}-\d{2}-\d{2}\.jsonl$/i.test(entry.name)) continue;

    const filePath = path.join(logDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (Number(stat.mtimeMs) < cutoffMs) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Non-blocking: avoid impacting app startup if pruning fails.
    }
  }
}

function buildLoggerStreams() {
  const streams = [];

  if (appConfig.logPretty) {
    streams.push({
      stream: pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: process.stdout.isTTY,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname'
        }
      })
    });
  } else {
    streams.push({ stream: process.stdout });
  }

  if (appConfig.logPersist) {
    try {
      const logDir = resolveLogDirectory();
      fs.mkdirSync(logDir, { recursive: true });
      pruneOldLogFiles(logDir, appConfig.logRetentionDays);

      const logFilePath = buildDailyLogFilePath(logDir);
      streams.push({
        stream: pino.destination({
          dest: logFilePath,
          mkdir: true,
          append: true,
          sync: false
        })
      });
    } catch {
      // Non-blocking: keep console logging even when file sink is unavailable.
    }
  }

  return streams;
}

const streams = buildLoggerStreams();

const logger = pino(
  {
    level: appConfig.logLevel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      }
    }
  },
  streams.length > 1 ? pino.multistream(streams) : streams[0].stream
);

function childLogger(bindings = {}) {
  return logger.child(bindings);
}

module.exports = {
  logger,
  childLogger
};
