'use strict';
const path = require('node:path');
const express = require('express');
const config = require('./src/config');
require('./src/db');
const { ensureInitialAdmin } = require('./src/auth');
const { startScheduler } = require('./src/scheduler');
const gastromatic = require('./src/gastromatic');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

// Sicherheits-Header: keine fremden Skripte, keine Einbettung in fremde Seiten
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '50kb' }));

// API-Antworten nie zwischenspeichern
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const publicDir = path.join(__dirname, 'public');
app.use('/shared', express.static(path.join(publicDir, 'shared'), { maxAge: '7d' }));
app.use('/kiosk', express.static(path.join(publicDir, 'kiosk'), { index: false, redirect: false }));
app.use(require('./src/routes-kiosk'));
app.use(require('./src/routes-admin'));
app.use('/admin', express.static(path.join(publicDir, 'admin')));
app.get('/', (req, res) => res.redirect('/admin/'));

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Nicht gefunden.' }));

// Fehler nie mit Details an den Browser geben
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Ungültige Anfrage.' });
  console.error('[error]', err);
  res.status(500).json({ ok: false, error: 'Interner Fehler.' });
});

ensureInitialAdmin();
if (process.env.NODE_ENV !== 'test') startScheduler();

const server = app.listen(config.port, () => {
  console.log(`Kantinen-App läuft auf http://localhost:${config.port} (Gastromatic: ${gastromatic.isMock ? 'Testdaten' : 'live'})`);
});

module.exports = { app, server };
