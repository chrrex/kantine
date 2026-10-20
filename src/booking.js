'use strict';
/** Buchungslogik am Tablet: Pin prüfen, Mittagessen zählen, Gäste eintragen. */
const gastromatic = require('./gastromatic');
const { db, getJsonSetting, transaction } = require('./db');
const { hashPin, randomToken } = require('./security');
const { nowParts } = require('./time');

// ---------- Schutz gegen Durchprobieren ----------
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
const lock = { fails: 0, until: 0 };

function lockedSeconds() {
  return lock.until > Date.now() ? Math.ceil((lock.until - Date.now()) / 1000) : 0;
}
function registerFail() {
  lock.fails += 1;
  if (lock.fails >= MAX_FAILS) {
    lock.until = Date.now() + LOCK_MS;
    lock.fails = 0;
  }
}
function resetFails() { lock.fails = 0; }

// ---------- Prüfungen ----------

function findEmployeeByPin(pin) {
  if (!/^\d{1,12}$/.test(String(pin || ''))) return null;
  // Falls dieselbe Person mehreren Gesellschaften zugeordnet ist und überall denselben Pin hat,
  // gewinnt der aktive Eintrag mit der kleinsten Personalnummer.
  return db.prepare(`SELECT e.*, c.name AS company_name FROM employees e
      LEFT JOIN companies c ON c.id = e.company_id
      WHERE e.pin_hash = ? ORDER BY e.is_active DESC, e.staff_number ASC LIMIT 1`).get(hashPin(pin)) || null;
}

function isActiveOn(employee, isoDate) {
  if (!employee.is_active) return false;
  if (employee.deactivation_date && employee.deactivation_date <= isoDate) return false;
  if (employee.leave_date && employee.leave_date < isoDate) return false;
  return true;
}

function hasBookingOn(employeeId, isoDate) {
  return !!db.prepare('SELECT 1 FROM bookings WHERE employee_id = ? AND date = ? AND cancelled_at IS NULL').get(employeeId, isoDate);
}

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/**
 * Gemeinsame Prüfung für Essen und Gäste:
 * Pin bekannt → aktiv → (optional: noch nicht gegessen) → heute eingestempelt.
 * Ist Gastromatic nicht erreichbar, wird trotzdem freigegeben (punchChecked = false).
 */
async function verifyPin(pin, { requireNotBooked }) {
  const wait = lockedSeconds();
  if (wait) return fail('locked', { seconds: wait });

  const { date } = nowParts();
  const employee = findEmployeeByPin(pin);
  if (!employee) {
    registerFail();
    return fail('pin_unknown');
  }
  resetFails();
  if (!isActiveOn(employee, date)) return fail('inactive');

  const alreadyBooked = hasBookingOn(employee.id, date);
  if (requireNotBooked && alreadyBooked) return fail('already_booked', { firstName: employee.first_name });

  const punched = await gastromatic.wasPunchedIn(employee.id, date);
  if (punched === false) return fail('not_punched', { firstName: employee.first_name });

  return { ok: true, employee, alreadyBooked, punchChecked: punched === true };
}

function insertBooking(employeeId, date, time, punchChecked, source = 'kiosk', comment = null) {
  return db.prepare(`INSERT INTO bookings(employee_id, date, time, punch_checked, source, comment)
    VALUES (?, ?, ?, ?, ?, ?)`).run(employeeId, date, time, punchChecked ? 1 : 0, source, comment);
}

// ---------- Mittagessen ----------

async function bookMeal(pin) {
  const check = await verifyPin(pin, { requireNotBooked: true });
  if (!check.ok) return check;
  const { date, time } = nowParts();
  try {
    insertBooking(check.employee.id, date, time, check.punchChecked);
  } catch (err) {
    // Zwei gleichzeitige Buchungen: der eindeutige Index verhindert die zweite.
    if (/UNIQUE/i.test(err.message)) return fail('already_booked', { firstName: check.employee.first_name });
    throw err;
  }
  return { ok: true, firstName: check.employee.first_name, time, punchChecked: check.punchChecked };
}

// ---------- Gäste ----------
const GUEST_TOKEN_MS = 5 * 60 * 1000;
const guestSessions = new Map(); // token -> { employeeId, punchChecked, expires }

function cleanGuestSessions() {
  const now = Date.now();
  for (const [k, v] of guestSessions) if (v.expires < now) guestSessions.delete(k);
}

async function startGuestInvite(pin) {
  const check = await verifyPin(pin, { requireNotBooked: false });
  if (!check.ok) return check;
  cleanGuestSessions();
  const token = randomToken(24);
  guestSessions.set(token, { employeeId: check.employee.id, punchChecked: check.punchChecked, expires: Date.now() + GUEST_TOKEN_MS });
  return {
    ok: true,
    token,
    host: { firstName: check.employee.first_name, lastName: check.employee.last_name },
    alreadyBooked: check.alreadyBooked,
    payingCompanies: getJsonSetting('paying_companies'),
    reasons: getJsonSetting('reasons'),
  };
}

const clean = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function completeGuestInvite({ token, payingCompany, reason, reasonOther, guests, includeSelf }) {
  cleanGuestSessions();
  const session = guestSessions.get(String(token || ''));
  if (!session) return fail('session_expired');

  const companies = getJsonSetting('paying_companies');
  const reasons = getJsonSetting('reasons');
  const company = clean(payingCompany);
  if (!companies.includes(company)) return fail('invalid', { field: 'payingCompany' });

  let finalReason = clean(reason);
  if (finalReason === 'Sonstiges') {
    finalReason = clean(reasonOther, 200);
    if (!finalReason) return fail('invalid', { field: 'reasonOther' });
  } else if (!reasons.includes(finalReason)) {
    return fail('invalid', { field: 'reason' });
  }

  const names = (Array.isArray(guests) ? guests : []).map((g) => clean(g)).filter(Boolean);
  if (!names.length) return fail('invalid', { field: 'guests' });
  if (names.length > 20) return fail('invalid', { field: 'guests' });

  const { date, time } = nowParts();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(session.employeeId);
  let selfBooked = false;

  transaction(() => {
    const ins = db.prepare(`INSERT INTO guests(host_employee_id, date, time, paying_company, guest_name, reason)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const n of names) ins.run(employee.id, date, time, company, n, finalReason);
    if (includeSelf && !hasBookingOn(employee.id, date)) {
      insertBooking(employee.id, date, time, session.punchChecked);
      selfBooked = true;
    }
  });
  guestSessions.delete(token);

  return { ok: true, firstName: employee.first_name, guestCount: names.length, selfBooked, payingCompany: company, reason: finalReason, guests: names };
}

module.exports = { bookMeal, startGuestInvite, completeGuestInvite, insertBooking, isActiveOn, hasBookingOn, lockedSeconds };
