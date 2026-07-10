'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {
    since: '',
    until: '',
    userId: '',
    superId: '',
    event: '',
    logDir: path.join(__dirname, '..', 'logs'),
    limit: 200,
    contains: ''
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg.startsWith('--')) continue;

    const key = arg.replace(/^--/, '');
    const next = String(argv[i + 1] || '').trim();
    if (!next || next.startsWith('--')) continue;

    if (key === 'since') out.since = next;
    if (key === 'until') out.until = next;
    if (key === 'userId') out.userId = next;
    if (key === 'superId') out.superId = next;
    if (key === 'event') out.event = next;
    if (key === 'contains') out.contains = next;
    if (key === 'logDir') {
      out.logDir = path.isAbsolute(next)
        ? next
        : path.join(__dirname, '..', next);
    }
    if (key === 'limit') {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        out.limit = Math.min(parsed, 5000);
      }
    }
  }

  return out;
}

function parseTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function readLogFiles(logDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.jsonl$/i.test(name))
    .sort((a, b) => b.localeCompare(a))
    .map((name) => path.join(logDir, name));
}

function parseJsonLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function matchesFilters(entry, filters) {
  const timestampMs = parseTime(entry.time);
  if (filters.sinceMs !== null && (timestampMs === null || timestampMs < filters.sinceMs)) {
    return false;
  }
  if (filters.untilMs !== null && (timestampMs === null || timestampMs > filters.untilMs)) {
    return false;
  }

  if (filters.userId && String(entry.usageUserId || entry.userId || '').trim() !== filters.userId) {
    return false;
  }
  if (filters.superId && String(entry.superId || '').trim() !== filters.superId) {
    return false;
  }
  if (filters.event && String(entry.event || '').trim() !== filters.event) {
    return false;
  }
  if (filters.contains) {
    const hay = JSON.stringify(entry).toLowerCase();
    if (!hay.includes(filters.contains.toLowerCase())) {
      return false;
    }
  }

  return true;
}

function formatLine(entry) {
  const level = String(entry.level || '').toUpperCase();
  const time = String(entry.time || '').trim() || '-';
  const event = String(entry.event || '').trim() || '-';
  const scope = String(entry.scope || '').trim() || '-';
  const requestId = String(entry.requestId || '').trim() || '-';
  const userId = String(entry.usageUserId || entry.userId || '').trim() || '-';
  const superId = String(entry.superId || '').trim() || '-';
  const reason = String(entry.reason || '').trim() || '-';
  const error = String(entry.error || '').trim() || '-';

  return [
    time,
    level,
    event,
    `scope=${scope}`,
    `requestId=${requestId}`,
    `userId=${userId}`,
    `superId=${superId}`,
    `reason=${reason}`,
    `error=${error}`
  ].join(' | ');
}

function printUsage() {
  console.log('Usage: node scripts/log-query.js [options]');
  console.log('Options:');
  console.log('  --since <ISO date>      example: 2026-07-09T14:46:00+02:00');
  console.log('  --until <ISO date>      example: 2026-07-09T23:59:59+02:00');
  console.log('  --userId <id>');
  console.log('  --superId <id>');
  console.log('  --event <event_name>');
  console.log('  --contains <text>');
  console.log('  --logDir <path>         default: logs');
  console.log('  --limit <n>             default: 200, max: 5000');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const parsed = parseArgs(args);
  const filters = {
    sinceMs: parseTime(parsed.since),
    untilMs: parseTime(parsed.until),
    userId: parsed.userId,
    superId: parsed.superId,
    event: parsed.event,
    contains: parsed.contains,
    limit: parsed.limit
  };

  const files = readLogFiles(parsed.logDir);
  if (files.length === 0) {
    console.error(`No log files found in ${parsed.logDir}`);
    process.exitCode = 1;
    return;
  }

  const matches = [];
  for (const filePath of files) {
    if (matches.length >= filters.limit) break;

    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (matches.length >= filters.limit) break;
      const entry = parseJsonLine(line);
      if (!entry) continue;
      if (!matchesFilters(entry, filters)) continue;
      matches.push(entry);
    }
  }

  if (matches.length === 0) {
    console.log('No matching log entries.');
    return;
  }

  matches
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
    .forEach((entry) => {
      console.log(formatLine(entry));
    });

  console.log(`\nMatches: ${matches.length}`);
}

main();
