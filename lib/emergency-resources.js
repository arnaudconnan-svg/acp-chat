'use strict';

const { createHash } = require('crypto');
const CATEGORIES = ['emergency', 'suicide'];
function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function validSource(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
function normalizeCountryCode(value) {
  const code = String(value || '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}
function fallbackGuidance() {
  return "Si ces numéros ne sont pas disponibles pour votre pays, appelez le numéro d'urgence local de votre opérateur téléphonique ou recherchez 'numéro urgence + votre pays' et 'ligne prévention suicide + votre pays'.";
}
function serviceInfo(entry, category, registryVersion) {
  const value =
    typeof entry?.[category] === 'string' ? entry[category].trim() : '';
  if (!value) return null;
  const stored = entry.services?.[category];
  const reviewed =
    stored?.status === 'reviewed' &&
    stored.value === value &&
    /^[a-f0-9]{64}$/.test(stored.approval?.candidateDigest || '') &&
    validSource(stored.approval?.evidenceUrl) &&
    validDate(stored.approval?.reviewedAt) &&
    typeof stored.approval?.reviewedBy === 'string' &&
    stored.approval.reviewedBy.trim() &&
    validSource(stored.source?.url) &&
    typeof stored.source?.version === 'string' &&
    stored.source.version.trim() &&
    validDate(stored.source?.retrievedAt) &&
    validDate(stored.verifiedAt);
  return {
    value,
    status: reviewed ? 'reviewed' : 'legacy_unverified',
    source: reviewed ? stored.source : null,
    version: reviewed ? stored.source.version : registryVersion,
    retrievedAt: reviewed ? stored.source.retrievedAt : null,
    publishedAt: reviewed ? stored.source.publishedAt : null,
    verifiedAt: reviewed ? stored.verifiedAt : null,
    approval: reviewed
      ? {
          candidateDigest: stored.approval.candidateDigest,
          evidenceUrl: stored.approval.evidenceUrl,
          reviewedAt: stored.approval.reviewedAt
        }
      : null
  };
}
function resolveEmergencySupport(
  registry = {},
  countryCode,
  fallbackCode = 'FR'
) {
  const requestedCountry = normalizeCountryCode(countryCode);
  const fallbackCountry = normalizeCountryCode(fallbackCode);
  const registryVersion = createHash('sha256')
    .update(JSON.stringify(registry))
    .digest('hex');
  const hasData = (code) =>
    code &&
    CATEGORIES.some(
      (key) =>
        typeof registry[code]?.[key] === 'string' && registry[code][key].trim()
    );
  const country = hasData(requestedCountry)
    ? requestedCountry
    : hasData(fallbackCountry)
      ? fallbackCountry
      : null;
  const entry = country ? registry[country] : null;
  const services = Object.fromEntries(
    CATEGORIES.map((key) => [key, serviceInfo(entry, key, registryVersion)])
  );
  const fallbackUsed = Boolean(country && country !== requestedCountry);
  const status = country
    ? CATEGORIES.every(
        (key) => !services[key] || services[key].status === 'reviewed'
      )
      ? 'reviewed'
      : 'legacy_unverified'
    : 'unavailable';
  return {
    requestedCountry,
    country,
    fallbackCountry,
    fallbackUsed,
    fallbackReason: fallbackUsed
      ? requestedCountry
        ? 'country_unavailable'
        : 'country_unspecified'
      : null,
    label: typeof entry?.label === 'string' ? entry.label : country,
    emergency: services.emergency?.value || null,
    suicide: services.suicide?.value || null,
    services,
    status,
    registryVersion,
    hasStructuredNumbers: Boolean(country),
    fallbackGuidance: fallbackGuidance(),
    updatedPeriod: null
  };
}
function buildEmergencySupportText(support) {
  if (!support) return fallbackGuidance();
  if (!support.hasStructuredNumbers) return support.fallbackGuidance;
  const location = support.fallbackUsed
    ? 'Pays demandé : ' +
      (support.requestedCountry || 'non précisé') +
      ' ; repli : ' +
      support.label +
      ' (' +
      support.country +
      '), pas des ressources locales confirmées.'
    : 'Pays des ressources : ' + support.label + ' (' + support.country + ').';
  const parts = [location];
  for (const key of CATEGORIES) {
    const service = support.services[key];
    if (!service) continue;
    const provenance =
      service.status === 'reviewed'
        ? 'source : ' +
          service.source.url +
          ', version : ' +
          service.version +
          ', vérifié le : ' +
          service.verifiedAt
        : 'ressource héritée non validée ; source et date de vérification non établies ; version du registre : ' +
          service.version;
    parts.push(
      (key === 'emergency' ? 'urgences' : 'prévention suicide') +
        ' : ' +
        service.value +
        ' (' +
        provenance +
        ')'
    );
  }
  if (CATEGORIES.some((key) => !support.services[key]))
    parts.push(support.fallbackGuidance);
  return parts.join(' | ');
}
module.exports = {
  normalizeCountryCode,
  resolveEmergencySupport,
  buildEmergencySupportText,
  fallbackGuidance
};
