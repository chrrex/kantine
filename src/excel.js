'use strict';
/** Excel-Datei für HR / Steuerbüro: ein Blatt pro Gesellschaft, ein Blatt für Gäste. */
const ExcelJS = require('exceljs');
const { db } = require('./db');
const { formatDe, nowParts } = require('./time');

const GREEN = 'FF6B7A3E';

function sheetName(name, used) {
  let base = String(name || 'Ohne Gesellschaft').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Gesellschaft';
  let candidate = base;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${base.slice(0, 27)} (${i})`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
  row.alignment = { vertical: 'middle' };
  row.height = 20;
}

function loadBookings(from, to) {
  return db.prepare(`SELECT b.date, b.time, b.punch_checked, b.source, e.id AS employee_id, e.staff_number,
        e.first_name, e.last_name, COALESCE(c.name, 'Ohne Gesellschaft') AS company
      FROM bookings b
      JOIN employees e ON e.id = b.employee_id
      LEFT JOIN companies c ON c.id = e.company_id
      WHERE b.cancelled_at IS NULL AND b.date BETWEEN ? AND ?
      ORDER BY company, e.last_name, e.first_name, b.date, b.time`).all(from, to);
}

function loadGuests(from, to) {
  return db.prepare(`SELECT g.date, g.time, g.paying_company, g.guest_name, g.reason,
        e.staff_number, e.first_name, e.last_name
      FROM guests g JOIN employees e ON e.id = g.host_employee_id
      WHERE g.cancelled_at IS NULL AND g.date BETWEEN ? AND ?
      ORDER BY g.date, g.time, g.paying_company`).all(from, to);
}

async function buildWorkbook(from, to) {
  const bookings = loadBookings(from, to);
  const guests = loadGuests(from, to);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kantinen-App Schloss & Gut Liebenberg';
  wb.created = new Date();
  const used = new Set();

  // Übersicht
  const byCompany = new Map();
  for (const b of bookings) {
    if (!byCompany.has(b.company)) byCompany.set(b.company, []);
    byCompany.get(b.company).push(b);
  }
  const overview = wb.addWorksheet(sheetName('Übersicht', used));
  overview.columns = [{ width: 36 }, { width: 18 }];
  overview.addRow(['Mitarbeiteressen Kantine']).font = { bold: true, size: 14 };
  overview.addRow(['Zeitraum', `${formatDe(from)} – ${formatDe(to)}`]);
  overview.addRow(['Erstellt am', `${formatDe(nowParts().date)} ${nowParts().time} Uhr`]);
  overview.addRow([]);
  styleHeader(overview.addRow(['Gesellschaft', 'Anzahl Essen']));
  for (const [company, rows] of [...byCompany.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
    overview.addRow([company, rows.length]);
  }
  overview.addRow(['Summe Mitarbeiteressen', bookings.length]).font = { bold: true };
  overview.addRow(['Gästeessen', guests.length]).font = { bold: true };

  // Ein Blatt pro Gesellschaft
  for (const [company, rows] of [...byCompany.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
    const ws = wb.addWorksheet(sheetName(company, used));
    ws.columns = [
      { header: 'Personalnr.', key: 'staff', width: 14 },
      { header: 'Nachname', key: 'last', width: 22 },
      { header: 'Vorname', key: 'first', width: 18 },
      { header: 'Datum', key: 'date', width: 13 },
      { header: 'Uhrzeit', key: 'time', width: 10 },
      { header: 'Vermerk', key: 'note', width: 30 },
    ];
    styleHeader(ws.getRow(1));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) {
      const notes = [];
      if (!r.punch_checked) notes.push('Stempelung nicht geprüft');
      if (r.source === 'admin') notes.push('nachgetragen');
      ws.addRow({ staff: r.staff_number, last: r.last_name, first: r.first_name, date: formatDe(r.date), time: r.time, note: notes.join(', ') });
    }

    // Summe pro Person
    ws.addRow([]);
    ws.addRow([]);
    styleHeader(ws.addRow(['Personalnr.', 'Nachname', 'Vorname', 'Anzahl Essen']));
    const perPerson = new Map();
    for (const r of rows) {
      const p = perPerson.get(r.employee_id) || { staff: r.staff_number, last: r.last_name, first: r.first_name, count: 0 };
      p.count += 1;
      perPerson.set(r.employee_id, p);
    }
    for (const p of [...perPerson.values()].sort((a, b) => a.last.localeCompare(b.last, 'de') || a.first.localeCompare(b.first, 'de'))) {
      ws.addRow([p.staff, p.last, p.first, p.count]);
    }
    ws.addRow(['', 'Summe', '', rows.length]).font = { bold: true };
  }

  // Gäste
  const gs = wb.addWorksheet(sheetName('Gäste', used));
  gs.columns = [
    { header: 'Datum', key: 'date', width: 13 },
    { header: 'Uhrzeit', key: 'time', width: 10 },
    { header: 'Einladende Person', key: 'host', width: 26 },
    { header: 'Personalnr.', key: 'staff', width: 14 },
    { header: 'Zahlende Firma', key: 'company', width: 30 },
    { header: 'Gast', key: 'guest', width: 26 },
    { header: 'Grund', key: 'reason', width: 36 },
  ];
  styleHeader(gs.getRow(1));
  gs.views = [{ state: 'frozen', ySplit: 1 }];
  for (const g of guests) {
    gs.addRow({
      date: formatDe(g.date), time: g.time, host: `${g.last_name}, ${g.first_name}`, staff: g.staff_number,
      company: g.paying_company, guest: g.guest_name, reason: g.reason,
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(buffer),
    filename: `Kantine_${from}_bis_${to}.xlsx`,
    counts: { bookings: bookings.length, guests: guests.length },
  };
}

module.exports = { buildWorkbook };
