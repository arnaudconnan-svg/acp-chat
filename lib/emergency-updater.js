'use strict';

// Third-party documents are candidate data, never instructions or live resources.
// P3911 is an STW economics identifier, not a telephone property. Neither it nor
// an unproven P1329 aggregation is an accepted source of emergency numbers.
const https = require('https');
const fs = require('fs');
const { createHash } = require('crypto');
const { normalizeCountryCode } = require('./emergency-resources');

const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 10000;
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const registryVersion = (registry) => digest(registry);
const candidateDigest = (candidate) => digest(candidate);
const validDate = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function requestJson(
  url,
  { signal, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}
) {
  if (!httpsUrl(url)) return Promise.reject(new Error('HTTPS source required'));
  timeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, TIMEOUT_MS)
      : TIMEOUT_MS;
  maxBytes =
    Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.min(maxBytes, MAX_BYTES)
      : MAX_BYTES;
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        res?.destroy();
        req?.destroy();
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(new Error('Collection aborted'));
    const timer = setTimeout(
      () => finish(new Error('Collection timeout')),
      timeoutMs
    );
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      req = https.get(
        url,
        { headers: { Accept: 'application/json' } },
        (response) => {
          if (settled) {
            response.destroy();
            return;
          }
          res = response;
          res.on('error', (error) => finish(error));
          res.on('aborted', () => finish(new Error('Incomplete response')));
          if (res.statusCode !== 200)
            return finish(new Error('HTTP ' + res.statusCode));
          let bytes = 0;
          const chunks = [];
          res.on('data', (chunk) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > maxBytes) return finish(new Error('Source too large'));
            chunks.push(Buffer.from(chunk));
          });
          res.on('end', () => {
            if (settled) return;
            try {
              finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              finish(new Error('Invalid source JSON'));
            }
          });
        }
      );
      req.on('error', (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

function checkedService(record) {
  if (
    !record ||
    normalizeCountryCode(record.country) !== record.country ||
    !['emergency', 'suicide'].includes(record.category) ||
    record.kind !== 'telephone' ||
    typeof record.value !== 'string' ||
    !/^[+\d][\d ()+./-]{1,79}$/.test(record.value) ||
    !httpsUrl(record.source?.url) ||
    record.source.property === 'P3911' ||
    typeof record.source.version !== 'string' ||
    !record.source.version.trim() ||
    !validDate(record.source.retrievedAt) ||
    (record.source.publishedAt != null && !validDate(record.source.publishedAt))
  ) {
    throw new Error('Invalid telephone or missing service provenance');
  }
  // Copy only the data contract. A remote approval/instruction is never copied.
  return {
    country: record.country,
    category: record.category,
    kind: 'telephone',
    value: record.value,
    source: {
      url: record.source.url,
      version: record.source.version,
      retrievedAt: record.source.retrievedAt,
      publishedAt: record.source.publishedAt || null
    }
  };
}

async function collectEmergencyCandidate({
  current,
  urls = [],
  signal,
  fetchJson = requestJson,
  now = () => new Date().toISOString()
}) {
  const candidate = {
    baseVersion: registryVersion(current),
    collection: {
      attemptedAt: now(),
      completedAt: null,
      complete: false,
      errors: []
    },
    services: []
  };
  // No default collector: no telephone source with demonstrated provenance yet.
  if (!urls.length || urls.length > 20) {
    candidate.collection.errors.push('No supported source set');
    return candidate;
  }
  for (const url of urls) {
    try {
      if (signal?.aborted) throw new Error('Collection aborted');
      if (!httpsUrl(url)) throw new Error('HTTPS source required');
      const doc = await fetchJson(url, { signal });
      if (
        !Array.isArray(doc.services) ||
        !doc.services.length ||
        doc.services.length > 200
      )
        throw new Error('Invalid source services');
      candidate.services.push(...doc.services.map(checkedService));
    } catch {
      // No third-party body or error content goes to logs, prompts or metadata.
      candidate.collection.errors.push('Source failed');
    }
  }
  candidate.collection.completedAt = now();
  candidate.collection.complete =
    !signal?.aborted && candidate.collection.errors.length === 0;
  return candidate;
}

function validateEmergencyCandidate(current, candidate, approval) {
  if (
    !candidate?.collection?.complete ||
    candidate.collection.errors?.length !== 0 ||
    !validDate(candidate.collection.completedAt) ||
    !candidate.services?.length ||
    candidate.baseVersion !== registryVersion(current)
  )
    throw new Error('Incomplete or stale candidate');
  if (
    approval?.approved !== true ||
    approval.candidateDigest !== candidateDigest(candidate) ||
    typeof approval.reviewedBy !== 'string' ||
    !approval.reviewedBy.trim() ||
    !validDate(approval.reviewedAt) ||
    !httpsUrl(approval.evidenceUrl)
  )
    throw new Error('Explicit digest-bound approval required');
  const next = JSON.parse(JSON.stringify(current));
  const seen = new Set();
  for (const record of candidate.services) {
    const service = checkedService(record);
    const key = service.country + '.' + service.category;
    if (
      seen.has(key) ||
      !current[service.country] ||
      approval.services?.[key]?.approved !== true ||
      !validDate(approval.services[key].verifiedAt)
    )
      throw new Error('Explicit service validation required');
    seen.add(key);
    const entry = next[service.country];
    entry[service.category] = service.value;
    entry.services ||= {};
    entry.services[service.category] = {
      value: service.value,
      status: 'reviewed',
      source: service.source,
      verifiedAt: approval.services[key].verifiedAt,
      approval: {
        candidateDigest: approval.candidateDigest,
        reviewedBy: approval.reviewedBy,
        reviewedAt: approval.reviewedAt,
        evidenceUrl: approval.evidenceUrl
      }
    };
  }
  next._meta = {
    ...next._meta,
    publication: {
      candidateDigest: approval.candidateDigest,
      reviewedAt: approval.reviewedAt,
      evidenceUrl: approval.evidenceUrl
    }
  };
  return next;
}

function publishEmergencyCandidate(outputFile, candidate, approval) {
  const current = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  const next = validateEmergencyCandidate(current, candidate, approval);
  const temporary = outputFile + '.candidate-' + process.pid;
  let created = false;
  try {
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', {
      flag: 'wx'
    });
    created = true;
    if (
      registryVersion(JSON.parse(fs.readFileSync(outputFile, 'utf8'))) !==
      candidate.baseVersion
    )
      throw new Error('Registry changed during review');
    fs.renameSync(temporary, outputFile);
  } finally {
    if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return next;
}

async function updateEmergencyNumbers() {
  throw new Error(
    'Automatic publication disabled; reviewed candidate and explicit approval required'
  );
}

module.exports = {
  requestJson,
  collectEmergencyCandidate,
  validateEmergencyCandidate,
  publishEmergencyCandidate,
  updateEmergencyNumbers,
  registryVersion,
  candidateDigest
};
