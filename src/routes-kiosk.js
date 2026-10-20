'use strict';
const express = require('express');
const path = require('node:path');
const config = require('./config');
const { getSetting } = require('./db');
const { bookMeal, startGuestInvite, completeGuestInvite } = require('./booking');
const { KIOSK_COOKIE, cookie, kioskAuthorized, kioskCookieValue, requireKiosk } = require('./auth');
const { safeEqual } = require('./security');

const router = express.Router();
const publicDir = path.join(__dirname, '..', 'public');

// Tablet-Seite. Einmalige Freischaltung über ?key=...
router.get('/kiosk', (req, res) => {
  if (req.query.key) {
    if (!safeEqual(String(req.query.key), config.kioskKey)) return res.status(403).send('Falscher Freischalt-Schlüssel.');
    res.setHeader('Set-Cookie', cookie(KIOSK_COOKIE, kioskCookieValue(), 365 * 24 * 3600));
    return res.redirect('/kiosk');
  }
  if (!kioskAuthorized(req)) {
    return res.status(401).type('html').send(`<!doctype html><meta charset="utf-8"><title>Kantine</title>
      <body style="font-family:Arial,sans-serif;padding:48px;color:#1F2419"><h1>Tablet nicht freigeschaltet</h1>
      <p>Bitte öffne einmalig den Freischalt-Link aus dem Admin-Bereich (Settings → Tablet).</p></body>`);
  }
  res.sendFile(path.join(publicDir, 'kiosk', 'index.html'));
});

router.get('/api/kiosk/config', requireKiosk, (req, res) => {
  res.json({ sounds: getSetting('sounds_enabled') !== '0' });
});

router.post('/api/kiosk/meal', requireKiosk, async (req, res, next) => {
  try { res.json(await bookMeal(req.body?.pin)); } catch (err) { next(err); }
});

router.post('/api/kiosk/guest/start', requireKiosk, async (req, res, next) => {
  try { res.json(await startGuestInvite(req.body?.pin)); } catch (err) { next(err); }
});

router.post('/api/kiosk/guest/complete', requireKiosk, (req, res, next) => {
  try { res.json(completeGuestInvite(req.body || {})); } catch (err) { next(err); }
});

module.exports = router;
