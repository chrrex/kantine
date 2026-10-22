'use strict';
/** Hintergrundaufgaben: nächtlicher Gastromatic-Abgleich, monatlicher Versand, Löschfrist. */
const { db, getSetting, setSetting } = require('./db');
const { syncEmployees } = require('./sync');
const { sendExport } = require('./export');
const { nowParts, addMonths, daysInMonth } = require('./time');

const TICK_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
let lastExportAttempt = 0;

function sendDateThisMonth(isoToday) {
  const day = Math.min(Math.max(Number(getSetting('send_day')) || 1, 1), 28);
  return `${isoToday.slice(0, 8)}${String(Math.min(day, daysInMonth(isoToday))).padStart(2, '0')}`;
}

/** Nächster geplanter Versandtag (für die Anzeige). */
function nextSendDate() {
  const { date } = nowParts();
  const thisMonth = sendDateThisMonth(date);
  const sentThisMonth = db.prepare(`SELECT 1 FROM exports WHERE status = 'sent' AND date(at) >= ?`).get(thisMonth);
  if (date <= thisMonth && !sentThisMonth) return thisMonth;
  return sendDateThisMonth(addMonths(`${date.slice(0, 8)}01`, 1));
}

function cleanup() {
  const months = Number(getSetting('retention_months')) || 12;
  const cutoff = addMonths(nowParts().date, -months);
  const b = db.prepare('DELETE FROM bookings WHERE date < ?').run(cutoff).changes;
  const g = db.prepare('DELETE FROM guests WHERE date < ?').run(cutoff).changes;
  db.prepare('DELETE FROM audit_log WHERE date(at) < ?').run(cutoff);
  db.prepare('DELETE FROM exports WHERE date(at) < ?').run(cutoff);
  require('./offline').cleanupOffline(cutoff);
  // Ausgeschiedene ohne verbleibende Buchungen ganz entfernen
  db.prepare(`DELETE FROM employees WHERE is_active = 0 AND date(synced_at) < ?
      AND id NOT IN (SELECT employee_id FROM bookings) AND id NOT IN (SELECT host_employee_id FROM guests)`).run(cutoff);
  if (b || g) console.log(`[cleanup] ${b} Buchungen und ${g} Gäste älter als ${cutoff} gelöscht`);
}

async function tick() {
  const { date, time } = nowParts();
  const hour = Number(time.slice(0, 2));

  // 1. Nächtlicher Abgleich (ab 2 Uhr) bzw. beim ersten Start
  const lastSync = getSetting('last_sync_at');
  const lastSyncDate = lastSync ? nowParts(new Date(lastSync)).date : '';
  if (!lastSync || (lastSyncDate !== date && hour >= 2)) {
    try {
      const r = await syncEmployees();
      console.log(`[sync] ${r.employees} Mitarbeitende abgeglichen`);
    } catch (err) {
      console.error('[sync] fehlgeschlagen:', err.message);
    }
  }

  // 2. Monatlicher Versand (ab 6 Uhr am Versandtag, holt verpasste Tage nach, wiederholt Fehler stündlich)
  const sendDate = sendDateThisMonth(date);
  const mailReady = getSetting('smtp_host') && getSetting('recipients') !== '[]';
  if (mailReady && date >= sendDate && hour >= 6 && Date.now() - lastExportAttempt > RETRY_MS) {
    const sent = db.prepare(`SELECT 1 FROM exports WHERE status = 'sent' AND date(at) >= ?`).get(sendDate);
    if (!sent) {
      lastExportAttempt = Date.now();
      const r = await sendExport('schedule');
      console.log('[export]', r.ok ? (r.skipped ? r.message : `versendet ${r.from} – ${r.to}`) : `Fehler: ${r.error}`);
    }
  }

  // 3. Löschfrist, einmal täglich
  if (getSetting('last_cleanup_date') !== date) {
    cleanup();
    setSetting('last_cleanup_date', date);
  }
}

function startScheduler() {
  const run = () => tick().catch((err) => console.error('[scheduler]', err));
  setTimeout(run, 2000);
  return setInterval(run, TICK_MS);
}

module.exports = { startScheduler, nextSendDate, cleanup };
