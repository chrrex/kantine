'use strict';
const crypto = require('node:crypto');
const config = require('./config');

// Getrennte Schlüssel aus dem einen APP_SECRET ableiten.
const pinKey = crypto.createHmac('sha256', config.appSecret).update('pin').digest();
const encKey = crypto.createHmac('sha256', config.appSecret).update('settings-encryption').digest();

/** Pins werden nie im Klartext gespeichert, nur als HMAC (deterministisch, damit man danach suchen kann). */
function hashPin(pin) {
  return crypto.createHmac('sha256', pinKey).update(String(pin).trim()).digest('hex');
}

/** Zugangsdaten (Gastromatic-Secret, Postfach-Passwort) verschlüsselt ablegen. */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(stored) {
  if (!stored) return '';
  const [v, iv, tag, data] = String(stored).split(':');
  if (v !== 'v1') return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split(':');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { hashPin, encrypt, decrypt, hashPassword, verifyPassword, randomToken, safeEqual };
