'use strict';
/**
 * iPad-Version ohne Server: ersetzt alle Aufrufe an /api/... durch Logik im Browser.
 *
 * - Mitarbeiterliste kommt per Datei-Import (Excel oder CSV, z. B. aus einem Netzwerkordner
 *   über die Dateien-App). Pins werden nur als Hash gespeichert.
 * - Buchungen liegen in der Browser-Datenbank (IndexedDB) dieses iPads.
 * - Die Excel-Datei für HR wird per Knopfdruck erstellt und über das Teilen-Menü
 *   gespeichert (z. B. im Netzwerkordner) oder per Mail verschickt.
 * - Keine Gastromatic-Anbindung, keine Prüfung der Stempelung.
 */
(() => {
  window.KANTINE_LOCAL = true;
  const TZ = 'Europe/Berlin';
  const IDB_NAME = 'kantine-ipad';
  const IDB_STORE = 'state';
  const LS_FALLBACK = 'kantine-ipad-state';
  const SESSION_KEY = 'kantine-ipad-session';
  const SESSION_MS = 30 * 60 * 1000;
  const scriptBase = document.currentScript.src.replace(/[^/]+$/, '');
  const realFetch = window.fetch.bind(window);

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
  const clean = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  // ---------- Krypto ----------
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
  async function sha256(text) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
  async function pbkdf2(secret, salt) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 150000 }, key, 256));
  }
  const pinHash = (pin) => sha256(`${db.salt}:${String(pin).trim()}`);

  // ---------- Speicher ----------
  function emptyState() {
    return {
      version: 1,
      salt: randomHex(16),
      employees: [], companies: [], bookings: [], guests: [], nextId: 1, nextGuestId: 1,
      settings: {
        send_day: '1',
        paying_companies: ['Schloss & Gut Liebenberg', 'DKB STIFTUNG'],
        reasons: ['Bewerbungsgespräch', 'Geschäftspartner', 'Probearbeiten'],
        retention_months: '12', sounds_enabled: '1', privacy_text: '',
        last_import_at: '', last_import_file: '', last_cleanup: '',
      },
      admin: null, // { hash, salt, recoveryHash }
      exports: [], audit: [],
    };
  }

  function openIdb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('no idb'));
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  let idbPromise = null;
  const idb = () => (idbPromise ||= openIdb().catch(() => null));
  async function readState() {
    const handle = await idb();
    if (handle) {
      const value = await new Promise((resolve) => {
        const r = handle.transaction(IDB_STORE).objectStore(IDB_STORE).get('db');
        r.onsuccess = () => resolve(r.result || null); r.onerror = () => resolve(null);
      });
      if (value) return value;
    }
    try { return JSON.parse(localStorage.getItem(LS_FALLBACK)); } catch { return null; }
  }
  async function writeState(state) {
    const handle = await idb();
    if (handle) {
      await new Promise((resolve, reject) => {
        const tx = handle.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(state, 'db');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      return;
    }
    localStorage.setItem(LS_FALLBACK, JSON.stringify(state));
  }

  let db = null;
  // Alle Zugriffe nacheinander, damit Tablet und Verwaltung sich nie überschreiben
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  async function load() {
    db = (await readState()) || emptyState();
    const base = emptyState();
    db.settings = { ...base.settings, ...db.settings };
    for (const k of ['employees', 'companies', 'bookings', 'guests', 'exports', 'audit']) db[k] ||= [];
    cleanupIfDue();
  }
  const save = () => writeState(db);

  // Browser bitten, die Daten nicht automatisch zu löschen
  const persistPromise = (navigator.storage && navigator.storage.persist) ? navigator.storage.persist().catch(() => false) : Promise.resolve(false);

  // Offline-Fähigkeit: alle Dateien der App im Gerät zwischenspeichern
  // Updates nur auf Knopfdruck (siehe sw.js). Ändert sich ausnahmsweise sw.js selbst, meldet „kantine-update-ready“ den Neustart.
  const APP_VERSION = '__APP_VERSION__';
    if ('serviceWorker' in navigator && window.isSecureContext) {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; } // allererste Installation, kein Update
      window.dispatchEvent(new Event('kantine-update-ready'));
    });
    navigator.serviceWorker.register(`${scriptBase}../sw.js`, { scope: `${scriptBase}../` })
      .catch(() => {});
  }

  const audit = (actor, action, details) => {
    db.audit.unshift({ id: (db.audit[0]?.id || 0) + 1, at: nowTs(), actor, action, details: details ? JSON.stringify(details) : null });
    db.audit = db.audit.slice(0, 1000);
  };
  const emp = (id) => db.employees.find((e) => e.id === id) || { id, staff_number: '', first_name: '?', last_name: '?', company_id: '' };
  const companyName = (e) => db.companies.find((c) => c.id === e.company_id)?.name || 'Ohne Gesellschaft';

  // ---------- Löschfrist ----------
  function cleanupIfDue() {
    const t = today();
    if (db.settings.last_cleanup === t) return;
    const months = Math.max(1, Number(db.settings.retention_months) || 12);
    const cutoff = addMonths(t, -months);
    const before = db.bookings.length + db.guests.length;
    db.bookings = db.bookings.filter((b) => b.date >= cutoff);
    db.guests = db.guests.filter((g) => g.date >= cutoff);
    const used = new Set([...db.bookings.map((b) => b.employee_id), ...db.guests.map((g) => g.host_employee_id)]);
    db.employees = db.employees.filter((e) => e.is_active || used.has(e.id));
    db.audit = db.audit.filter((a) => a.at.slice(0, 10) >= cutoff);
    db.exports = db.exports.filter((x) => x.at.slice(0, 10) >= cutoff);
    const removed = before - db.bookings.length - db.guests.length;
    db.settings.last_cleanup = t;
    if (removed) audit('system', 'cleanup', { removed, before: cutoff });
    save();
  }

  // ---------- Tablet-Logik ----------
  const lock = { fails: 0, until: 0 };
  const guestSessions = new Map();
  const isActiveOn = (e) => !!e.is_active;
  const hasBookingOn = (id, d) => db.bookings.some((b) => b.employee_id === id && b.date === d && !b.cancelled_at);
  const fail = (code, extra) => ({ ok: false, code, ...extra });

  async function verifyPin(pin, requireNotBooked) {
    if (lock.until > Date.now()) return fail('locked', { seconds: Math.ceil((lock.until - Date.now()) / 1000) });
    const hash = await pinHash(pin);
    const e = db.employees.filter((x) => x.pin_hash === hash).sort((a, b) => b.is_active - a.is_active)[0];
    if (!e) { if (++lock.fails >= 5) { lock.until = Date.now() + 60000; lock.fails = 0; } return fail('pin_unknown'); }
    lock.fails = 0;
    if (!isActiveOn(e)) return fail('inactive');
    const alreadyBooked = hasBookingOn(e.id, today());
    if (requireNotBooked && alreadyBooked) return fail('already_booked', { firstName: e.first_name });
    return { ok: true, employee: e, alreadyBooked };
  }
  function addBooking(employeeId, date, time, source = 'kiosk', comment = null) {
    db.bookings.push({ id: db.nextId++, employee_id: employeeId, date, time, punch_checked: 1, source, comment, cancelled_at: null });
  }

  // ---------- Excel ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.ExcelJS) return resolve();
      const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Excel-Modul konnte nicht geladen werden.')); document.head.append(s);
    });
  }
  async function excel() { await loadScript(`${scriptBase}exceljs.min.js`); return window.ExcelJS; }
  const header = (row) => { row.font = { bold: true, color: { argb: 'FFFFFFFF' } }; row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B7A3E' } }; };

  async function buildWorkbook(from, to) {
    const ExcelJS = await excel();
    const rows = db.bookings.filter((b) => !b.cancelled_at && b.date >= from && b.date <= to).map((b) => ({ ...b, e: emp(b.employee_id) }));
    const guests = db.guests.filter((g) => !g.cancelled_at && g.date >= from && g.date <= to).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kantine Liebenberg';
    const byCompany = new Map();
    for (const r of rows) { const c = companyName(r.e); if (!byCompany.has(c)) byCompany.set(c, []); byCompany.get(c).push(r); }
    const sorted = [...byCompany.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'));

    const ov = wb.addWorksheet('Übersicht');
    ov.columns = [{ width: 36 }, { width: 18 }];
    ov.addRow(['Mitarbeiteressen Kantine']).font = { bold: true, size: 14 };
    ov.addRow(['Zeitraum', `${formatDe(from)} – ${formatDe(to)}`]);
    ov.addRow(['Erstellt am', `${formatDe(today())} ${nowParts().time} Uhr`]);
    ov.addRow(['Erfassung', 'iPad in der Kantine (ohne Gastromatic-Abgleich)']);
    ov.addRow([]);
    header(ov.addRow(['Gesellschaft', 'Anzahl Essen']));
    for (const [c, list] of sorted) ov.addRow([c, list.length]);
    ov.addRow(['Summe Mitarbeiteressen', rows.length]).font = { bold: true };
    ov.addRow(['Gästeessen', guests.length]).font = { bold: true };

    const used = new Set(['Übersicht', 'Gäste']);
    for (const [c, list] of sorted) {
      let name = c.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
      for (let i = 2; used.has(name); i++) name = `${name.slice(0, 28)} ${i}`;
      used.add(name);
      const ws = wb.addWorksheet(name);
      ws.columns = [{ header: 'Personalnr.', width: 14 }, { header: 'Nachname', width: 22 }, { header: 'Vorname', width: 18 }, { header: 'Datum', width: 13 }, { header: 'Uhrzeit', width: 10 }, { header: 'Vermerk', width: 34 }];
      header(ws.getRow(1));
      list.sort((a, b) => a.e.last_name.localeCompare(b.e.last_name, 'de') || (a.date + a.time).localeCompare(b.date + b.time));
      for (const r of list) ws.addRow([r.e.staff_number, r.e.last_name, r.e.first_name, formatDe(r.date), r.time, r.source === 'admin' ? `nachgetragen: ${r.comment || ''}` : '']);
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

  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const monthStart = () => `${today().slice(0, 8)}01`;
  function monthRange(m) {
    const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
    const to = `${m}-${String(last).padStart(2, '0')}`;
    return { from: `${m}-01`, to: to > today() ? today() : to };
  }
  const active = (x) => !x.cancelled_at;
  /** Letzter Export genau dieses Monats („Alle Daten“ zählt nicht als Monatsabrechnung). */
  const lastExportOf = (m) => db.exports.filter((x) => x.month === m).map((x) => x.at).sort().pop() || null;
  /** Monate mit Buchungen, neuester zuerst. */
  function monthList() {
    const map = new Map();
    const bump = (d, k) => { const m = d.slice(0, 7); const r = map.get(m) || { month: m, meals: 0, guests: 0 }; r[k]++; map.set(m, r); };
    db.bookings.filter(active).forEach((b) => bump(b.date, 'meals'));
    db.guests.filter(active).forEach((g) => bump(g.date, 'guests'));
    const rows = [...map.values()].sort((a, b) => b.month.localeCompare(a.month))
      .map((r) => ({ ...r, label: monthLabel(r.month), current: r.month === today().slice(0, 7), lastExport: lastExportOf(r.month) }));
    const all = db.exports.filter((x) => x.month === 'all').map((x) => x.at).sort().pop() || null;
    return { rows, total: { meals: rows.reduce((n, r) => n + r.meals, 0), guests: rows.reduce((n, r) => n + r.guests, 0), lastExport: all } };
  }
  /** Fällig: ab dem eingestellten Tag, wenn der Vormonat Buchungen hat und noch nicht exportiert ist. */
  function exportStatus() {
    const t = today();
    const day = String(Math.min(Number(db.settings.send_day) || 1, 28)).padStart(2, '0');
    const thisMonth = `${t.slice(0, 8)}${day}`;
    const prev = addMonths(`${t.slice(0, 8)}01`, -1).slice(0, 7);
    const hasData = db.bookings.some((b) => active(b) && b.date.startsWith(prev)) || db.guests.some((g) => active(g) && g.date.startsWith(prev));
    const due = hasData && t >= thisMonth && !lastExportOf(prev);
    const next = due || t < thisMonth ? thisMonth : `${addMonths(`${t.slice(0, 8)}01`, 1).slice(0, 8)}${day}`;
    return { due, next, month: prev, label: monthLabel(prev) };
  }

  // ---------- Import ----------
  const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const COLUMNS = {
    staff_number: ['personalnummer', 'personalnr', 'persnr', 'pnr', 'mitarbeiternummer', 'mitarbeiternr', 'nummer', 'nr', 'id', 'staffnumber'],
    first_name: ['vorname', 'firstname'],
    last_name: ['nachname', 'name', 'familienname', 'lastname'],
    company: ['gesellschaft', 'firma', 'unternehmen', 'company', 'organisation', 'betrieb'],
    pin: ['pin', 'terminalpin', 'terminalcode', 'stempelpin', 'pincode', 'code'],
    active: ['aktiv', 'status', 'active'],
  };
  function mapHeader(cells) {
    const map = {};
    cells.forEach((c, i) => {
      const n = norm(c);
      for (const [key, names] of Object.entries(COLUMNS)) if (map[key] === undefined && names.includes(n)) map[key] = i;
    });
    return map;
  }
  function parseCsv(text) {
    const first = text.split(/\r?\n/)[0] || '';
    const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
      if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim()));
  }
  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { return new TextDecoder('windows-1252').decode(buf); }
  }
  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map((r) => r.text).join('');
      if (v.text !== undefined) return String(v.text);
      if (v.result !== undefined) return String(v.result);
      if (v instanceof Date) return v.toISOString().slice(0, 10);
    }
    return String(v);
  }
  async function readTable(file) {
    const buf = await file.arrayBuffer();
    const isXlsx = /\.xlsx$/i.test(file.name) || new Uint8Array(buf.slice(0, 2)).join() === '80,75';
    if (!isXlsx) {
      if (/\.xls$/i.test(file.name)) throw new Error('Das alte Excel-Format .xls wird nicht unterstützt. Bitte in Excel als .xlsx oder .csv speichern.');
      return parseCsv(decodeText(buf));
    }
    const ExcelJS = await excel();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    // Das erste Blatt mit erkennbarer Kopfzeile nehmen
    for (const ws of wb.worksheets) {
      const rows = [];
      ws.eachRow({ includeEmpty: false }, (r) => { const vals = []; r.eachCell({ includeEmpty: true }, (c, col) => { vals[col - 1] = cellText(c.value); }); rows.push(Array.from(vals, (x) => x ?? '')); });
      if (rows.slice(0, 10).some((r) => { const m = mapHeader(r); return m.pin !== undefined && m.last_name !== undefined; })) return rows;
    }
    const ws = wb.worksheets[0];
    const rows = [];
    ws?.eachRow({ includeEmpty: false }, (r) => { const vals = []; r.eachCell({ includeEmpty: true }, (c, col) => { vals[col - 1] = cellText(c.value); }); rows.push(Array.from(vals, (x) => x ?? '')); });
    return rows;
  }
  const truthy = (v) => { const n = norm(v); if (!n) return true; return !['0', 'nein', 'no', 'false', 'inaktiv', 'ausgetreten', 'deaktiviert', 'n'].includes(n); };

  const key = (r) => (r.staff_number ? `nr:${r.staff_number}` : `name:${norm(r.last_name)}|${norm(r.first_name)}|${norm(r.company)}`);

  /** Liest die Datei und prüft sie. Ohne apply wird nichts gespeichert (Vorschau). */
  async function importEmployees(file, apply) {
    const rows = await readTable(file);
    let headerIdx = rows.slice(0, 10).findIndex((r) => { const m = mapHeader(r); return m.pin !== undefined && m.last_name !== undefined; });
    if (headerIdx < 0) throw new Error('Keine passende Kopfzeile gefunden. Benötigt werden mindestens die Spalten „Nachname“ und „PIN“, empfohlen außerdem „Personalnummer“, „Vorname“ und „Gesellschaft“.');
    const map = mapHeader(rows[headerIdx]);
    const get = (r, k) => (map[k] === undefined ? '' : clean(r[map[k]], 120));
    const errors = []; const warnings = []; const list = [];
    rows.slice(headerIdx + 1).forEach((r, i) => {
      const line = headerIdx + i + 2;
      const rec = { staff_number: get(r, 'staff_number'), first_name: get(r, 'first_name'), last_name: get(r, 'last_name'), company: get(r, 'company'), pin: get(r, 'pin').replace(/\s/g, ''), active: map.active === undefined ? true : truthy(r[map.active]), line };
      if (!rec.last_name && !rec.first_name && !rec.pin) return;
      if (/^\d+\.0$/.test(rec.pin)) rec.pin = rec.pin.slice(0, -2);
      if (/^\d+\.0$/.test(rec.staff_number)) rec.staff_number = rec.staff_number.slice(0, -2);
      if (!rec.last_name) { errors.push(`Zeile ${line}: Nachname fehlt.`); return; }
      if (rec.pin && !/^\d{3,10}$/.test(rec.pin)) { errors.push(`Zeile ${line} (${rec.first_name} ${rec.last_name}): PIN „${rec.pin}“ ist ungültig – nur Ziffern, 3 bis 10 Stellen.`); return; }
      if (!rec.pin && rec.active) warnings.push(`Zeile ${line} (${rec.first_name} ${rec.last_name}): keine PIN – kann am Tablet nicht buchen.`);
      if (!rec.company) rec.company = 'Ohne Gesellschaft';
      list.push(rec);
    });
    if (!list.length) errors.push('Die Datei enthält keine Mitarbeitenden.');
    const seenKey = new Map(); const seenPin = new Map();
    for (const r of list) {
      const k = key(r);
      if (seenKey.has(k)) errors.push(`Zeile ${r.line}: ${r.staff_number ? `Personalnummer ${r.staff_number}` : `${r.first_name} ${r.last_name}`} kommt doppelt vor (auch Zeile ${seenKey.get(k)}).`);
      else seenKey.set(k, r.line);
      if (r.pin && r.active) {
        if (seenPin.has(r.pin)) errors.push(`Zeile ${r.line}: PIN von ${r.first_name} ${r.last_name} ist identisch mit Zeile ${seenPin.get(r.pin)}. Jede PIN darf nur einmal vergeben sein.`);
        else seenPin.set(r.pin, r.line);
      }
    }
    if (map.staff_number === undefined && list.length) warnings.push('Keine Spalte „Personalnummer“ gefunden – Personen werden über Name und Gesellschaft zugeordnet.');

    const existing = new Map(db.employees.map((e) => [e.key, e]));
    const incoming = new Set(list.map(key));
    const summary = {
      total: list.length,
      active: list.filter((r) => r.active).length,
      withPin: list.filter((r) => r.pin && r.active).length,
      added: list.filter((r) => !existing.has(key(r))).length,
      deactivated: db.employees.filter((e) => e.is_active && !incoming.has(e.key)).length,
      companies: [...new Set(list.map((r) => r.company))].sort((a, b) => a.localeCompare(b, 'de')),
      columns: Object.keys(map),
    };
    if (!apply || errors.length) return { ok: errors.length === 0, errors, warnings, summary, applied: false };

    // Übernehmen: neue Liste ersetzt die alte; wer fehlt, wird inaktiv (Buchungen bleiben erhalten)
    const companies = new Map(db.companies.map((c) => [c.name, c]));
    for (const name of summary.companies) if (!companies.has(name)) companies.set(name, { id: `c-${randomHex(6)}`, name });
    db.companies = [...companies.values()];
    for (const e of db.employees) if (!incoming.has(e.key)) { e.is_active = 0; e.pin_hash = null; }
    for (const r of list) {
      const k = key(r);
      let e = existing.get(k);
      if (!e) { e = { id: `e-${randomHex(8)}`, key: k }; db.employees.push(e); }
      Object.assign(e, {
        staff_number: r.staff_number, first_name: r.first_name, last_name: r.last_name,
        company_id: companies.get(r.company).id, is_active: r.active ? 1 : 0,
        pin_hash: r.pin && r.active ? await pinHash(r.pin) : null, deleted: false,
      });
    }
    db.settings.last_import_at = new Date().toISOString();
    db.settings.last_import_file = clean(file.name, 120);
    audit('Admin', 'employees_imported', { file: file.name, total: summary.total, active: summary.active, added: summary.added, deactivated: summary.deactivated });
    await save();
    return { ok: true, errors, warnings, summary, applied: true };
  }

  /** Einzelne Person von Hand anlegen (oder eine gesperrte/gelöschte Person wieder aktivieren). */
  async function addEmployee(input) {
    const r = {
      staff_number: clean(input.staff_number, 30), first_name: clean(input.first_name, 60), last_name: clean(input.last_name, 60),
      company: clean(input.company, 80) || 'Ohne Gesellschaft', pin: String(input.pin ?? '').replace(/\s/g, ''),
    };
    if (!r.last_name) throw new Error('Bitte einen Nachnamen eingeben.');
    if (!r.first_name) throw new Error('Bitte einen Vornamen eingeben.');
    if (!/^\d{3,10}$/.test(r.pin)) throw new Error('Die PIN braucht 3 bis 10 Ziffern.');
    const k = key(r);
    let e = db.employees.find((x) => x.key === k);
    if (e && e.is_active && !e.deleted) throw new Error(r.staff_number ? `Personalnummer ${r.staff_number} ist schon vergeben (${e.first_name} ${e.last_name}).` : `${r.first_name} ${r.last_name} ist schon in der Liste.`);
    const hash = await pinHash(r.pin);
    const clash = db.employees.find((x) => x !== e && x.is_active && x.pin_hash === hash);
    if (clash) throw new Error(`Diese PIN ist schon an ${clash.first_name} ${clash.last_name} vergeben. Jede PIN darf nur einmal vorkommen.`);
    let c = db.companies.find((x) => x.name.toLowerCase() === r.company.toLowerCase());
    if (!c) { c = { id: `c-${randomHex(6)}`, name: r.company }; db.companies.push(c); }
    const revived = !!e;
    if (!e) { e = { id: `e-${randomHex(8)}`, key: k }; db.employees.push(e); }
    Object.assign(e, { staff_number: r.staff_number, first_name: r.first_name, last_name: r.last_name, company_id: c.id, is_active: 1, pin_hash: hash, deleted: false, manual: true });
    audit('Admin', 'employee_added', { name: `${r.first_name} ${r.last_name}`, nr: r.staff_number, company: c.name, wieder_aktiviert: revived || undefined });
    await save();
    return { name: `${r.first_name} ${r.last_name}`, revived };
  }

  /** Person löschen. Hat sie noch Buchungen, bleibt nur der Name für die Abrechnung erhalten,
      bis die Buchungen nach der Löschfrist verschwinden. */
  async function deleteEmployee(id) {
    const e = db.employees.find((x) => x.id === id);
    if (!e) throw new Error('Person nicht gefunden.');
    const used = db.bookings.some((b) => b.employee_id === id) || db.guests.some((g) => g.host_employee_id === id);
    if (used) Object.assign(e, { is_active: 0, pin_hash: null, deleted: true });
    else db.employees = db.employees.filter((x) => x.id !== id);
    audit('Admin', 'employee_deleted', { name: `${e.first_name} ${e.last_name}`, nr: e.staff_number, buchungen_bleiben: used || undefined });
    await save();
    return { keptForBookings: used };
  }

  async function templateFile() {
    const ExcelJS = await excel();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Mitarbeitende');
    ws.columns = [{ header: 'Personalnummer', width: 16 }, { header: 'Vorname', width: 18 }, { header: 'Nachname', width: 22 }, { header: 'Gesellschaft', width: 30 }, { header: 'PIN', width: 10 }, { header: 'Aktiv', width: 8 }];
    header(ws.getRow(1));
    ws.getColumn(1).numFmt = '@'; ws.getColumn(5).numFmt = '@';
    ws.addRow(['1001', 'Max', 'Mustermann', 'Schloss & Gut Liebenberg', '4711', 'ja']);
    ws.addRow(['1002', 'Erika', 'Musterfrau', 'Gutsbetrieb', '0815', 'ja']);
    const info = wb.addWorksheet('Hinweise');
    info.getColumn(1).width = 100;
    [
      'So füllst du die Liste aus',
      '',
      'Eine Zeile pro Person. Die erste Zeile mit den Spaltennamen bitte nicht ändern.',
      'PIN: die Terminal-PIN aus Gastromatic, nur Ziffern. Jede PIN darf nur einmal vorkommen.',
      'PIN-Spalte als Text formatieren, damit führende Nullen erhalten bleiben (z. B. 0815).',
      'Aktiv: „ja“ oder leer = darf buchen, „nein“ = gesperrt. Wer in der Liste fehlt, wird ebenfalls gesperrt.',
      'Gesellschaft: so, wie sie später im Excel für HR als Blatt erscheinen soll.',
      'Die Datei enthält PINs im Klartext: nach dem Import im Netzwerkordner nur für HR zugänglich ablegen oder löschen.',
    ].forEach((t, i) => { const r = info.addRow([t]); if (i === 0) r.font = { bold: true, size: 13 }; });
    return new File([await wb.xlsx.writeBuffer()], 'Kantine_Mitarbeiterliste_Vorlage.xlsx', { type: XLSX_TYPE });
  }

  // ---------- Admin-Sitzung ----------
  const session = {
    valid() { try { return Number(sessionStorage.getItem(SESSION_KEY)) > Date.now(); } catch { return false; } },
    touch() { try { sessionStorage.setItem(SESSION_KEY, String(Date.now() + SESSION_MS)); } catch { /* egal */ } },
    end() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* egal */ } },
  };
  const adminLock = { fails: 0, until: 0 };
  const ADMIN_USER = { email: 'Admin', name: 'Admin' };
  const validAdminPin = (p) => /^\d{6,12}$/.test(String(p || ''));
  function recoveryCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const s = [...bytes].map((b) => abc[b % abc.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
  }
  async function setAdminPin(pin) {
    const salt = randomHex(16);
    const code = recoveryCode();
    db.admin = { salt, hash: await pbkdf2(String(pin), salt), recoveryHash: await pbkdf2(code.replace(/-/g, ''), salt) };
    return code;
  }

  // ---------- API ----------
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const bad = (error) => json({ ok: false, error }, 400);

  async function handle(method, path, query, body) {
    await load();
    // Tablet
    if (path === 'kiosk/config') {
      return json({ sounds: db.settings.sounds_enabled !== '0', local: true, employees: db.employees.filter((e) => e.is_active && e.pin_hash).length, exportDue: exportStatus().due });
    }
    if (path === 'kiosk/ping') return json({ ok: true });
    if (path === 'kiosk/offline-sync') return json({ ok: true, results: [] });
    if (path === 'kiosk/meal') {
      const c = await verifyPin(body.pin, true);
      if (!c.ok) return json(c);
      const { date, time } = nowParts();
      addBooking(c.employee.id, date, time);
      await save();
      return json({ ok: true, firstName: c.employee.first_name, time, punchChecked: true });
    }
    if (path === 'kiosk/guest/start') {
      const c = await verifyPin(body.pin, false);
      if (!c.ok) return json(c);
      const token = randomHex(12);
      guestSessions.set(token, { employeeId: c.employee.id, at: Date.now() });
      return json({ ok: true, token, host: { firstName: c.employee.first_name, lastName: c.employee.last_name }, alreadyBooked: c.alreadyBooked, payingCompanies: db.settings.paying_companies, reasons: db.settings.reasons });
    }
    if (path === 'kiosk/guest/complete') {
      const s = guestSessions.get(body.token);
      if (!s || Date.now() - s.at > 10 * 60 * 1000) return json(fail('session_expired'));
      const company = clean(body.payingCompany);
      if (!db.settings.paying_companies.includes(company)) return json(fail('invalid', { field: 'payingCompany' }));
      let reason = clean(body.reason);
      if (reason === 'Sonstiges') { reason = clean(body.reasonOther, 200); if (!reason) return json(fail('invalid')); } else if (!db.settings.reasons.includes(reason)) return json(fail('invalid'));
      const names = (body.guests || []).map((g) => clean(g)).filter(Boolean).slice(0, 30);
      if (!names.length) return json(fail('invalid'));
      const { date, time } = nowParts();
      for (const n of names) db.guests.push({ id: db.nextGuestId++, host_employee_id: s.employeeId, date, time, paying_company: company, guest_name: n, reason, source: 'kiosk', cancelled_at: null });
      let selfBooked = false;
      if (body.includeSelf && !hasBookingOn(s.employeeId, date)) { addBooking(s.employeeId, date, time); selfBooked = true; }
      guestSessions.delete(body.token);
      await save();
      return json({ ok: true, firstName: emp(s.employeeId).first_name, guestCount: names.length, selfBooked, payingCompany: company, reason, guests: names });
    }

    if (path === 'privacy') {
      if (db.settings.privacy_text) return json({ ok: true, text: db.settings.privacy_text, custom: true });
      const res = await realFetch(`${scriptBase}../shared/privacy-default.txt`);
      return json({ ok: true, text: await res.text(), custom: false });
    }

    // Anmeldung mit Admin-PIN (beim ersten Mal wird sie festgelegt)
    if (path === 'admin/login') {
      if (adminLock.until > Date.now()) return json({ ok: false, error: `Zu viele Fehlversuche. Bitte ${Math.ceil((adminLock.until - Date.now()) / 1000)} Sekunden warten.` }, 401);
      const pin = String(body.password || '').trim();
      if (!db.admin) {
        if (!validAdminPin(pin)) return json({ ok: false, error: 'Bitte eine Admin-PIN mit 6 bis 12 Ziffern festlegen.' }, 401);
        const code = await setAdminPin(pin);
        audit('Admin', 'admin_pin_set'); await save();
        session.touch();
        setTimeout(() => window.dispatchEvent(new CustomEvent('kantine-recovery', { detail: code })), 0);
        return json({ ok: true, user: ADMIN_USER, recoveryCode: code });
      }
      if ((await pbkdf2(pin, db.admin.salt)) !== db.admin.hash) {
        if (++adminLock.fails >= 5) { adminLock.until = Date.now() + 5 * 60000; adminLock.fails = 0; }
        return json({ ok: false, error: 'Admin-PIN falsch.' }, 401);
      }
      adminLock.fails = 0;
      session.touch(); audit('Admin', 'login'); await save();
      return json({ ok: true, user: ADMIN_USER });
    }
    if (path === 'local/info') {
      return json({ ok: true, adminSet: !!db.admin, employees: db.employees.filter((e) => e.is_active && e.pin_hash).length, exportDue: exportStatus().due });
    }
    if (path === 'local/recover') {
      if (!db.admin) return bad('Es ist noch keine Admin-PIN festgelegt.');
      if (adminLock.until > Date.now()) return bad('Zu viele Fehlversuche. Bitte später erneut versuchen.');
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if ((await pbkdf2(code, db.admin.salt)) !== db.admin.recoveryHash) {
        if (++adminLock.fails >= 5) { adminLock.until = Date.now() + 5 * 60000; adminLock.fails = 0; }
        return bad('Wiederherstellungscode falsch.');
      }
      if (!validAdminPin(body.pin)) return bad('Die neue Admin-PIN braucht 6 bis 12 Ziffern.');
      const next = await setAdminPin(body.pin);
      audit('Admin', 'admin_pin_recovered'); await save();
      session.touch();
      setTimeout(() => window.dispatchEvent(new CustomEvent('kantine-recovery', { detail: next })), 0);
      return json({ ok: true, user: ADMIN_USER, recoveryCode: next });
    }
    if (path === 'admin/logout') { session.end(); return json({ ok: true }); }
    if (path === 'admin/me') return json(session.valid() ? (session.touch(), { ok: true, user: ADMIN_USER }) : { ok: false });
    if (path.startsWith('admin/') || path.startsWith('local/')) {
      if (!session.valid()) return json({ ok: false, error: 'Bitte anmelden.' }, 401);
      session.touch();
    }
    const me = ADMIN_USER;

    if (path === 'admin/status') {
      const from = monthStart();
      const t = today();
      const inRange = (x) => !x.cancelled_at && x.date >= from && x.date <= t;
      const ex = exportStatus();
      return json({
        ok: true, periodFrom: from, meals: db.bookings.filter(inRange).length, guests: db.guests.filter(inRange).length,
        sync: { at: db.settings.last_import_at, status: 'ok', error: '' },
        lastExport: db.exports[db.exports.length - 1] || null, nextSend: ex.next, exportDue: ex.due, dueLabel: ex.label, mock: false,
        employees: db.employees.filter((e) => e.is_active && e.pin_hash).length, importFile: db.settings.last_import_file,
        persisted: await persistPromise,
      });
    }
    if (path === 'admin/companies') return json({ ok: true, rows: [...db.companies].sort((a, b) => a.name.localeCompare(b.name, 'de')) });
    if (path === 'admin/employees') {
      const q = clean(query.get('q')).toLowerCase();
      const rows = db.employees.filter((e) => !e.deleted && `${e.first_name} ${e.last_name} ${e.last_name} ${e.first_name} ${e.staff_number}`.toLowerCase().includes(q))
        .sort((a, b) => b.is_active - a.is_active || a.last_name.localeCompare(b.last_name, 'de'))
        .map((e) => ({ id: e.id, staff_number: e.staff_number, first_name: e.first_name, last_name: e.last_name, is_active: e.is_active, has_pin: !!e.pin_hash, company: companyName(e) }));
      return json({ ok: true, rows });
    }
    if (path === 'admin/bookings' && method === 'GET') {
      const from = isIso(query.get('from')) ? query.get('from') : monthStart();
      const to = isIso(query.get('to')) ? query.get('to') : today();
      const type = query.get('type') || 'all';
      const company = query.get('company') || '';
      const q = clean(query.get('q')).toLowerCase();
      const match = (e, extra = '') => (!company || e.company_id === company) && (!q || `${e.first_name} ${e.last_name} ${e.last_name} ${e.first_name} ${e.staff_number} ${extra}`.toLowerCase().includes(q));
      let rows = [];
      if (type !== 'guest') {
        rows = rows.concat(db.bookings.filter((b) => b.date >= from && b.date <= to && match(emp(b.employee_id))).map((b) => {
          const e = emp(b.employee_id);
          return { kind: 'meal', id: b.id, date: b.date, time: b.time, staff_number: e.staff_number, first_name: e.first_name, last_name: e.last_name, company: companyName(e), punch_checked: 1, source: b.source, comment: b.comment, cancelled_at: b.cancelled_at, cancelled_by: b.cancelled_by, cancel_comment: b.cancel_comment };
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
    if (path === 'admin/offline-rejected') return json({ ok: true, rows: [] });
    if (path === 'admin/bookings' && method === 'POST') {
      const comment = clean(body.comment);
      if (!comment) return bad('Bitte einen Kommentar angeben.');
      if (!isIso(body.date) || body.date > today()) return bad('Ungültiges Datum.');
      const e = db.employees.find((x) => x.id === body.employeeId);
      if (!e) return bad('Mitarbeiter nicht gefunden.');
      if (hasBookingOn(e.id, body.date)) return bad('Für diesen Tag ist schon ein Essen gebucht.');
      addBooking(e.id, body.date, /^\d{2}:\d{2}$/.test(body.time || '') ? body.time : '12:00', 'admin', comment);
      audit(me.email, 'booking_added', { name: `${e.first_name} ${e.last_name}`, date: body.date, comment });
      await save();
      return json({ ok: true });
    }
    const m = path.match(/^admin\/(bookings|guests)\/(\d+)\/cancel$/);
    if (m) {
      const comment = clean(body.comment);
      if (!comment) return bad('Bitte einen Kommentar angeben.');
      const row = db[m[1]].find((x) => x.id === Number(m[2]));
      if (!row || row.cancelled_at) return bad('Eintrag nicht gefunden oder bereits storniert.');
      Object.assign(row, { cancelled_at: nowTs(), cancelled_by: me.email, cancel_comment: comment });
      audit(me.email, m[1] === 'bookings' ? 'booking_cancelled' : 'guest_cancelled', { id: row.id, date: row.date, comment });
      await save();
      return json({ ok: true });
    }
    if (path === 'admin/export.xlsx') {
      const from = isIso(query.get('from')) ? query.get('from') : monthStart();
      const to = isIso(query.get('to')) ? query.get('to') : today();
      const { buffer, filename } = await buildWorkbook(from, to);
      audit(me.email, 'export_downloaded', { from, to }); await save();
      return new Response(buffer, { status: 200, headers: { 'Content-Type': XLSX_TYPE, 'Content-Disposition': `attachment; filename="${filename}"` } });
    }
    if (path === 'admin/settings' && method === 'GET') {
      return json({ ok: true, settings: { smtp_host: '', smtp_port: '', smtp_user: '', smtp_from: '', smtp_pass_set: false, gastromatic_client_id: '', gastromatic_client_secret_set: false, recipients: [], ...db.settings, kiosk_url: new URL('../kiosk/', scriptBase).href, gastromatic_mode: 'local' } });
    }
    if (path === 'admin/settings' && method === 'PUT') {
      const d = Number(body.send_day);
      if (body.send_day !== undefined && (!Number.isInteger(d) || d < 1 || d > 28)) return bad('Der Tag muss zwischen 1 und 28 liegen.');
      const r = Number(body.retention_months);
      if (body.retention_months !== undefined && (!Number.isInteger(r) || r < 1 || r > 120)) return bad('Löschfrist: 1 bis 120 Monate.');
      for (const k of ['send_day', 'retention_months', 'sounds_enabled']) if (body[k] !== undefined) db.settings[k] = clean(body[k]);
      for (const k of ['paying_companies', 'reasons']) if (Array.isArray(body[k])) db.settings[k] = [...new Set(body[k].map((x) => clean(x)).filter(Boolean))].filter((x) => k !== 'reasons' || x.toLowerCase() !== 'sonstiges');
      db.settings.last_cleanup = '';
      audit(me.email, 'settings_changed');
      await save();
      return json({ ok: true });
    }
    if (path === 'admin/privacy' && method === 'PUT') {
      const t = String(body.text ?? '');
      if (!t.trim()) return bad('Der Text darf nicht leer sein.');
      if (t.length > 20000) return bad('Der Text ist zu lang (max. 20000 Zeichen).');
      db.settings.privacy_text = t; audit(me.email, 'privacy_changed'); await save();
      return json({ ok: true });
    }
    if (path === 'admin/privacy' && method === 'DELETE') {
      db.settings.privacy_text = ''; audit(me.email, 'privacy_reset'); await save();
      return json({ ok: true });
    }
    if (path === 'admin/users' && method === 'GET') return json({ ok: true, rows: [], me: 0 });
    if (path === 'admin/audit') return json({ ok: true, rows: db.audit });
    if (path === 'admin/exports') return json({ ok: true, rows: [...db.exports].reverse() });
    if (['admin/test-mail', 'admin/send-now', 'admin/gastromatic/test', 'admin/gastromatic/sync', 'admin/users', 'admin/password'].includes(path)) {
      return bad('In der iPad-Version nicht verfügbar.');
    }
    return json({ ok: false, error: 'Nicht gefunden.' }, 404);
  }

  function swCall(msg) {
    return new Promise((resolve, reject) => {
      const ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!ctl) return reject(new Error('Der Offline-Speicher ist noch nicht eingerichtet. Bitte die App einmal schließen und neu öffnen.'));
      const ch = new MessageChannel();
      const timer = setTimeout(() => reject(new Error('Keine Antwort – ist das iPad mit dem Internet verbunden?')), 90000);
      ch.port1.onmessage = (e) => {
        clearTimeout(timer);
        if (e.data.ok) resolve(e.data);
        else reject(new Error(/fetch|network|load/i.test(e.data.error) ? 'Keine Verbindung zum Internet – Update-Suche nicht möglich.' : e.data.error));
      };
      ctl.postMessage(msg, [ch.port2]);
    });
  }

  // ---------- Direkte Funktionen für die Verwaltung (Dateien) ----------
  const guard = async () => { await load(); if (!session.valid()) throw new Error('Bitte erneut anmelden.'); session.touch(); };
  window.kantineLocal = {
    months: () => serial(async () => { await guard(); return monthList(); }),
    previewImport: (file) => serial(async () => { await guard(); return importEmployees(file, false); }),
    applyImport: (file) => serial(async () => { await guard(); return importEmployees(file, true); }),
    template: () => serial(async () => { await guard(); return templateFile(); }),
    addEmployee: (data) => serial(async () => { await guard(); return addEmployee(data); }),
    deleteEmployee: (id) => serial(async () => { await guard(); return deleteEmployee(id); }),
    /** Erstellt das Excel für einen Monat ('YYYY-MM') oder für alle gespeicherten Daten ('all'). */
    buildExport: (key) => serial(async () => {
      await guard();
      let from; let to; let name;
      if (key === 'all') {
        from = [...db.bookings, ...db.guests].filter(active).map((x) => x.date).sort()[0];
        to = today();
        if (!from) return { empty: true, message: 'Es sind keine Buchungen gespeichert.' };
        name = `Kantine_alle_Daten_bis_${to}.xlsx`;
      } else {
        if (!/^\d{4}-\d{2}$/.test(String(key))) throw new Error('Ungültiger Monat.');
        ({ from, to } = monthRange(key));
        name = `Kantine_${key}${key === today().slice(0, 7) ? `_Stand_${to}` : ''}.xlsx`;
      }
      const { buffer, counts } = await buildWorkbook(from, to);
      return { key, from, to, counts, file: new File([buffer], name, { type: XLSX_TYPE }) };
    }),
    markExported: (key, from, to, counts, how) => serial(async () => {
      await guard();
      db.exports.push({ id: (db.exports[db.exports.length - 1]?.id || 0) + 1, at: nowTs(), month: key, period_from: from, period_to: to, recipients: how, status: 'sent', error: null, trigger: 'manual' });
      audit('Admin', 'export_sent', { zeitraum: key === 'all' ? 'alle Daten' : monthLabel(key), from, to, ...counts, how });
      await save();
    }),
    backup: () => serial(async () => {
      await guard();
      audit('Admin', 'backup_created'); await save();
      const data = JSON.stringify({ app: 'kantine-ipad', created: new Date().toISOString(), state: db });
      return new File([data], `Kantine_Sicherung_${today()}.json`, { type: 'application/json' });
    }),
    restore: (file) => serial(async () => {
      await guard();
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch { throw new Error('Die Datei ist keine gültige Sicherung.'); }
      if (parsed?.app !== 'kantine-ipad' || !parsed.state?.employees || !parsed.state?.salt) throw new Error('Die Datei ist keine Sicherung der Kantinen-App.');
      db = parsed.state;
      audit('Admin', 'backup_restored', { file: file.name, created: parsed.created });
      await save();
      session.end();
      return { created: parsed.created, bookings: db.bookings.length };
    }),
    changePin: (current, next) => serial(async () => {
      await guard();
      if ((await pbkdf2(String(current || ''), db.admin.salt)) !== db.admin.hash) throw new Error('Aktuelle Admin-PIN falsch.');
      if (!validAdminPin(next)) throw new Error('Die neue Admin-PIN braucht 6 bis 12 Ziffern.');
      const code = await setAdminPin(next);
      audit('Admin', 'admin_pin_changed'); await save();
      return code;
    }),
    persisted: () => persistPromise,
    version: APP_VERSION,
    /** Fragt die Update-Adresse nach der neuesten Version (installiert nichts). */
    checkUpdate: () => swCall({ type: 'check' }),
    /** Lädt die neueste Version vollständig herunter; danach Seite neu laden. */
    installUpdate: () => swCall({ type: 'install' }),
  };

  // ---------- fetch abfangen ----------
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const m = url.pathname.match(/\/api\/(.+)$/);
    if (!m) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
    return serial(async () => {
      try {
        return await handle(method, m[1], url.searchParams, body);
      } catch (err) {
        console.error('[kantine-ipad]', err);
        return json({ ok: false, error: `Interner Fehler: ${err.message || err}` }, 500);
      }
    });
  };
})();
