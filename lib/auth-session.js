'use strict';

const crypto = require('crypto');

function createUserSessionCodec({ secret, durationMs, now = Date.now }) {
  function sign(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }
  function build(userId, authVersion = 0, createdAt = now()) {
    const payload = `${String(userId || '').trim()}:${createdAt}:${Number(authVersion) || 0}`;
    return `${payload}.${sign(payload)}`;
  }
  function parse(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const payload = String(parts[0] || '').trim();
    const signature = String(parts[1] || '').trim();
    const expected = sign(payload);
    const actualBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    )
      return null;
    const payloadParts = payload.split(':');
    const userId = String(payloadParts[0] || '').trim();
    const createdAt = Number(payloadParts[1]);
    const authVersion = payloadParts.length >= 3 ? Number(payloadParts[2]) : 0;
    if (
      !userId ||
      !Number.isFinite(createdAt) ||
      createdAt <= 0 ||
      !Number.isSafeInteger(authVersion) ||
      now() - createdAt > durationMs
    )
      return null;
    return { userId, createdAt, authVersion };
  }
  return { build, parse, sign };
}

function sessionMatchesUser(session, user) {
  const currentVersion = Number.isSafeInteger(user?.authVersion)
    ? user.authVersion
    : 0;
  return Number(session?.authVersion || 0) === currentVersion;
}

module.exports = { createUserSessionCodec, sessionMatchesUser };
