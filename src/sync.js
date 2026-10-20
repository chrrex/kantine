'use strict';
/** Mitarbeiterliste aus Gastromatic in die lokale Datenbank übernehmen. */
const gastromatic = require('./gastromatic');
const { db, setSetting, transaction, audit } = require('./db');
const { hashPin } = require('./security');

let running = null;

async function syncEmployees(actor = 'system') {
  if (running) return running; // nicht doppelt laufen lassen
  running = (async () => {
    const startedAt = new Date().toISOString();
    try {
      const { companies, employees } = await gastromatic.fetchCompaniesAndEmployees();
      const seen = new Set();
      const upsertCompany = db.prepare(`INSERT INTO companies(id, name) VALUES(?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name`);
      const upsertEmployee = db.prepare(`INSERT INTO employees
          (id, staff_number, first_name, last_name, company_id, pin_hash, is_active, deactivation_date, leave_date, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET staff_number = excluded.staff_number, first_name = excluded.first_name,
          last_name = excluded.last_name, company_id = excluded.company_id, pin_hash = excluded.pin_hash,
          is_active = excluded.is_active, deactivation_date = excluded.deactivation_date,
          leave_date = excluded.leave_date, synced_at = excluded.synced_at`);

      let withPin = 0;
      transaction(() => {
        for (const c of companies) upsertCompany.run(c.id, c.name);
        for (const e of employees) {
          seen.add(e.id);
          if (e.pin) withPin++;
          upsertEmployee.run(
            e.id, e.staffNumber, e.firstName, e.lastName, e.companyId,
            e.pin ? hashPin(e.pin) : null, e.isActive ? 1 : 0,
            e.deactivationDate, e.leaveDate, startedAt,
          );
        }
        // Wer nicht mehr in Gastromatic auftaucht, wird gesperrt (nicht gelöscht: alte Buchungen bleiben gültig).
        const all = db.prepare('SELECT id FROM employees WHERE is_active = 1').all();
        const deactivate = db.prepare('UPDATE employees SET is_active = 0, synced_at = ? WHERE id = ?');
        for (const row of all) if (!seen.has(row.id)) deactivate.run(startedAt, row.id);
      });

      setSetting('last_sync_at', startedAt);
      setSetting('last_sync_status', 'ok');
      setSetting('last_sync_error', '');
      const summary = { companies: companies.length, employees: employees.length, withPin };
      if (actor !== 'system') audit(actor, 'gastromatic_sync', summary);
      return summary;
    } catch (err) {
      setSetting('last_sync_at', startedAt);
      setSetting('last_sync_status', 'error');
      setSetting('last_sync_error', err.message);
      throw err;
    } finally {
      running = null;
    }
  })();
  return running;
}

module.exports = { syncEmployees };
