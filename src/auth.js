'use strict';
/** Anmeldung für den Admin-Bereich und Freischaltung des Kantinen-Tablets. */
const config = require('./config');
const { db, audit } = require('./db');
const { hashPassword, verifyPassword, randomToken, safeEqual } = require('./security');

const SESSION_MS = 8 * 60 * 60 * 1000;
const sessions = new Map(); // token -> { userId, email, name, expires }

const ADMIN_COOKIE = 'kantine_admin';
const KIOSK_COOKIE = 'kantine_kiosk';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAgeSec) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    config.cookieSecure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

// ---------- Erster Admin ----------
function ensureInitialAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
  if (count > 0) return;
  if (!config.initialAdminEmail || !config.initialAdminPassword) {
    console.warn('[auth] Noch kein Admin vorhanden. ADMIN_EMAIL und ADMIN_PASSWORD in .env setzen und neu starten.');
    return;
  }
  createUser(config.initialAdminEmail, 'Admin', config.initialAdminPassword);
  console.log(`[auth] Erster Admin angelegt: ${config.initialAdminEmail}`);
}

function createUser(email, name, password) {
  if (String(password).length < 10) throw new Error('Das Passwort muss mindestens 10 Zeichen lang sein.');
  return db.prepare('INSERT INTO admin_users(email, name, password_hash) VALUES (?, ?, ?)')
    .run(String(email).trim(), String(name || '').trim(), hashPassword(password));
}

// ---------- Login mit einfachem Schutz gegen Durchprobieren ----------
const loginFails = new Map(); // key -> { count, until }

function login(email, password, ip) {
  const key = `${String(email).toLowerCase()}|${ip}`;
  const f = loginFails.get(key);
  if (f && f.until > Date.now()) return { ok: false, error: 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.' };

  const user = db.prepare('SELECT * FROM admin_users WHERE email = ?').get(String(email || '').trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    const next = { count: (f?.count || 0) + 1, until: 0 };
    if (next.count >= 8) next.until = Date.now() + 15 * 60 * 1000;
    loginFails.set(key, next);
    return { ok: false, error: 'E-Mail oder Passwort falsch.' };
  }
  loginFails.delete(key);
  const token = randomToken();
  sessions.set(token, { userId: user.id, email: user.email, name: user.name, expires: Date.now() + SESSION_MS });
  audit(user.email, 'login');
  return { ok: true, token, user: { email: user.email, name: user.name } };
}

function logout(req) {
  const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
  if (token) sessions.delete(token);
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  // Gelöschte Benutzer verlieren sofort den Zugang
  if (!db.prepare('SELECT 1 FROM admin_users WHERE id = ?').get(s.userId)) { sessions.delete(token); return null; }
  s.expires = Date.now() + SESSION_MS;
  return s;
}

function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Bitte anmelden.' });
  req.user = user;
  next();
}

function dropSessionsOfUser(userId) {
  for (const [t, s] of sessions) if (s.userId === userId) sessions.delete(t);
}

// ---------- Tablet-Freischaltung ----------
// Das Tablet öffnet einmalig /kiosk?key=<KIOSK_KEY>; danach reicht das Cookie (1 Jahr).
const kioskCookieValue = () => require('node:crypto').createHmac('sha256', config.appSecret).update(`kiosk:${config.kioskKey}`).digest('base64url');

function kioskAuthorized(req) {
  const c = parseCookies(req.headers.cookie)[KIOSK_COOKIE];
  return !!c && safeEqual(c, kioskCookieValue());
}

function requireKiosk(req, res, next) {
  if (!kioskAuthorized(req)) return res.status(401).json({ ok: false, code: 'kiosk_not_authorized' });
  next();
}

module.exports = {
  ADMIN_COOKIE, KIOSK_COOKIE, cookie, ensureInitialAdmin, createUser, login, logout, currentUser,
  requireAdmin, dropSessionsOfUser, kioskAuthorized, kioskCookieValue, requireKiosk,
};
