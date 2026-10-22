'use strict';
/**
 * Offline-Buchungen: Ist das Tablet ohne WLAN, speichert es die Pin-Eingabe verschlüsselt
 * (RSA-OAEP mit dem öffentlichen Schlüssel des Servers) und reicht sie später nach.
 * Nur der Server kann die Einträge entschlüsseln. Erst hier werden sie geprüft.
 */
const crypto = require('node:crypto');
const gastromatic = require('./gastromatic');
const { db, getSetting, setSetting, transaction } = require('./db');
const { encrypt, decrypt } = require('./security');
const { findEmployeeByPin, isActiveOn, hasBookingOn, insertBooking } = require('./booking');
const { nowParts } = require('./time');

const MAX_AGE_DAYS = 7;          // ältere Offline-Einträge werden nicht mehr angenommen
const MAX_FUTURE_MS = 10 * 60e3; // Uhr des Tablets darf etwas vorgehen
const MAX_ITEMS = 200;           // pro Übertragung

db.exec(`
CREATE TABLE IF NOT EXISTS offline_entries (
  id          TEXT PRIMARY KEY,          -- vom Tablet vergebene Zufalls-ID (doppelte Übertragung erkennen)
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  date        TEXT,
  time        TEXT,
  employee_id TEXT,
  status      TEXT NOT NULL,             -- accepted | rejected
  reason      TEXT,
  booking_id  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_offline_date ON offline_entries(date);
`);

const REASONS = {
  pin_unknown: 'Pin unbekannt',
  inactive: 'Kein aktives Profil',
  already_booked: 'An diesem Tag schon gebucht',
  not_punched: 'An diesem Tag nicht eingestempelt',
  invalid_time: 'Ungültige Uhrzeit auf dem Tablet',
  undecryptable: 'Eintrag nicht lesbar',
};

// ---------- Schlüsselpaar ----------
function ensureKeys() {
  if (getSetting('offline_public_key') && getSetting('offline_private_key')) return;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  setSetting('offline_public_key', publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  setSetting('offline_private_key', encrypt(privateKey.export({ type: 'pkcs8', format: 'pem' })));
}

function publicKeySpki() {
  ensureKeys();
  return getSetting('offline_public_key');
}

let privateKeyCache = null;
function privateKey() {
  ensureKeys();
  if (!privateKeyCache) privateKeyCache = crypto.createPrivateKey(decrypt(getSetting('offline_private_key')));
  return privateKeyCache;
}

function decryptItem(enc) {
  const plain = crypto.privateDecrypt(
    { key: privateKey(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(String(enc), 'base64'),
  );
  return JSON.parse(plain.toString('utf8'));
}

// ---------- Verarbeitung ----------
const idOk = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);

function record(id, data) {
  db.prepare(`INSERT INTO offline_entries(id, date, time, employee_id, status, reason, booking_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, data.date ?? null, data.time ?? null, data.employeeId ?? null,
    data.status, data.reason ?? null, data.bookingId ?? null);
}

async function processOne(item) {
  const id = item?.id;
  if (!idOk(id)) return { id, status: 'invalid' };
  const seen = db.prepare('SELECT status FROM offline_entries WHERE id = ?').get(id);
  if (seen) return { id, status: seen.status, duplicate: true };

  let payload;
  try { payload = decryptItem(item.enc); } catch {
    record(id, { status: 'rejected', reason: 'undecryptable' });
    return { id, status: 'rejected', reason: 'undecryptable' };
  }

  const ts = Date.parse(payload.ts);
  const now = Date.now();
  if (!Number.isFinite(ts) || ts > now + MAX_FUTURE_MS || ts < now - MAX_AGE_DAYS * 864e5) {
    record(id, { status: 'rejected', reason: 'invalid_time' });
    return { id, status: 'rejected', reason: 'invalid_time' };
  }
  const { date, time } = nowParts(new Date(Math.min(ts, now)));
  const reject = (reason, employeeId) => {
    record(id, { date, time, employeeId, status: 'rejected', reason });
    return { id, status: 'rejected', reason };
  };

  const employee = findEmployeeByPin(payload.pin);
  if (!employee) return reject('pin_unknown');
  if (!isActiveOn(employee, date)) return reject('inactive', employee.id);
  if (hasBookingOn(employee.id, date)) return reject('already_booked', employee.id);

  const punched = await gastromatic.wasPunchedIn(employee.id, date);
  if (punched === false) return reject('not_punched', employee.id);
  const punchChecked = punched === true;

  try {
    return transaction(() => {
      const r = insertBooking(employee.id, date, time, punchChecked, 'offline', 'offline erfasst');
      record(id, { date, time, employeeId: employee.id, status: 'accepted', bookingId: Number(r.lastInsertRowid) });
      return { id, status: 'accepted' };
    });
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) return reject('already_booked', employee.id);
    throw err;
  }
}

async function processBatch(items) {
  const list = Array.isArray(items) ? items.slice(0, MAX_ITEMS) : [];
  // Älteste zuerst, damit bei zwei Offline-Eingaben derselben Person die erste zählt
  const sorted = [...list].sort((a, b) => String(a?.order ?? '').localeCompare(String(b?.order ?? '')));
  const results = [];
  for (const item of sorted) results.push(await processOne(item));
  return results;
}

function rejectedEntries(from, to) {
  return db.prepare(`SELECT o.id, o.date, o.time, o.reason, o.received_at, e.staff_number, e.first_name, e.last_name
      FROM offline_entries o LEFT JOIN employees e ON e.id = o.employee_id
      WHERE o.status = 'rejected' AND COALESCE(o.date, date(o.received_at)) BETWEEN ? AND ?
      ORDER BY COALESCE(o.date, date(o.received_at)) DESC, o.time DESC`).all(from, to)
    .map((r) => ({ ...r, reason_text: REASONS[r.reason] || r.reason }));
}

function cleanupOffline(cutoff) {
  db.prepare('DELETE FROM offline_entries WHERE date(received_at) < ?').run(cutoff);
}

module.exports = { publicKeySpki, processBatch, rejectedEntries, cleanupOffline, REASONS, MAX_AGE_DAYS };
