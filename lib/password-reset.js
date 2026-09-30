'use strict';

const crypto = require('crypto');
const net = require('net');

const RESET_TTL_MS = 30 * 60 * 1000;
const NEUTRAL_REQUEST_MESSAGE =
  'Si un compte correspond à cette adresse, un lien de réinitialisation a été envoyé.';
const RESET_TOKEN_PATTERN = /^(u_[a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/;

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function passwordRevision(user) {
  return sha256(String(user?.passwordHash || ''));
}

function resolveCanonicalOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname && parsed.pathname !== '/')
    ) {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

function resolveResetClientIp({
  socketAddress,
  forwardedFor,
  trustedProxyHops = 0
}) {
  const socketIp = String(socketAddress || '').trim();
  if (!trustedProxyHops) return net.isIP(socketIp) ? socketIp : 'unknown';
  const forwarded = String(forwardedFor || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => net.isIP(value));
  const chain = [...forwarded, socketIp].filter((value) => net.isIP(value));
  return chain[Math.max(0, chain.length - 1 - trustedProxyHops)] || 'unknown';
}

function createBoundedRateLimiter({
  windowMs,
  max,
  maxEntries = 5000,
  now = Date.now
}) {
  const entries = new Map();
  return {
    take(key) {
      const timestamp = now();
      const safeKey = String(key || 'unknown');
      const previous = entries.get(safeKey);
      if (previous && previous.resetAt > timestamp) {
        if (previous.count >= max) return false;
        previous.count += 1;
        return true;
      }
      if (previous) entries.delete(safeKey);
      if (entries.size >= maxEntries) {
        for (const [candidate, value] of entries) {
          if (value.resetAt <= timestamp) entries.delete(candidate);
        }
      }
      if (entries.size >= maxEntries) return false;
      entries.set(safeKey, { count: 1, resetAt: timestamp + windowMs });
      return true;
    },
    size() {
      return entries.size;
    }
  };
}

function createBoundedJobQueue({
  worker,
  concurrency = 2,
  maxPending = 50,
  onError = () => {}
}) {
  const pending = [];
  let active = 0;
  function drain() {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      active += 1;
      Promise.resolve()
        .then(() => worker(job))
        .catch(() => onError())
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }
  return {
    enqueue(job) {
      if (active + pending.length >= concurrency + maxPending) return false;
      pending.push(job);
      drain();
      return true;
    },
    stats() {
      return { active, pending: pending.length };
    }
  };
}

function createResetEmailSender({ transporter, fromAddress, logger }) {
  return async function sendResetEmail({ to, link }) {
    try {
      await transporter.sendMail({
        from: fromAddress,
        to,
        subject: 'Réinitialisation de votre mot de passe Facilitat.io',
        text: [
          'Une demande de réinitialisation de votre mot de passe a été reçue.',
          '',
          `Choisir un nouveau mot de passe (lien valable 30 minutes) : ${link}`,
          '',
          "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet email."
        ].join('\n')
      });
      return true;
    } catch {
      logger.error({ event: 'password_reset_email_failed' });
      return false;
    }
  };
}

function createPasswordResetService({
  usersRef,
  findUserByEmail,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  isStrongPassword,
  sendResetEmail,
  canonicalAppUrl,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  queueConcurrency = 2,
  queueMaxPending = 50,
  rateLimitMaxEntries = 5000,
  onJobError = () => {}
}) {
  const canonicalOrigin = resolveCanonicalOrigin(canonicalAppUrl);
  const enabled = Boolean(
    canonicalOrigin && typeof sendResetEmail === 'function'
  );
  const emailLimiter = createBoundedRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 3,
    maxEntries: rateLimitMaxEntries,
    now
  });
  const ipLimiter = createBoundedRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    maxEntries: rateLimitMaxEntries,
    now
  });
  const consumeIpLimiter = createBoundedRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    maxEntries: rateLimitMaxEntries,
    now
  });

  async function processRequestJob({ normalized }) {
    const found = await findUserByEmail(normalized);
    if (!found?.userId || !found.user) return;
    const accountId = String(found.userId);
    if (!/^u_[a-f0-9]{24}$/.test(accountId)) return;
    const secret = randomBytes(32).toString('base64url');
    const secretHash = sha256(secret);
    const issuedAt = now();
    const accountRef = usersRef.child(accountId);
    await accountRef.once('value');
    const transaction = await accountRef.transaction(
      (current) => {
        if (!current || typeof current !== 'object') return current;
        return {
          ...current,
          passwordReset: {
            secretHash,
            expiresAt: issuedAt + RESET_TTL_MS,
            issuedAt,
            passwordRevision: passwordRevision(current)
          }
        };
      },
      undefined,
      false
    );
    const committedUser = transaction.snapshot?.val();
    if (
      !transaction.committed ||
      committedUser?.passwordReset?.secretHash !== secretHash
    )
      return;
    const link = `${canonicalOrigin}/auth.html#reset=${accountId}.${secret}`;
    const sent = await sendResetEmail({ to: { address: normalized }, link });
    if (!sent) throw new Error('reset_delivery_failed');
  }

  const jobQueue = createBoundedJobQueue({
    worker: processRequestJob,
    concurrency: queueConcurrency,
    maxPending: queueMaxPending,
    onError: onJobError
  });

  function request({ email, ip }) {
    if (!enabled) return { available: false, accepted: false };
    const normalized = normalizeEmail(email);
    const emailAllowed = emailLimiter.take(sha256(normalized));
    const ipAllowed = ipLimiter.take(sha256(ip));
    if (
      !emailAllowed ||
      !ipAllowed ||
      !normalized ||
      !normalized.includes('@')
    ) {
      return { available: true, accepted: true };
    }
    jobQueue.enqueue({ normalized });
    return { available: true, accepted: true };
  }

  async function consume({ token, newPassword, ip }) {
    if (!consumeIpLimiter.take(sha256(ip))) return { status: 'rate_limited' };
    const parsed = RESET_TOKEN_PATTERN.exec(String(token || ''));
    if (!parsed) return { status: 'invalid' };
    if (!isStrongPassword(newPassword)) return { status: 'weak_password' };
    const [, accountId, secret] = parsed;
    const secretHash = sha256(secret);
    const preparedPasswordHash = hashPassword(newPassword);
    const accountRef = usersRef.child(accountId);
    await accountRef.once('value');
    let outcome = 'invalid';
    let proposedAuthVersion = null;
    const result = await accountRef.transaction(
      (current) => {
        outcome = 'invalid';
        proposedAuthVersion = null;
        if (!current || typeof current !== 'object') return current;
        const reset = current.passwordReset;
        if (!reset || reset.secretHash !== secretHash) return current;
        if (Number(reset.expiresAt || 0) <= now()) {
          outcome = 'expired';
          return current;
        }
        if (reset.passwordRevision !== passwordRevision(current))
          return current;
        outcome = 'success';
        proposedAuthVersion = Number.isSafeInteger(current.authVersion)
          ? current.authVersion + 1
          : 1;
        const next = {
          ...current,
          passwordHash: preparedPasswordHash,
          authVersion: proposedAuthVersion,
          updatedAt: new Date(now()).toISOString()
        };
        delete next.passwordReset;
        return next;
      },
      undefined,
      false
    );
    const committedUser = result.snapshot?.val();
    if (
      !result.committed ||
      outcome !== 'success' ||
      !committedUser ||
      committedUser.passwordHash !== preparedPasswordHash ||
      committedUser.authVersion !== proposedAuthVersion ||
      committedUser.passwordReset !== undefined
    )
      return { status: outcome === 'expired' ? 'expired' : 'invalid' };
    return { status: 'success' };
  }

  async function changePassword({ userId, currentPassword, newPassword }) {
    if (!isStrongPassword(newPassword)) return { status: 'weak_password' };
    const preparedPasswordHash = hashPassword(newPassword);
    const accountRef = usersRef.child(userId);
    await accountRef.once('value');
    let outcome = 'invalid_current_password';
    let authVersion = 0;
    const updatedAt = new Date(now()).toISOString();
    const result = await accountRef.transaction(
      (current) => {
        outcome = 'invalid_current_password';
        authVersion = 0;
        if (!current || typeof current !== 'object') return current;
        if (!verifyPassword(currentPassword, current.passwordHash))
          return current;
        outcome = 'success';
        authVersion = Number.isSafeInteger(current.authVersion)
          ? current.authVersion + 1
          : 1;
        const next = {
          ...current,
          passwordHash: preparedPasswordHash,
          authVersion,
          updatedAt
        };
        delete next.passwordReset;
        return next;
      },
      undefined,
      false
    );
    const committedUser = result.snapshot?.val();
    return result.committed &&
      outcome === 'success' &&
      committedUser?.passwordHash === preparedPasswordHash &&
      committedUser?.authVersion === authVersion &&
      committedUser?.passwordReset === undefined
      ? { status: 'success', authVersion, updatedAt }
      : { status: 'invalid_current_password' };
  }

  return {
    enabled,
    request,
    consume,
    changePassword,
    queueStats: jobQueue.stats
  };
}

module.exports = {
  NEUTRAL_REQUEST_MESSAGE,
  RESET_TTL_MS,
  RESET_TOKEN_PATTERN,
  createBoundedJobQueue,
  createBoundedRateLimiter,
  createPasswordResetService,
  createResetEmailSender,
  passwordRevision,
  resolveCanonicalOrigin,
  resolveResetClientIp,
  sha256
};
