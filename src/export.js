'use strict';
/** Monatlicher Versand der Excel-Datei an HR. */
const { db, getSetting, setSetting, getJsonSetting, audit } = require('./db');
const { buildWorkbook } = require('./excel');
const { sendMail } = require('./mailer');
const { today, addDays, formatDe } = require('./time');

/** Zeitraum seit dem letzten Versand bis gestern (der heutige Tag läuft noch). */
function pendingPeriod() {
  const to = addDays(today(), -1);
  const last = getSetting('last_export_to');
  let from;
  if (last) {
    from = addDays(last, 1);
  } else {
    const first = db.prepare(`SELECT MIN(d) AS d FROM (
        SELECT MIN(date) AS d FROM bookings UNION ALL SELECT MIN(date) FROM guests)`).get();
    from = first?.d || to;
  }
  return { from, to };
}

async function sendExport(trigger, actor = 'system') {
  const { from, to } = pendingPeriod();
  const recipients = getJsonSetting('recipients');
  if (from > to) {
    return { ok: true, skipped: true, message: 'Seit dem letzten Versand gibt es keinen neuen abgeschlossenen Tag.' };
  }
  try {
    const { buffer, filename, counts } = await buildWorkbook(from, to);
    await sendMail({
      to: recipients,
      subject: `Kantine: Mitarbeiteressen ${formatDe(from)} – ${formatDe(to)}`,
      text: [
        'Hallo,',
        '',
        `anbei die Mitarbeiteressen der Kantine vom ${formatDe(from)} bis ${formatDe(to)}.`,
        `Mitarbeiteressen: ${counts.bookings} · Gästeessen: ${counts.guests}`,
        '',
        'Die Datei enthält ein Tabellenblatt pro Gesellschaft und ein Blatt für Gäste.',
        '',
        'Diese Nachricht wurde automatisch von der Kantinen-App verschickt.',
      ].join('\n'),
      attachments: [{ filename, content: buffer }],
    });
    db.prepare(`INSERT INTO exports(period_from, period_to, recipients, status, trigger) VALUES (?, ?, ?, 'sent', ?)`)
      .run(from, to, recipients.join(', '), trigger);
    setSetting('last_export_to', to);
    audit(actor, 'export_sent', { from, to, recipients, ...counts });
    return { ok: true, from, to, counts };
  } catch (err) {
    db.prepare(`INSERT INTO exports(period_from, period_to, recipients, status, error, trigger) VALUES (?, ?, ?, 'failed', ?, ?)`)
      .run(from, to, recipients.join(', '), err.message, trigger);
    audit(actor, 'export_failed', { from, to, error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { sendExport, pendingPeriod };
