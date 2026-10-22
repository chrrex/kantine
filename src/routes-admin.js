'use strict';
const express = require('express');
const config = require('./config');
const { db, getSetting, setSetting, getJsonSetting, audit, SECRET_KEYS } = require('./db');
const auth = require('./auth');
const gastromatic = require('./gastromatic');
const { syncEmployees } = require('./sync');
const { buildWorkbook } = require('./excel');
const { sendExport, pendingPeriod } = require('./export');
const { sendMail } = require('./mailer');
const { nextSendDate } = require('./scheduler');
const { insertBooking, hasBookingOn } = require('./booking');
const { today, isIsoDate } = require('./time');

const router = express.Router();

// ---------- Datenschutzhinweise (öffentlich lesbar, im Admin bearbeitbar) ----------
const fs = require('node:fs');
const path = require('node:path');
const PRIVACY_MAX = 20000;
const privacyDefault = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'shared', 'privacy-default.txt'), 'utf8');
const privacyText = () => getSetting('privacy_text') || privacyDefault();

router.get('/api/privacy', (req, res) => {
  res.json({ ok: true, text: privacyText(), custom: !!getSetting('privacy_text') });
});
const bad = (res, error) => res.status(400).json({ ok: false, error });
const text = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- Anmeldung ----------
router.post('/api/admin/login', (req, res) => {
  const r = auth.login(req.body?.email, req.body?.password, req.ip);
  if (!r.ok) return res.status(401).json(r);
  res.setHeader('Set-Cookie', auth.cookie(auth.ADMIN_COOKIE, r.token, 8 * 3600));
  res.json({ ok: true, user: r.user });
});

router.post('/api/admin/logout', (req, res) => {
  auth.logout(req);
  res.setHeader('Set-Cookie', auth.cookie(auth.ADMIN_COOKIE, '', 0));
  res.json({ ok: true });
});

router.get('/api/admin/me', (req, res) => {
  const u = auth.currentUser(req);
  res.json(u ? { ok: true, user: { email: u.email, name: u.name } } : { ok: false });
});

router.use('/api/admin', auth.requireAdmin);

// ---------- Status ----------
router.get('/api/admin/status', (req, res) => {
  const { from } = pendingPeriod();
  const meals = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE cancelled_at IS NULL AND date BETWEEN ? AND ?').get(from, today()).n;
  const guests = db.prepare('SELECT COUNT(*) AS n FROM guests WHERE cancelled_at IS NULL AND date BETWEEN ? AND ?').get(from, today()).n;
  const lastExport = db.prepare('SELECT * FROM exports ORDER BY id DESC LIMIT 1').get() || null;
  res.json({
    ok: true,
    periodFrom: from,
    meals,
    guests,
    sync: { at: getSetting('last_sync_at'), status: getSetting('last_sync_status'), error: getSetting('last_sync_error') },
    lastExport,
    nextSend: nextSendDate(),
    mock: gastromatic.isMock,
  });
});

// ---------- Buchungen ----------
router.get('/api/admin/bookings', (req, res) => {
  const from = isIsoDate(req.query.from) ? req.query.from : pendingPeriod().from;
  const to = isIsoDate(req.query.to) ? req.query.to : today();
  const type = ['meal', 'guest'].includes(req.query.type) ? req.query.type : 'all';
  const company = text(req.query.company, 100);
  const q = text(req.query.q, 100);
  const like = `%${q}%`;

  const where = (alias) => [
    `${alias}.date BETWEEN ? AND ?`,
    company ? 'e.company_id = ?' : null,
    q ? `(e.first_name || ' ' || e.last_name LIKE ? OR e.last_name || ' ' || e.first_name LIKE ? OR e.staff_number LIKE ?${alias === 'g' ? ' OR g.guest_name LIKE ?' : ''})` : null,
  ].filter(Boolean).join(' AND ');
  const params = (alias) => [from, to, ...(company ? [company] : []), ...(q ? [like, like, like, ...(alias === 'g' ? [like] : [])] : [])];

  let rows = [];
  if (type !== 'guest') {
    rows = rows.concat(db.prepare(`SELECT 'meal' AS kind, b.id, b.date, b.time, e.staff_number, e.first_name, e.last_name,
        COALESCE(c.name, 'Ohne Gesellschaft') AS company, NULL AS guest_name, NULL AS paying_company, NULL AS reason,
        b.punch_checked, b.source, b.comment, b.cancelled_at, b.cancelled_by, b.cancel_comment
      FROM bookings b JOIN employees e ON e.id = b.employee_id LEFT JOIN companies c ON c.id = e.company_id
      WHERE ${where('b')}`).all(...params('b')));
  }
  if (type !== 'meal') {
    rows = rows.concat(db.prepare(`SELECT 'guest' AS kind, g.id, g.date, g.time, e.staff_number, e.first_name, e.last_name,
        COALESCE(c.name, 'Ohne Gesellschaft') AS company, g.guest_name, g.paying_company, g.reason,
        1 AS punch_checked, g.source, NULL AS comment, g.cancelled_at, g.cancelled_by, g.cancel_comment
      FROM guests g JOIN employees e ON e.id = g.host_employee_id LEFT JOIN companies c ON c.id = e.company_id
      WHERE ${where('g')}`).all(...params('g')));
  }
  rows.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time) || b.id - a.id);
  res.json({ ok: true, from, to, rows: rows.slice(0, 2000), truncated: rows.length > 2000 });
});

router.get('/api/admin/offline-rejected', (req, res) => {
  const from = isIsoDate(req.query.from) ? req.query.from : pendingPeriod().from;
  const to = isIsoDate(req.query.to) ? req.query.to : today();
  res.json({ ok: true, rows: require('./offline').rejectedEntries(from, to) });
});

router.post('/api/admin/bookings', (req, res) => {
  const { employeeId, date } = req.body || {};
  const time = /^\d{2}:\d{2}$/.test(req.body?.time || '') ? req.body.time : '12:00';
  const comment = text(req.body?.comment);
  if (!comment) return bad(res, 'Bitte einen Kommentar angeben.');
  if (!isIsoDate(date) || date > today()) return bad(res, 'Ungültiges Datum.');
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(String(employeeId || ''));
  if (!emp) return bad(res, 'Mitarbeiter nicht gefunden.');
  if (hasBookingOn(emp.id, date)) return bad(res, 'Für diesen Tag ist schon ein Essen gebucht.');
  insertBooking(emp.id, date, time, true, 'admin', comment);
  audit(req.user.email, 'booking_added', { employee: emp.staff_number, name: `${emp.first_name} ${emp.last_name}`, date, time, comment });
  res.json({ ok: true });
});

function cancel(table, kind) {
  return (req, res) => {
    const comment = text(req.body?.comment);
    if (!comment) return bad(res, 'Bitte einen Kommentar angeben.');
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(req.params.id));
    if (!row) return bad(res, 'Eintrag nicht gefunden.');
    if (row.cancelled_at) return bad(res, 'Bereits storniert.');
    db.prepare(`UPDATE ${table} SET cancelled_at = datetime('now'), cancelled_by = ?, cancel_comment = ? WHERE id = ?`)
      .run(req.user.email, comment, row.id);
    audit(req.user.email, `${kind}_cancelled`, { id: row.id, date: row.date, comment });
    res.json({ ok: true });
  };
}
router.post('/api/admin/bookings/:id/cancel', cancel('bookings', 'booking'));
router.post('/api/admin/guests/:id/cancel', cancel('guests', 'guest'));

router.get('/api/admin/employees', (req, res) => {
  const q = `%${text(req.query.q, 100)}%`;
  const rows = db.prepare(`SELECT e.id, e.staff_number, e.first_name, e.last_name, e.is_active, COALESCE(c.name, '') AS company
      FROM employees e LEFT JOIN companies c ON c.id = e.company_id
      WHERE e.first_name || ' ' || e.last_name LIKE ? OR e.last_name || ' ' || e.first_name LIKE ? OR e.staff_number LIKE ?
      ORDER BY e.is_active DESC, e.last_name, e.first_name LIMIT 20`).all(q, q, q);
  res.json({ ok: true, rows });
});

router.get('/api/admin/companies', (req, res) => {
  res.json({ ok: true, rows: db.prepare('SELECT id, name FROM companies ORDER BY name').all() });
});

// ---------- Excel ----------
router.get('/api/admin/export.xlsx', async (req, res, next) => {
  try {
    const from = isIsoDate(req.query.from) ? req.query.from : pendingPeriod().from;
    const to = isIsoDate(req.query.to) ? req.query.to : today();
    if (from > to) return bad(res, 'Zeitraum ungültig.');
    const { buffer, filename } = await buildWorkbook(from, to);
    audit(req.user.email, 'export_downloaded', { from, to });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) { next(err); }
});

router.post('/api/admin/send-now', async (req, res) => {
  res.json(await sendExport('manual', req.user.email));
});

router.get('/api/admin/exports', (req, res) => {
  res.json({ ok: true, rows: db.prepare('SELECT * FROM exports ORDER BY id DESC LIMIT 24').all() });
});

// ---------- Settings ----------
const PLAIN_KEYS = ['send_day', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_from', 'gastromatic_client_id', 'retention_months', 'sounds_enabled'];
const LIST_KEYS = ['recipients', 'paying_companies', 'reasons'];

router.get('/api/admin/settings', (req, res) => {
  const out = {};
  for (const k of PLAIN_KEYS) out[k] = getSetting(k);
  for (const k of LIST_KEYS) out[k] = getJsonSetting(k);
  for (const k of SECRET_KEYS) out[`${k}_set`] = !!getSetting(k);
  out.kiosk_url = `${req.protocol}://${req.get('host')}/kiosk?key=${encodeURIComponent(config.kioskKey)}`;
  out.gastromatic_mode = gastromatic.isMock ? 'mock' : 'live';
  res.json({ ok: true, settings: out });
});

router.put('/api/admin/settings', (req, res) => {
  const body = req.body || {};
  const changed = [];
  if (body.send_day !== undefined) {
    const d = Number(body.send_day);
    if (!Number.isInteger(d) || d < 1 || d > 28) return bad(res, 'Versandtag muss zwischen 1 und 28 liegen.');
  }
  if (body.smtp_port !== undefined && body.smtp_port !== '' && !/^\d{2,5}$/.test(String(body.smtp_port))) return bad(res, 'Ungültiger Port.');
  if (body.retention_months !== undefined) {
    const m = Number(body.retention_months);
    if (!Number.isInteger(m) || m < 1 || m > 120) return bad(res, 'Löschfrist ungültig.');
  }
  for (const k of PLAIN_KEYS) {
    if (body[k] !== undefined) { setSetting(k, text(body[k])); changed.push(k); }
  }
  for (const k of LIST_KEYS) {
    if (body[k] !== undefined) {
      if (!Array.isArray(body[k])) return bad(res, `${k} muss eine Liste sein.`);
      let list = [...new Set(body[k].map((x) => text(x, 120)).filter(Boolean))];
      if (k === 'recipients' && list.some((m) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m))) return bad(res, 'Ungültige E-Mail-Adresse bei den Empfängern.');
      if (k === 'reasons') list = list.filter((r) => r.toLowerCase() !== 'sonstiges');
      setSetting(k, JSON.stringify(list));
      changed.push(k);
    }
  }
  for (const k of SECRET_KEYS) {
    // Leere Felder bedeuten "unverändert lassen"
    if (typeof body[k] === 'string' && body[k] !== '') { setSetting(k, body[k]); changed.push(k); }
  }
  audit(req.user.email, 'settings_changed', { keys: changed });
  res.json({ ok: true });
});

router.post('/api/admin/test-mail', async (req, res) => {
  try {
    await sendMail({
      to: getJsonSetting('recipients'),
      subject: 'Kantine: Testmail',
      text: 'Diese Testmail bestätigt, dass der Versand aus der Kantinen-App funktioniert.',
    });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/api/admin/gastromatic/test', async (req, res) => {
  try { res.json({ ok: true, ...(await gastromatic.testConnection()) }); } catch (err) { res.json({ ok: false, error: err.message }); }
});

router.post('/api/admin/gastromatic/sync', async (req, res) => {
  try { res.json({ ok: true, ...(await syncEmployees(req.user.email)) }); } catch (err) { res.json({ ok: false, error: err.message }); }
});

router.put('/api/admin/privacy', (req, res) => {
  const t = String(req.body?.text ?? '').replace(/\r\n?/g, '\n');
  if (!t.trim()) return bad(res, 'Der Text darf nicht leer sein.');
  if (t.length > PRIVACY_MAX) return bad(res, `Der Text ist zu lang (max. ${PRIVACY_MAX} Zeichen).`);
  setSetting('privacy_text', t);
  audit(req.user.email, 'privacy_changed', { length: t.length });
  res.json({ ok: true });
});

router.delete('/api/admin/privacy', (req, res) => {
  setSetting('privacy_text', '');
  audit(req.user.email, 'privacy_reset');
  res.json({ ok: true, text: privacyDefault() });
});

// ---------- Benutzer ----------
router.get('/api/admin/users', (req, res) => {
  res.json({ ok: true, rows: db.prepare('SELECT id, email, name, created_at FROM admin_users ORDER BY name, email').all(), me: req.user.userId });
});

router.post('/api/admin/users', (req, res) => {
  const email = text(req.body?.email, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Ungültige E-Mail-Adresse.');
  try {
    auth.createUser(email, text(req.body?.name, 100), String(req.body?.password || ''));
  } catch (err) {
    return bad(res, /UNIQUE/i.test(err.message) ? 'Diese E-Mail ist schon angelegt.' : err.message);
  }
  audit(req.user.email, 'user_created', { email });
  res.json({ ok: true });
});

router.delete('/api/admin/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.userId) return bad(res, 'Du kannst dich nicht selbst entfernen.');
  const user = db.prepare('SELECT email FROM admin_users WHERE id = ?').get(id);
  if (!user) return bad(res, 'Benutzer nicht gefunden.');
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
  auth.dropSessionsOfUser(id);
  audit(req.user.email, 'user_deleted', { email: user.email });
  res.json({ ok: true });
});

router.post('/api/admin/password', (req, res) => {
  const { current, next } = req.body || {};
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.user.userId);
  const { verifyPassword, hashPassword } = require('./security');
  if (!verifyPassword(current, user.password_hash)) return bad(res, 'Aktuelles Passwort falsch.');
  if (String(next || '').length < 10) return bad(res, 'Das neue Passwort muss mindestens 10 Zeichen lang sein.');
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
  audit(req.user.email, 'password_changed');
  res.json({ ok: true });
});

// ---------- Protokoll ----------
router.get('/api/admin/audit', (req, res) => {
  res.json({ ok: true, rows: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all() });
});

module.exports = router;
