'use strict';
// Konfiguration aus Umgebungsvariablen bzw. der Datei .env (siehe .env.example).
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Konfiguration fehlt: ${name} (siehe .env.example)`);
  return v;
}

const config = {
  port: Number(process.env.PORT ?? 3000),
  timezone: process.env.TIMEZONE || 'Europe/Berlin',
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  // Geheimer Schlüssel: verschlüsselt Zugangsdaten in der Datenbank und bildet die Pin-Hashes.
  appSecret: required('APP_SECRET'),
  // Schlüssel, mit dem das Kantinen-Tablet einmalig freigeschaltet wird (/kiosk?key=...).
  kioskKey: required('KIOSK_KEY'),
  // "mock" = Testdaten, "live" = echte Gastromatic-API
  gastromaticMode: (process.env.GASTROMATIC_MODE || 'mock').toLowerCase(),
  gastromaticBaseUrl: process.env.GASTROMATIC_BASE_URL || 'https://api.gastromatic.de',
  // Erster Admin-Zugang, wird beim ersten Start angelegt, wenn noch kein Admin existiert.
  initialAdminEmail: process.env.ADMIN_EMAIL || '',
  initialAdminPassword: process.env.ADMIN_PASSWORD || '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
};

if (config.appSecret.length < 32) {
  throw new Error('APP_SECRET muss mindestens 32 Zeichen lang sein.');
}

module.exports = config;
