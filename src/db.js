'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { encrypt, decrypt } = require('./security');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'kantine.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id          TEXT PRIMARY KEY,          -- Gastromatic-Organisation
  name        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id               TEXT PRIMARY KEY,     -- Gastromatic-Mitarbeiter-ID
  staff_number     TEXT,
  first_name       TEXT NOT NULL DEFAULT '',
  last_name        TEXT NOT NULL DEFAULT '',
  company_id       TEXT,
  pin_hash         TEXT,                 -- HMAC des Terminal-Pins, nie der Pin selbst
  is_active        INTEGER NOT NULL DEFAULT 0,
  deactivation_date TEXT,
  leave_date       TEXT,
  synced_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employees_pin ON employees(pin_hash);

CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id   TEXT NOT NULL REFERENCES employees(id),
  date          TEXT NOT NULL,           -- YYYY-MM-DD
  time          TEXT NOT NULL,           -- HH:MM
  punch_checked INTEGER NOT NULL DEFAULT 1, -- 0 = Gastromatic war nicht erreichbar
  source        TEXT NOT NULL DEFAULT 'kiosk', -- kiosk | admin
  comment       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at  TEXT,
  cancelled_by  TEXT,
  cancel_comment TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_per_day
  ON bookings(employee_id, date) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);

CREATE TABLE IF NOT EXISTS guests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  host_employee_id TEXT NOT NULL REFERENCES employees(id),
  date             TEXT NOT NULL,
  time             TEXT NOT NULL,
  paying_company   TEXT NOT NULL,
  guest_name       TEXT NOT NULL,
  reason           TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'kiosk',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at     TEXT,
  cancelled_by     TEXT,
  cancel_comment   TEXT
);
CREATE INDEX IF NOT EXISTS idx_guests_date ON guests(date);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  details TEXT
);

CREATE TABLE IF NOT EXISTS exports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  period_from TEXT,
  period_to   TEXT,
  recipients  TEXT,
  status      TEXT NOT NULL,             -- sent | failed
  error       TEXT,
  trigger     TEXT NOT NULL              -- schedule | manual
);
`);

// ---------- Settings ----------
const SECRET_KEYS = new Set(['gastromatic_client_secret', 'smtp_pass']);

const DEFAULTS = {
  send_day: '1',
  recipients: '[]',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
  gastromatic_client_id: '',
  gastromatic_client_secret: '',
  paying_companies: '[]',
  reasons: JSON.stringify(['Bewerbungsgespräch', 'Geschäftspartner']),
  retention_months: '12',
  sounds_enabled: '1',
  last_export_to: '',       // letztes Datum, das schon versendet wurde
  last_sync_at: '',
  last_sync_status: '',
  last_sync_error: '',
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function getSetting(key) {
  const row = getStmt.get(key);
  const raw = row ? row.value : DEFAULTS[key] ?? '';
  return SECRET_KEYS.has(key) ? decrypt(raw) : raw;
}

function setSetting(key, value) {
  const v = value === null || value === undefined ? '' : String(value);
  setStmt.run(key, SECRET_KEYS.has(key) ? encrypt(v) : v);
}

function getJsonSetting(key) {
  try { return JSON.parse(getSetting(key) || '[]'); } catch { return []; }
}

function audit(actor, action, details) {
  db.prepare('INSERT INTO audit_log(actor, action, details) VALUES (?, ?, ?)')
    .run(actor, action, details ? JSON.stringify(details) : null);
}

/** Mehrere Schreibvorgänge atomar ausführen. */
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, getSetting, setSetting, getJsonSetting, audit, transaction, SECRET_KEYS };
