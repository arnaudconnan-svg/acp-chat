'use strict';

/**
 * Pre-FF wrapper around ui-smoke:
 * - enforces live chat turn validation
 * - requires requestId capture for anti-fallback log checks
 */

const requiredEnv = [
  'SMOKE_BASE_URL',
  'SMOKE_AUTH_EMAIL',
  'SMOKE_AUTH_PASSWORD'
];

const missing = requiredEnv.filter(
  (name) => !String(process.env[name] || '').trim()
);

if (missing.length > 0) {
  console.error(
    `ui-smoke-preff: missing env ${missing.join(', ')}. ` +
      'Expected: SMOKE_BASE_URL, SMOKE_AUTH_EMAIL, SMOKE_AUTH_PASSWORD (SMOKE_ADMIN_PASSWORD optional unless /telecharger).'
  );
  process.exit(1);
}

process.env.SMOKE_ALLOW_LLM = '1';
process.env.SMOKE_REQUIRE_REQUEST_ID = '1';

require('./ui-smoke');
