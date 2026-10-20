'use strict';
// Ende-zu-Ende-Test mit Testdaten: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantine-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: '0',
  DATA_DIR: dataDir,
  APP_SECRET: 'test-secret-test-secret-test-secret-123',
  KIOSK_KEY: 'tablet-key',
  GASTROMATIC_MODE: 'mock',
  ADMIN_EMAIL: 'hr@example.org',
  ADMIN_PASSWORD: 'sehr-geheim-123',
});

const { server } = require('../server');
const ExcelJS = require('exceljs');

let base;
let kioskCookie;
let adminCookie;

async function call(method, url, { body, cookie } = {}) {
  const res = await fetch(base + url, {
    method,
    redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}
const json = async (...a) => (await call(...a)).json();
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

test.before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('Tablet muss freigeschaltet sein', async () => {
  const r = await call('POST', '/api/kiosk/meal', { body: { pin: '1111' } });
  assert.equal(r.status, 401);
  const wrong = await call('GET', '/kiosk?key=falsch');
  assert.equal(wrong.status, 403);
  const ok = await call('GET', '/kiosk?key=tablet-key');
  assert.equal(ok.status, 302);
  kioskCookie = cookieOf(ok);
  const page = await call('GET', '/kiosk', { cookie: kioskCookie });
  assert.equal(page.status, 200);
});

test('Admin-Login und Mitarbeiter-Abgleich', async () => {
  const bad = await call('POST', '/api/admin/login', { body: { email: 'hr@example.org', password: 'falsch' } });
  assert.equal(bad.status, 401);
  const res = await call('POST', '/api/admin/login', { body: { email: 'hr@example.org', password: 'sehr-geheim-123' } });
  assert.equal(res.status, 200);
  adminCookie = cookieOf(res);
  const sync = await json('POST', '/api/admin/gastromatic/sync', { cookie: adminCookie });
  assert.equal(sync.ok, true);
  assert.equal(sync.employees, 7);
  const set = await json('PUT', '/api/admin/settings', { cookie: adminCookie, body: { paying_companies: ['Schloss & Gut Liebenberg', 'DKB Stiftung'] } });
  assert.equal(set.ok, true);
});

test('Mittagessen: alle Prüfungen', async () => {
  const meal = (pin) => json('POST', '/api/kiosk/meal', { cookie: kioskCookie, body: { pin } });
  const ok = await meal('1111');
  assert.equal(ok.ok, true);
  assert.equal(ok.firstName, 'Anna');
  assert.equal((await meal('1111')).code, 'already_booked');
  assert.equal((await meal('9999')).code, 'pin_unknown');
  assert.equal((await meal('4444')).code, 'inactive');
  assert.equal((await meal('5555')).code, 'not_punched');
  assert.equal((await meal('7777')).code, 'inactive');
  const offline = await meal('6666');
  assert.equal(offline.ok, true);
  assert.equal(offline.punchChecked, false);
});

test('Gäste einladen inkl. eigenem Essen', async () => {
  const start = await json('POST', '/api/kiosk/guest/start', { cookie: kioskCookie, body: { pin: '2222' } });
  assert.equal(start.ok, true);
  assert.equal(start.alreadyBooked, false);
  const invalid = await json('POST', '/api/kiosk/guest/complete', { cookie: kioskCookie, body: { token: start.token, payingCompany: 'Unbekannt', reason: 'Geschäftspartner', guests: ['X'] } });
  assert.equal(invalid.code, 'invalid');
  const done = await json('POST', '/api/kiosk/guest/complete', {
    cookie: kioskCookie,
    body: { token: start.token, payingCompany: 'DKB Stiftung', reason: 'Sonstiges', reasonOther: 'Lieferantengespräch', guests: ['Max Muster', 'Erika Muster'], includeSelf: true },
  });
  assert.equal(done.ok, true);
  assert.equal(done.guestCount, 2);
  assert.equal(done.selfBooked, true);
  // Token ist nur einmal gültig
  const again = await json('POST', '/api/kiosk/guest/complete', { cookie: kioskCookie, body: { token: start.token, payingCompany: 'DKB Stiftung', reason: 'Geschäftspartner', guests: ['Y'] } });
  assert.equal(again.code, 'session_expired');
  // Wer schon gegessen hat, kann trotzdem Gäste einladen
  const start2 = await json('POST', '/api/kiosk/guest/start', { cookie: kioskCookie, body: { pin: '1111' } });
  assert.equal(start2.ok, true);
  assert.equal(start2.alreadyBooked, true);
});

test('Admin: Liste, Storno, Nachtrag, Excel', async () => {
  const list = await json('GET', '/api/admin/bookings', { cookie: adminCookie });
  assert.equal(list.ok, true);
  const meals = list.rows.filter((r) => r.kind === 'meal');
  const guests = list.rows.filter((r) => r.kind === 'guest');
  assert.equal(meals.length, 3);
  assert.equal(guests.length, 2);

  const noComment = await json('POST', `/api/admin/bookings/${meals[0].id}/cancel`, { cookie: adminCookie, body: {} });
  assert.equal(noComment.ok, false);
  const cancel = await json('POST', `/api/admin/bookings/${meals[0].id}/cancel`, { cookie: adminCookie, body: { comment: 'Test' } });
  assert.equal(cancel.ok, true);

  const emp = await json('GET', '/api/admin/employees?q=Clara', { cookie: adminCookie });
  const add = await json('POST', '/api/admin/bookings', { cookie: adminCookie, body: { employeeId: emp.rows[0].id, date: list.to, time: '12:30', comment: 'Tablet defekt' } });
  assert.equal(add.ok, true);

  const res = await call('GET', `/api/admin/export.xlsx?from=${list.from}&to=${list.to}`, { cookie: adminCookie });
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const names = wb.worksheets.map((w) => w.name);
  assert.deepEqual(names, ['Übersicht', 'Gutsbetrieb Liebenberg', 'Schloss & Gut Liebenberg', 'Gäste']);
  assert.equal(wb.getWorksheet('Gäste').rowCount, 3);
});

test('Admin-API ohne Anmeldung gesperrt', async () => {
  const r = await call('GET', '/api/admin/bookings');
  assert.equal(r.status, 401);
});

test('Sperre nach 5 falschen Pins', async () => {
  for (let i = 0; i < 5; i++) await json('POST', '/api/kiosk/meal', { cookie: kioskCookie, body: { pin: '0000' } });
  const r = await json('POST', '/api/kiosk/meal', { cookie: kioskCookie, body: { pin: '3333' } });
  assert.equal(r.code, 'locked');
});
