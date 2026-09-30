'use strict';

const crypto = require('crypto');

function isStrongPassword(value = '') {
  const password = String(value || '');
  return (
    password.length >= 10 &&
    /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(password) &&
    /\d/.test(password)
  );
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
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const passwordHash = crypto.scryptSync(String(password || ''), parts[1], 64);
  const expected = Buffer.from(parts[2], 'hex');
  return (
    passwordHash.length === expected.length &&
    crypto.timingSafeEqual(passwordHash, expected)
  );
}

module.exports = { hashPassword, isStrongPassword, verifyPassword };
