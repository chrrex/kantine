'use strict';
/**
 * Lesender Zugriff auf die Gastromatic Public API (v1.8).
 * Es werden nur die Felder abgerufen, die die Kantine braucht (Datensparsamkeit).
 *
 * GASTROMATIC_MODE=mock liefert Testdaten, damit die App ohne API-Zugang läuft.
 */
const config = require('./config');
const { getSetting } = require('./db');

const EMPLOYEE_FIELDS = [
  'id', 'staff_number', 'first_name', 'last_name', 'terminal_id',
  'is_active', 'deactivation_date', 'leaveDate', 'organization',
].join(',');

const LIVE_TIMEOUT_MS = 5000;   // für den Abgleich
const PUNCH_TIMEOUT_MS = 3500;  // für die Live-Prüfung am Tablet: kurz halten

class GastromaticError extends Error {}

// ---------- Hilfsfunktionen ----------

/** Gastromatic liefert "DD.MM.YYYY HH:mm:ss" oder "YYYY-MM-DD HH:mm:ss" → "YYYY-MM-DD" */
function toIsoDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const idOf = (v) => (v && typeof v === 'object' ? v.id : v) || null;

// ---------- Live-Client ----------

let tokenCache = { token: null, expiresAt: 0 };

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    throw new GastromaticError(err.name === 'AbortError' ? 'Zeitüberschreitung bei Gastromatic' : `Gastromatic nicht erreichbar: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(timeoutMs) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const clientId = getSetting('gastromatic_client_id');
  const clientSecret = getSetting('gastromatic_client_secret');
  if (!clientId || !clientSecret) throw new GastromaticError('Gastromatic-Zugangsdaten fehlen (Settings).');

  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const res = await fetchWithTimeout(`${config.gastromaticBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, timeoutMs);
  if (!res.ok) throw new GastromaticError(`Anmeldung bei Gastromatic fehlgeschlagen (HTTP ${res.status}).`);
  const json = await res.json();
  // Die Doku nennt 1 Stunde Gültigkeit, das Beispiel ein Jahr: wir erneuern spätestens nach 50 Minuten.
  const ttl = Math.min(Number(json.expires_in) || 3600, 3600) - 600;
  tokenCache = { token: json.access_token, expiresAt: Date.now() + ttl * 1000 };
  return tokenCache.token;
}

async function apiGet(pathname, params, timeoutMs = LIVE_TIMEOUT_MS) {
  const token = await getToken(timeoutMs);
  const url = new URL(`/v1${pathname}`, config.gastromaticBaseUrl);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, timeoutMs);
  if (res.status === 401 || res.status === 403) {
    tokenCache = { token: null, expiresAt: 0 };
    throw new GastromaticError(`Kein Zugriff auf ${pathname} (HTTP ${res.status}). Scopes in Gastromatic prüfen.`);
  }
  if (!res.ok) throw new GastromaticError(`Gastromatic-Fehler bei ${pathname} (HTTP ${res.status}).`);
  return res.json();
}

/** Alle Seiten einer Collection laden (Cursor über ?after=ID). */
async function apiGetAll(pathname, params) {
  const all = [];
  let after;
  for (let page = 0; page < 1000; page++) {
    const json = await apiGet(pathname, { ...params, after });
    const results = Array.isArray(json) ? json : json.results || [];
    all.push(...results);
    const next = Array.isArray(json) ? null : json.after;
    if (!results.length || !next || next === after) break;
    after = next;
  }
  return all;
}

const live = {
  async fetchCompaniesAndEmployees() {
    const orgs = await apiGetAll('/organizations/', { fields: 'id,name' });
    const companies = orgs.map((o) => ({ id: o.id, name: o.name || o.id }));
    const employees = [];
    for (const org of companies) {
      const list = await apiGetAll(`/organizations/${encodeURIComponent(org.id)}/employees/`, { fields: EMPLOYEE_FIELDS });
      for (const e of list) {
        employees.push({
          id: e.id,
          staffNumber: e.staff_number || '',
          firstName: e.first_name || '',
          lastName: e.last_name || '',
          companyId: idOf(e.organization) || org.id,
          pin: e.terminal_id ? String(e.terminal_id).trim() : '',
          isActive: e.is_active === true || e.is_active === 'true' || e.is_active === 1,
          deactivationDate: toIsoDate(e.deactivation_date),
          leaveDate: toIsoDate(e.leaveDate),
        });
      }
    }
    return { companies, employees };
  },

  /**
   * War die Person heute eingestempelt?
   * true / false, oder null wenn Gastromatic nicht erreichbar war.
   * Geprüft werden offene Stempelzeiten (punch_times) und bestätigte Zeiten (actual_times).
   */
  async wasPunchedIn(employeeId, isoDate) {
    try {
      const params = { employee: employeeId, start: isoDate, end: isoDate, fields: 'id,deleted' };
      const punch = await apiGet('/punch_times/', params, PUNCH_TIMEOUT_MS);
      const p = (punch.results || []).filter((r) => !r.deleted);
      if (p.length) return true;
      const actual = await apiGet('/actual_times/', { employee: employeeId, start: isoDate, end: isoDate, fields: 'id' }, PUNCH_TIMEOUT_MS);
      return (actual.results || []).length > 0;
    } catch (err) {
      console.warn('[gastromatic] Stempelprüfung nicht möglich:', err.message);
      return null;
    }
  },

  async testConnection() {
    tokenCache = { token: null, expiresAt: 0 };
    const orgs = await apiGet('/organizations/', { fields: 'id,name' });
    return { organizations: (orgs.results || []).length };
  },
};

// ---------- Testdaten ----------
// Pins: 1111–3333 normal, 4444 inaktiv, 5555 nicht eingestempelt, 6666 Gastromatic "offline", 7777 ausgeschieden
const MOCK_COMPANIES = [
  { id: 'org-sgl', name: 'Schloss & Gut Liebenberg' },
  { id: 'org-gut', name: 'Gutsbetrieb Liebenberg' },
];
const MOCK_EMPLOYEES = [
  { id: 'emp-1', staffNumber: '1001', firstName: 'Anna', lastName: 'Becker', companyId: 'org-sgl', pin: '1111', isActive: true, punched: true },
  { id: 'emp-2', staffNumber: '1002', firstName: 'Ben', lastName: 'Schulz', companyId: 'org-sgl', pin: '2222', isActive: true, punched: true },
  { id: 'emp-3', staffNumber: '2001', firstName: 'Clara', lastName: 'Wagner', companyId: 'org-gut', pin: '3333', isActive: true, punched: true },
  { id: 'emp-4', staffNumber: '1003', firstName: 'David', lastName: 'Klein', companyId: 'org-sgl', pin: '4444', isActive: false, punched: true },
  { id: 'emp-5', staffNumber: '2002', firstName: 'Emma', lastName: 'Hoffmann', companyId: 'org-gut', pin: '5555', isActive: true, punched: false },
  { id: 'emp-6', staffNumber: '1004', firstName: 'Felix', lastName: 'Richter', companyId: 'org-sgl', pin: '6666', isActive: true, punched: 'offline' },
  { id: 'emp-7', staffNumber: '1005', firstName: 'Greta', lastName: 'Neumann', companyId: 'org-sgl', pin: '7777', isActive: true, leaveDate: '2026-01-31', punched: true },
];

const mock = {
  async fetchCompaniesAndEmployees() {
    return {
      companies: MOCK_COMPANIES,
      employees: MOCK_EMPLOYEES.map(({ punched, ...e }) => ({ deactivationDate: null, leaveDate: null, ...e })),
    };
  },
  async wasPunchedIn(employeeId) {
    const e = MOCK_EMPLOYEES.find((x) => x.id === employeeId);
    if (!e || e.punched === 'offline') return null;
    return e.punched;
  },
  async testConnection() {
    return { organizations: MOCK_COMPANIES.length, mock: true };
  },
};

const client = config.gastromaticMode === 'live' ? live : mock;

module.exports = { ...client, isMock: client === mock, GastromaticError, toIsoDate };
