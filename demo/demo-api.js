'use strict';
/**
 * Demo-Modus für GitHub Pages: ersetzt den Server durch einen Simulator im Browser.
 * Alle Aufrufe an /api/... werden hier beantwortet. Die Daten liegen nur im
 * localStorage dieses Browsers (Tablet- und Admin-Tab teilen sie sich).
 * Gastromatic und Mailversand werden nur simuliert.
 */
(() => {
  const STORE = 'kantine-demo-v1';
  const TZ = 'Europe/Berlin';
  const DEMO_USER = { email: 'demo@liebenberg.de', password: 'kantine-demo' };

  // ---------- Zeit ----------
  function nowParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t).value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}` };
  }
  const today = () => nowParts().date;
  function addDays(iso, n) { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function addMonths(iso, n) {
    const d = new Date(`${iso}T12:00:00Z`); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  }
  const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const formatDe = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
  const nowTs = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  // ---------- Testdaten ----------
  const EMPLOYEES = [
    { id: 'emp-1', staff_number: '1001', first_name: 'Anna', last_name: 'Becker', company_id: 'org-sgl', pin: '1111', is_active: 1, punched: true },
    { id: 'emp-2', staff_number: '1002', first_name: 'Ben', last_name: 'Schulz', company_id: 'org-sgl', pin: '2222', is_active: 1, punched: true },
    { id: 'emp-3', staff_number: '2001', first_name: 'Clara', last_name: 'Wagner', company_id: 'org-gut', pin: '3333', is_active: 1, punched: true },
    { id: 'emp-4', staff_number: '1003', first_name: 'David', last_name: 'Klein', company_id: 'org-sgl', pin: '4444', is_active: 0, punched: true },
    { id: 'emp-5', staff_number: '2002', first_name: 'Emma', last_name: 'Hoffmann', company_id: 'org-gut', pin: '5555', is_active: 1, punched: false },
    { id: 'emp-6', staff_number: '1004', first_name: 'Felix', last_name: 'Richter', company_id: 'org-sgl', pin: '6666', is_active: 1, punched: 'offline' },
    { id: 'emp-7', staff_number: '1005', first_name: 'Greta', last_name: 'Neumann', company_id: 'org-sgl', pin: '7777', is_active: 1, leave_date: '2026-01-31', punched: true },
  ];
  const COMPANIES = [{ id: 'org-sgl', name: 'Schloss & Gut Liebenberg' }, { id: 'org-gut', name: 'Gutsbetrieb Liebenberg' }];

  function seed() {
    const t = today();
    const bookings = [];
    const guests = [];
    let id = 1;
    // Die letzten 12 Arbeitstage mit ein paar Essen füllen
    const days = [];
    for (let d = addDays(t, -1); days.length < 12; d = addDays(d, -1)) {
      const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (wd !== 0 && wd !== 6) days.push(d);
    }
    days.reverse().forEach((d, i) => {
      ['emp-1', 'emp-2', 'emp-3', 'emp-6'].forEach((e, j) => {
        if ((i + j) % 4 === 3) return; // nicht jeden Tag
        bookings.push({ id: id++, employee_id: e, date: d, time: `12:${String(5 + j * 7 + (i % 5)).padStart(2, '0')}`, punch_checked: e === 'emp-6' && i % 3 === 0 ? 0 : 1, source: 'kiosk', comment: null, cancelled_at: null });
      });
    });
    guests.push({ id: 1, host_employee_id: 'emp-2', date: days[3], time: '12:20', paying_company: 'DKB STIFTUNG', guest_name: 'Jana Vogel', reason: 'Geschäftspartner', source: 'kiosk', cancelled_at: null });
    guests.push({ id: 2, host_employee_id: 'emp-1', date: days[8], time: '12:40', paying_company: 'Schloss & Gut Liebenberg', guest_name: 'Tom Krüger', reason: 'Bewerbungsgespräch', source: 'kiosk', cancelled_at: null });
    const lastExportTo = addDays(days[0], -1);
    return {
      employees: EMPLOYEES.map(({ punched, ...e }) => ({ deactivation_date: null, leave_date: null, ...e })),
      companies: COMPANIES,
      bookings, guests, nextId: id, nextGuestId: 3,
      settings: {
        send_day: '1', recipients: ['personal@example.org'], smtp_host: 'smtp.office365.com', smtp_port: '587', smtp_user: 'kantine@example.org',
        smtp_from: 'kantine@example.org', smtp_pass_set: true, gastromatic_client_id: '', gastromatic_client_secret_set: false,
        paying_companies: ['Schloss & Gut Liebenberg', 'Gutsbetrieb Liebenberg', 'DKB STIFTUNG'],
        reasons: ['Bewerbungsgespräch', 'Geschäftspartner', 'Probearbeiten'], retention_months: '12', sounds_enabled: '1',
        last_export_to: lastExportTo, last_sync_at: new Date().toISOString(), last_sync_status: 'ok', last_sync_error: '',
      },
      users: [{ id: 1, email: DEMO_USER.email, name: 'Demo', password: DEMO_USER.password, created_at: nowTs() }],
      exports: [{ id: 1, at: `${lastExportTo} 06:00:00`, period_from: addMonths(lastExportTo, -1), period_to: lastExportTo, recipients: 'personal@example.org', status: 'sent', error: null, trigger: 'schedule' }],
      audit: [{ id: 1, at: nowTs(), actor: 'system', action: 'demo_started', details: null }],
      session: null,
    };
  }

  let db;
  try { db = JSON.parse(localStorage.getItem(STORE)); } catch { db = null; }
  if (!db || !db.employees) db = seed();
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(db)); } catch { /* voll oder gesperrt */ } };
  const reload = () => { try { const fresh = JSON.parse(localStorage.getItem(STORE)); if (fresh && fresh.employees) db = fresh; } catch { /* egal */ } };
  save();
  window.kantineDemoReset = () => { localStorage.removeItem(STORE); location.reload(); };

  const audit = (actor, action, details) => {
    db.audit.unshift({ id: (db.audit[0]?.id || 0) + 1, at: nowTs(), actor, action, details: details ? JSON.stringify(details) : null });
    db.audit = db.audit.slice(0, 300);
  };
  const emp = (id) => db.employees.find((e) => e.id === id);
  const companyName = (e) => db.companies.find((c) => c.id === e.company_id)?.name || 'Ohne Gesellschaft';
  const clean = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  // ---------- Tablet-Logik (wie src/booking.js) ----------
  const lock = { fails: 0, until: 0 };
  const guestSessions = new Map();
  const isActiveOn = (e, d) => e.is_active && !(e.deactivation_date && e.deactivation_date <= d) && !(e.leave_date && e.leave_date < d);
  const hasBookingOn = (id, d) => db.bookings.some((b) => b.employee_id === id && b.date === d && !b.cancelled_at);
  const fail = (code, extra) => ({ ok: false, code, ...extra });

  async function verifyPin(pin, requireNotBooked) {
    if (lock.until > Date.now()) return fail('locked', { seconds: Math.ceil((lock.until - Date.now()) / 1000) });
    const d = today();
    const e = db.employees.filter((x) => x.pin === String(pin)).sort((a, b) => b.is_active - a.is_active)[0];
    if (!e) { if (++lock.fails >= 5) { lock.until = Date.now() + 60000; lock.fails = 0; } return fail('pin_unknown'); }
    lock.fails = 0;
    if (!isActiveOn(e, d)) return fail('inactive');
    const alreadyBooked = hasBookingOn(e.id, d);
    if (requireNotBooked && alreadyBooked) return fail('already_booked', { firstName: e.first_name });
    await new Promise((r) => setTimeout(r, 250)); // „Gastromatic-Abfrage“
    const punched = EMPLOYEES.find((x) => x.id === e.id)?.punched;
    if (punched === false) return fail('not_punched', { firstName: e.first_name });
    return { ok: true, employee: e, alreadyBooked, punchChecked: punched === true };
  }
  function removeTodaysBooking(employeeId, date) {
    db.bookings = db.bookings.filter((b) => !(b.employee_id === employeeId && b.date === date && !b.cancelled_at && b.source === 'kiosk'));
  }
  function addBooking(employeeId, date, time, punchChecked, source = 'kiosk', comment = null) {
    db.bookings.push({ id: db.nextId++, employee_id: employeeId, date, time, punch_checked: punchChecked ? 1 : 0, source, comment, cancelled_at: null });
  }

  // ---------- Excel (wie src/excel.js, mit ExcelJS im Browser) ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.ExcelJS) return resolve();
      const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject; document.head.append(s);
    });
  }
  const scriptBase = document.currentScript.src.replace(/[^/]+$/, '');

  async function buildWorkbook(from, to) {
    await loadScript(`${scriptBase}exceljs.min.js`);
    const ExcelJS = window.ExcelJS;
    const header = (row) => { row.font = { bold: true, color: { argb: 'FFFFFFFF' } }; row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B7A3E' } }; };
    const rows = db.bookings.filter((b) => !b.cancelled_at && b.date >= from && b.date <= to).map((b) => ({ ...b, e: emp(b.employee_id) }));
    const guests = db.guests.filter((g) => !g.cancelled_at && g.date >= from && g.date <= to).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const wb = new ExcelJS.Workbook();
    const byCompany = new Map();
    for (const r of rows) { const c = companyName(r.e); if (!byCompany.has(c)) byCompany.set(c, []); byCompany.get(c).push(r); }
    const sorted = [...byCompany.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'));

    const ov = wb.addWorksheet('Übersicht');
    ov.columns = [{ width: 36 }, { width: 18 }];
    ov.addRow(['Mitarbeiteressen Kantine (DEMO)']).font = { bold: true, size: 14 };
    ov.addRow(['Zeitraum', `${formatDe(from)} – ${formatDe(to)}`]);
    ov.addRow(['Erstellt am', `${formatDe(today())} ${nowParts().time} Uhr`]);
    ov.addRow([]);
    header(ov.addRow(['Gesellschaft', 'Anzahl Essen']));
    for (const [c, list] of sorted) ov.addRow([c, list.length]);
    ov.addRow(['Summe Mitarbeiteressen', rows.length]).font = { bold: true };
    ov.addRow(['Gästeessen', guests.length]).font = { bold: true };

    for (const [c, list] of sorted) {
      const ws = wb.addWorksheet(c.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
      ws.columns = [{ header: 'Personalnr.', width: 14 }, { header: 'Nachname', width: 22 }, { header: 'Vorname', width: 18 }, { header: 'Datum', width: 13 }, { header: 'Uhrzeit', width: 10 }, { header: 'Vermerk', width: 30 }];
      header(ws.getRow(1));
      list.sort((a, b) => a.e.last_name.localeCompare(b.e.last_name, 'de') || (a.date + a.time).localeCompare(b.date + b.time));
      for (const r of list) {
        const notes = [!r.punch_checked && 'Stempelung nicht geprüft', r.source === 'admin' && 'nachgetragen'].filter(Boolean).join(', ');
        ws.addRow([r.e.staff_number, r.e.last_name, r.e.first_name, formatDe(r.date), r.time, notes]);
      }
      ws.addRow([]); ws.addRow([]);
      header(ws.addRow(['Personalnr.', 'Nachname', 'Vorname', 'Anzahl Essen']));
      const per = new Map();
      for (const r of list) { const p = per.get(r.e.id) || { e: r.e, n: 0 }; p.n++; per.set(r.e.id, p); }
      for (const p of per.values()) ws.addRow([p.e.staff_number, p.e.last_name, p.e.first_name, p.n]);
      ws.addRow(['', 'Summe', '', list.length]).font = { bold: true };
    }
    const gs = wb.addWorksheet('Gäste');
    gs.columns = [{ header: 'Datum', width: 13 }, { header: 'Uhrzeit', width: 10 }, { header: 'Einladende Person', width: 26 }, { header: 'Personalnr.', width: 14 }, { header: 'Zahlende Firma', width: 30 }, { header: 'Gast', width: 26 }, { header: 'Grund', width: 36 }];
    header(gs.getRow(1));
    for (const g of guests) { const h = emp(g.host_employee_id); gs.addRow([formatDe(g.date), g.time, `${h.last_name}, ${h.first_name}`, h.staff_number, g.paying_company, g.guest_name, g.reason]); }
    return { buffer: await wb.xlsx.writeBuffer(), filename: `Kantine_${from}_bis_${to}.xlsx`, counts: { bookings: rows.length, guests: guests.length } };
  }

  function pendingPeriod() {
    const to = addDays(today(), -1);
    const from = db.settings.last_export_to ? addDays(db.settings.last_export_to, 1) : to;
    return { from, to };
  }
  function nextSendDate() {
    const d = today();
    const day = String(Math.min(Number(db.settings.send_day) || 1, 28)).padStart(2, '0');
    const thisMonth = `${d.slice(0, 8)}${day}`;
    const sent = db.exports.some((e) => e.status === 'sent' && e.at.slice(0, 10) >= thisMonth);
    return d <= thisMonth && !sent ? thisMonth : `${addMonths(`${d.slice(0, 8)}01`, 1).slice(0, 8)}${day}`;
  }

  // ---------- API ----------
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const bad = (error) => json({ ok: false, error }, 400);
  const user = () => db.session && db.users.find((u) => u.id === db.session);

  async function handle(method, path, query, body) {
    reload();
    // Tablet
    if (path === 'kiosk/config') return json({ sounds: db.settings.sounds_enabled !== '0' });
    if (path === 'kiosk/meal') {
      // Demo: Test-Pins sollen beliebig oft funktionieren. Eine frühere Buchung derselben Person
      // von heute wird gelöscht und durch die neue ersetzt (in der echten App: „Schon gebucht“).
      const c = await verifyPin(body.pin, false);
      if (!c.ok) return json(c);
      const { date, time } = nowParts();
      removeTodaysBooking(c.employee.id, date);
      addBooking(c.employee.id, date, time, c.punchChecked);
      save();
      return json({ ok: true, firstName: c.employee.first_name, time, punchChecked: c.punchChecked });
    }
    if (path === 'kiosk/guest/start') {
      const c = await verifyPin(body.pin, false);
      if (!c.ok) return json(c);
      const token = Math.random().toString(36).slice(2);
      guestSessions.set(token, { employeeId: c.employee.id, punchChecked: c.punchChecked });
      return json({ ok: true, token, host: { firstName: c.employee.first_name, lastName: c.employee.last_name }, alreadyBooked: false, payingCompanies: db.settings.paying_companies, reasons: db.settings.reasons });
    }
    if (path === 'kiosk/guest/complete') {
      const s = guestSessions.get(body.token);
      if (!s) return json(fail('session_expired'));
      const company = clean(body.payingCompany);
      if (!db.settings.paying_companies.includes(company)) return json(fail('invalid', { field: 'payingCompany' }));
      let reason = clean(body.reason);
      if (reason === 'Sonstiges') { reason = clean(body.reasonOther, 200); if (!reason) return json(fail('invalid')); } else if (!db.settings.reasons.includes(reason)) return json(fail('invalid'));
      const names = (body.guests || []).map((g) => clean(g)).filter(Boolean);
      if (!names.length) return json(fail('invalid'));
      const { date, time } = nowParts();
      for (const n of names) db.guests.push({ id: db.nextGuestId++, host_employee_id: s.employeeId, date, time, paying_company: company, guest_name: n, reason, source: 'kiosk', cancelled_at: null });
      let selfBooked = false;
      if (body.includeSelf) { removeTodaysBooking(s.employeeId, date); addBooking(s.employeeId, date, time, s.punchChecked); selfBooked = true; }
      guestSessions.delete(body.token);
      save();
      return json({ ok: true, firstName: emp(s.employeeId).first_name, guestCount: names.length, selfBooked, payingCompany: company, reason, guests: names });
    }

    // Admin: Anmeldung
    if (path === 'admin/login') {
      const u = db.users.find((x) => x.email.toLowerCase() === String(body.email || '').trim().toLowerCase() && x.password === body.password);
      if (!u) return json({ ok: false, error: 'E-Mail oder Passwort falsch.' }, 401);
      db.session = u.id; audit(u.email, 'login'); save();
      return json({ ok: true, user: { email: u.email, name: u.name } });
    }
    if (path === 'admin/logout') { db.session = null; save(); return json({ ok: true }); }
    if (path === 'admin/me') { const u = user(); return json(u ? { ok: true, user: { email: u.email, name: u.name } } : { ok: false }); }
    const me = user();
    if (path.startsWith('admin/') && !me) return json({ ok: false, error: 'Bitte anmelden.' }, 401);

    if (path === 'admin/status') {
      const { from } = pendingPeriod();
      const t = today();
      const inRange = (x) => !x.cancelled_at && x.date >= from && x.date <= t;
      return json({
        ok: true, periodFrom: from, meals: db.bookings.filter(inRange).length, guests: db.guests.filter(inRange).length,
        sync: { at: db.settings.last_sync_at, status: db.settings.last_sync_status, error: db.settings.last_sync_error },
        lastExport: db.exports[db.exports.length - 1] || null, nextSend: nextSendDate(), mock: true,
      });
    }
    if (path === 'admin/companies') return json({ ok: true, rows: db.companies });
    if (path === 'admin/employees') {
      const q = clean(query.get('q')).toLowerCase();
      const rows = db.employees.filter((e) => `${e.first_name} ${e.last_name} ${e.last_name} ${e.first_name} ${e.staff_number}`.toLowerCase().includes(q))
        .map((e) => ({ id: e.id, staff_number: e.staff_number, first_name: e.first_name, last_name: e.last_name, is_active: e.is_active, company: companyName(e) }));
      return json({ ok: true, rows });
    }
    if (path === 'admin/bookings' && method === 'GET') {
      const from = isIso(query.get('from')) ? query.get('from') : pendingPeriod().from;
      const to = isIso(query.get('to')) ? query.get('to') : today();
      const type = query.get('type') || 'all';
      const company = query.get('company') || '';
      const q = clean(query.get('q')).toLowerCase();
      const match = (e, extra = '') => (!company || e.company_id === company) && (!q || `${e.first_name} ${e.last_name} ${e.last_name} ${e.first_name} ${e.staff_number} ${extra}`.toLowerCase().includes(q));
      let rows = [];
      if (type !== 'guest') {
        rows = rows.concat(db.bookings.filter((b) => b.date >= from && b.date <= to && match(emp(b.employee_id))).map((b) => {
          const e = emp(b.employee_id);
          return { kind: 'meal', id: b.id, date: b.date, time: b.time, staff_number: e.staff_number, first_name: e.first_name, last_name: e.last_name, company: companyName(e), punch_checked: b.punch_checked, source: b.source, comment: b.comment, cancelled_at: b.cancelled_at, cancelled_by: b.cancelled_by, cancel_comment: b.cancel_comment };
        }));
      }
      if (type !== 'meal') {
        rows = rows.concat(db.guests.filter((g) => g.date >= from && g.date <= to && match(emp(g.host_employee_id), g.guest_name)).map((g) => {
          const e = emp(g.host_employee_id);
          return { kind: 'guest', id: g.id, date: g.date, time: g.time, staff_number: e.staff_number, first_name: e.first_name, last_name: e.last_name, company: companyName(e), guest_name: g.guest_name, paying_company: g.paying_company, reason: g.reason, punch_checked: 1, source: g.source, cancelled_at: g.cancelled_at, cancelled_by: g.cancelled_by, cancel_comment: g.cancel_comment };
        }));
      }
      rows.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time) || b.id - a.id);
      return json({ ok: true, from, to, rows });
    }
    if (path === 'admin/bookings' && method === 'POST') {
      const comment = clean(body.comment);
      if (!comment) return bad('Bitte einen Kommentar angeben.');
      if (!isIso(body.date) || body.date > today()) return bad('Ungültiges Datum.');
      const e = emp(body.employeeId);
      if (!e) return bad('Mitarbeiter nicht gefunden.');
      if (hasBookingOn(e.id, body.date)) return bad('Für diesen Tag ist schon ein Essen gebucht.');
      addBooking(e.id, body.date, /^\d{2}:\d{2}$/.test(body.time || '') ? body.time : '12:00', true, 'admin', comment);
      audit(me.email, 'booking_added', { name: `${e.first_name} ${e.last_name}`, date: body.date, comment });
      save();
      return json({ ok: true });
    }
    let m = path.match(/^admin\/(bookings|guests)\/(\d+)\/cancel$/);
    if (m) {
      const comment = clean(body.comment);
      if (!comment) return bad('Bitte einen Kommentar angeben.');
      const row = db[m[1]].find((x) => x.id === Number(m[2]));
      if (!row || row.cancelled_at) return bad('Eintrag nicht gefunden oder bereits storniert.');
      Object.assign(row, { cancelled_at: nowTs(), cancelled_by: me.email, cancel_comment: comment });
      audit(me.email, m[1] === 'bookings' ? 'booking_cancelled' : 'guest_cancelled', { id: row.id, date: row.date, comment });
      save();
      return json({ ok: true });
    }
    if (path === 'admin/export.xlsx') {
      const from = isIso(query.get('from')) ? query.get('from') : pendingPeriod().from;
      const to = isIso(query.get('to')) ? query.get('to') : today();
      const { buffer, filename } = await buildWorkbook(from, to);
      audit(me.email, 'export_downloaded', { from, to }); save();
      return new Response(buffer, { status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${filename}"` } });
    }
    if (path === 'admin/send-now') {
      const { from, to } = pendingPeriod();
      if (from > to) return json({ ok: true, skipped: true, message: 'Seit dem letzten Versand gibt es keinen neuen abgeschlossenen Tag.' });
      const { counts } = await buildWorkbook(from, to);
      db.exports.push({ id: db.exports.length + 1, at: nowTs(), period_from: from, period_to: to, recipients: db.settings.recipients.join(', '), status: 'sent', error: null, trigger: 'manual' });
      db.settings.last_export_to = to;
      audit(me.email, 'export_sent', { from, to, ...counts, demo: 'keine echte Mail' });
      save();
      return json({ ok: true, from, to, counts });
    }
    if (path === 'admin/settings' && method === 'GET') {
      return json({ ok: true, settings: { ...db.settings, kiosk_url: new URL('../kiosk/', location.href).href, gastromatic_mode: 'mock' } });
    }
    if (path === 'admin/settings' && method === 'PUT') {
      const d = Number(body.send_day);
      if (body.send_day !== undefined && (!Number.isInteger(d) || d < 1 || d > 28)) return bad('Versandtag muss zwischen 1 und 28 liegen.');
      for (const k of ['send_day', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_from', 'gastromatic_client_id', 'retention_months', 'sounds_enabled']) if (body[k] !== undefined) db.settings[k] = clean(body[k]);
      for (const k of ['recipients', 'paying_companies', 'reasons']) if (Array.isArray(body[k])) db.settings[k] = [...new Set(body[k].map((x) => clean(x)).filter(Boolean))].filter((x) => k !== 'reasons' || x.toLowerCase() !== 'sonstiges');
      if (body.smtp_pass) db.settings.smtp_pass_set = true;
      if (body.gastromatic_client_secret) db.settings.gastromatic_client_secret_set = true;
      audit(me.email, 'settings_changed');
      save();
      return json({ ok: true });
    }
    if (path === 'admin/test-mail') return json({ ok: false, error: 'In der Demo werden keine Mails verschickt.' });
    if (path === 'admin/gastromatic/test') return json({ ok: true, organizations: db.companies.length, mock: true });
    if (path === 'admin/gastromatic/sync') {
      db.settings.last_sync_at = new Date().toISOString(); db.settings.last_sync_status = 'ok';
      audit(me.email, 'gastromatic_sync'); save();
      return json({ ok: true, companies: db.companies.length, employees: db.employees.length, withPin: db.employees.length });
    }
    if (path === 'admin/users' && method === 'GET') return json({ ok: true, rows: db.users.map(({ password, ...u }) => u), me: me.id });
    if (path === 'admin/users' && method === 'POST') {
      const email = clean(body.email, 200);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad('Ungültige E-Mail-Adresse.');
      if (String(body.password || '').length < 10) return bad('Das Passwort muss mindestens 10 Zeichen lang sein.');
      if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) return bad('Diese E-Mail ist schon angelegt.');
      db.users.push({ id: Math.max(...db.users.map((u) => u.id)) + 1, email, name: clean(body.name, 100), password: body.password, created_at: nowTs() });
      audit(me.email, 'user_created', { email }); save();
      return json({ ok: true });
    }
    m = path.match(/^admin\/users\/(\d+)$/);
    if (m && method === 'DELETE') {
      if (Number(m[1]) === me.id) return bad('Du kannst dich nicht selbst entfernen.');
      db.users = db.users.filter((u) => u.id !== Number(m[1])); save();
      return json({ ok: true });
    }
    if (path === 'admin/password') {
      if (body.current !== me.password) return bad('Aktuelles Passwort falsch.');
      if (String(body.next || '').length < 10) return bad('Das neue Passwort muss mindestens 10 Zeichen lang sein.');
      me.password = body.next; save();
      return json({ ok: true });
    }
    if (path === 'admin/audit') return json({ ok: true, rows: db.audit });
    if (path === 'admin/exports') return json({ ok: true, rows: [...db.exports].reverse() });
    return json({ ok: false, error: 'Nicht gefunden.' }, 404);
  }

  // ---------- fetch abfangen ----------
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const m = url.pathname.match(/\/api\/(.+)$/);
    if (!m) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
    try {
      return await handle(method, m[1], url.searchParams, body);
    } catch (err) {
      console.error('[demo]', err);
      return json({ ok: false, error: 'Fehler in der Demo.' }, 500);
    }
  };

  // ---------- Demo-Hinweis ----------
  document.addEventListener('DOMContentLoaded', () => {
    const isAdmin = /\/admin\//.test(location.pathname);
    const bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.append('DEMO · Testdaten nur in diesem Browser · ');
    const home = document.createElement('a'); home.href = '../'; home.textContent = 'Zur Demo-Startseite';
    bar.append(home);
    (isAdmin ? document.body.prepend(bar) : document.body.append(bar));
    if (isAdmin) {
      const email = document.getElementById('login-email');
      const pw = document.getElementById('login-password');
      if (email && pw) {
        email.value = DEMO_USER.email; pw.value = DEMO_USER.password;
        const hint = document.createElement('p');
        hint.className = 'small muted';
        hint.textContent = `Demo-Zugang: ${DEMO_USER.email} / ${DEMO_USER.password}`;
        pw.after(hint);
      }
    }
  });
})();
