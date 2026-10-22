'use strict';
/**
 * Sichert die Datenbank im laufenden Betrieb (SQLite "VACUUM INTO", konsistent auch bei WAL).
 * Aufruf: node scripts/backup-db.js <Zieldatei>
 */
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const source = path.join(dataDir, 'kantine.db');
const target = process.argv[2];

if (!target) { console.error('Zieldatei fehlt: node scripts/backup-db.js <datei>'); process.exit(2); }
if (!fs.existsSync(source)) { console.log('Noch keine Datenbank vorhanden, nichts zu sichern.'); process.exit(0); }

const { DatabaseSync } = require('node:sqlite');
fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
if (fs.existsSync(target)) fs.rmSync(target);
const db = new DatabaseSync(source, { readOnly: true });
db.exec(`VACUUM INTO '${path.resolve(target).replaceAll("'", "''")}'`);
db.close();
console.log(`Datenbank gesichert: ${path.resolve(target)}`);
