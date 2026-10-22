'use strict';
(() => {
  const app = document.getElementById('app');
  const $ = (id) => document.getElementById(id);
  const screens = { pin: $('screen-pin'), result: $('screen-result'), guest: $('screen-guest'), privacy: $('screen-privacy') };

  const MAX_PIN = 12;
  const MIN_DOTS = 4;
  const SUCCESS_MS = 3000;
  const ERROR_MS = 4000;
  const GUEST_DONE_MS = 5000;
  const PIN_IDLE_MS = 20000;   // halb eingetippter Pin verfällt
  const FORM_IDLE_MS = 180000; // Gäste-Formular verfällt nach 3 Minuten ohne Eingabe
  const PRIVACY_IDLE_MS = 120000; // Datenschutzhinweise schließen nach 2 Minuten ohne Bedienung

  const state = { mode: 'meal', pin: '', busy: false, guest: null, timers: {} };

  const ERRORS = {
    pin_unknown: ['Pin nicht erkannt', 'Bitte erneut eingeben.'],
    inactive: ['Kein aktives Profil', 'Bitte wende dich an HR.'],
    already_booked: ['Schon gebucht', 'Dein Essen ist heute schon gebucht.'],
    not_punched: ['Nicht eingestempelt', 'Du bist heute nicht eingestempelt.'],
    locked: ['Kurz gesperrt', 'Zu viele falsche Versuche. Bitte warte einen Moment.'],
    session_expired: ['Zeit abgelaufen', 'Bitte starte die Einladung neu.'],
    invalid: ['Angaben unvollständig', 'Bitte prüfe das Formular.'],
    network: ['Keine Verbindung', 'Bitte versuche es gleich noch einmal.'],
    kiosk_not_authorized: ['Tablet nicht freigeschaltet', 'Bitte wende dich an HR.'],
    offline_guest: ['Keine WLAN-Verbindung', 'Gäste einladen geht nur mit Verbindung. Bitte später noch einmal versuchen.'],
    offline_unavailable: ['Keine WLAN-Verbindung', 'Buchen ist gerade nicht möglich. Bitte später noch einmal versuchen.'],
    offline_full: ['Speicher voll', 'Zu viele Buchungen ohne Verbindung. Bitte HR informieren.'],
  };

  // ---------- Töne (ohne Audiodateien) ----------
  let audioCtx = null;
  let soundsEnabled = true;
  function tone(freqs, type, duration) {
    if (!soundsEnabled) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      let t = audioCtx.currentTime;
      for (const f of freqs) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + duration + 0.02);
        t += duration * 0.85;
      }
    } catch { /* kein Ton möglich – egal */ }
  }
  const soundOk = () => tone([660, 880], 'sine', 0.16);
  const soundError = () => tone([220, 180], 'square', 0.22);

  // ---------- Hilfen ----------
  function clearTimer(name) { clearTimeout(state.timers[name]); delete state.timers[name]; }
  function setTimer(name, ms, fn) { clearTimer(name); state.timers[name] = setTimeout(fn, ms); }

  function show(name) {
    for (const [key, el] of Object.entries(screens)) {
      if (key === name) el.setAttribute('data-active', ''); else el.removeAttribute('data-active');
    }
  }

  const REQUEST_TIMEOUT_MS = 6000;
  class OfflineError extends Error {}

  async function request(path, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(path, { credentials: 'same-origin', ...options, signal: ctrl.signal });
    } catch {
      throw new OfflineError('offline');
    } finally {
      clearTimeout(timer);
    }
    if ([502, 503, 504].includes(res.status)) throw new OfflineError('offline');
    return res;
  }

  async function api(path, body) {
    const res = await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    setOnline(true);
    if (res.status === 401) return { ok: false, code: 'kiosk_not_authorized' };
    if (!res.ok && res.status >= 500) throw new Error('server');
    return res.json();
  }

  function setToday() {
    const d = new Date();
    $('today').textContent = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ---------- Pin-Eingabe ----------
  function renderDots() {
    const dots = $('dots');
    dots.replaceChildren();
    const count = Math.max(MIN_DOTS, state.pin.length);
    for (let i = 0; i < count; i++) {
      const d = document.createElement('span');
      d.className = 'dot' + (i < state.pin.length ? ' filled' : '');
      dots.append(d);
    }
    dots.setAttribute('aria-label', `${state.pin.length} Ziffern eingegeben`);
    document.querySelector('.key-ok').disabled = state.pin.length === 0 || state.busy;
  }

  function resetPin() { state.pin = ''; renderDots(); clearTimer('pinIdle'); }

  function addDigit(d) {
    if (state.busy || state.pin.length >= MAX_PIN) return;
    state.pin += d;
    renderDots();
    setTimer('pinIdle', PIN_IDLE_MS, resetPin);
  }

  function deleteDigit() {
    if (state.busy) return;
    state.pin = state.pin.slice(0, -1);
    renderDots();
  }

  function goHome() {
    for (const k of Object.keys(state.timers)) clearTimer(k);
    state.mode = 'meal';
    state.guest = null;
    state.busy = false;
    app.dataset.mode = 'meal';
    resetPin();
    setToday();
    show('pin');
  }

  function startGuestPin() {
    state.mode = 'guest';
    app.dataset.mode = 'guest';
    resetPin();
    show('pin');
  }

  async function submitPin() {
    if (state.busy || !state.pin) return;
    state.busy = true;
    renderDots();
    const pin = state.pin;
    try {
      const result = state.mode === 'meal'
        ? await api('/api/kiosk/meal', { pin })
        : await api('/api/kiosk/guest/start', { pin });
      if (!result.ok) return showError(result);
      if (state.mode === 'meal') {
        showSuccess(`Guten Appetit, ${result.firstName}!`, `Dein Mittagessen ist gebucht · ${result.time} Uhr`);
      } else {
        openGuestForm(result);
      }
    } catch (err) {
      if (err instanceof OfflineError) {
        setOnline(false);
        if (state.mode !== 'meal') showError({ code: 'offline_guest' });
        else await bookOffline(pin);
      } else {
        showError({ code: 'network' });
      }
    } finally {
      state.busy = false;
      resetPin();
    }
  }

  // ---------- Ergebnis ----------
  function startCountdown(ms) {
    const bar = $('countdown-bar');
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    void bar.offsetWidth;
    bar.style.transition = `transform ${ms}ms linear`;
    bar.style.transform = 'scaleX(0)';
    setTimer('result', ms, goHome);
  }

  function showSuccess(title, text, summary) {
    const el = screens.result;
    el.className = 'screen result ok';
    $('result-title').textContent = title;
    $('result-text').textContent = text;
    $('result-retry').hidden = true;
    const dl = $('result-summary');
    dl.replaceChildren();
    dl.hidden = !summary;
    for (const [k, v] of summary || []) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.append(dt, dd);
    }
    show('result');
    soundOk();
    startCountdown(summary ? GUEST_DONE_MS : SUCCESS_MS);
  }

  function showError(result) {
    const [title, text] = ERRORS[result.code] || ERRORS.network;
    const el = screens.result;
    el.className = 'screen result err';
    $('result-title').textContent = title;
    $('result-text').textContent = result.code === 'locked' && result.seconds
      ? `Zu viele falsche Versuche. Bitte warte ${result.seconds} Sekunden.`
      : text;
    $('result-summary').hidden = true;
    $('result-retry').hidden = false;
    show('result');
    soundError();
    startCountdown(ERROR_MS);
  }

  function showPending() {
    const el = screens.result;
    el.className = 'screen result pending';
    $('result-title').textContent = 'Gespeichert – wird nachgereicht';
    $('result-text').textContent = 'Keine WLAN-Verbindung. Deine Eingabe wird geprüft, sobald das Tablet wieder online ist.';
    $('result-summary').hidden = true;
    $('result-retry').hidden = true;
    show('result');
    tone([520], 'sine', 0.25);
    startCountdown(ERROR_MS);
  }

  // ---------- Offline-Modus ----------
  // Ohne WLAN wird die Pin-Eingabe mit dem öffentlichen Schlüssel des Servers verschlüsselt
  // und lokal gespeichert. Nur der Server kann sie lesen und prüft sie beim Nachreichen.
  const QUEUE_KEY = 'kantine-offline-queue';
  const KEY_KEY = 'kantine-offline-key';
  const MAX_QUEUE = 300;
  const PING_ONLINE_MS = 60000;
  const PING_OFFLINE_MS = 15000;
  let online = true;
  let flushing = false;

  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };
  const queue = () => store.get(QUEUE_KEY, []);
  const canQueue = () => !!(window.crypto && crypto.subtle && store.get(KEY_KEY, null));

  function b64ToBytes(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
  function bytesToB64(buf) { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); }
  function randomId() { return bytesToB64(crypto.getRandomValues(new Uint8Array(18))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c])); }

  async function encryptForServer(payload) {
    const key = await crypto.subtle.importKey('spki', b64ToBytes(store.get(KEY_KEY, '')), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const data = new TextEncoder().encode(JSON.stringify(payload));
    return bytesToB64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, data));
  }

  async function bookOffline(pin) {
    if (!canQueue()) return showError({ code: 'offline_unavailable' });
    const q = queue();
    if (q.length >= MAX_QUEUE) return showError({ code: 'offline_full' });
    try {
      const ts = new Date().toISOString();
      q.push({ id: randomId(), order: `${ts}-${String(q.length).padStart(4, '0')}`, enc: await encryptForServer({ pin, ts }) });
      if (!store.set(QUEUE_KEY, q)) return showError({ code: 'offline_full' });
    } catch {
      return showError({ code: 'offline_unavailable' });
    }
    renderOfflineBanner();
    showPending();
  }

  function renderOfflineBanner() {
    const n = queue().length;
    app.dataset.online = online ? 'true' : 'false';
    $('offline-count').textContent = n === 0 ? ''
      : n === 1 ? '1 Buchung wartet auf Übertragung.' : `${n} Buchungen warten auf Übertragung.`;
    $('offline-text').textContent = canQueue()
      ? 'Du kannst trotzdem buchen. Deine Eingabe wird gespeichert und im Nachgang geprüft, sobald das Tablet wieder online ist.'
      : 'Buchen ist gerade nicht möglich. Bitte später noch einmal versuchen.';
  }

  function setOnline(flag) {
    const changed = online !== flag;
    online = flag;
    renderOfflineBanner();
    if (changed) schedulePing();
    if (flag && queue().length) flushQueue();
  }

  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue().length) {
        const batch = queue().slice(0, 50);
        const res = await request('/api/kiosk/offline-sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: batch }),
        });
        if (!res.ok) break;
        const data = await res.json();
        const done = new Set((data.results || []).map((r) => r.id));
        store.set(QUEUE_KEY, queue().filter((x) => !done.has(x.id)));
        if (!done.size) break;
      }
    } catch (err) {
      if (err instanceof OfflineError) { online = false; schedulePing(); }
    } finally {
      flushing = false;
      renderOfflineBanner();
    }
  }

  async function ping() {
    try {
      const res = await request('/api/kiosk/ping', { method: 'GET' });
      setOnline(res.ok || res.status === 401);
    } catch {
      setOnline(false);
    }
  }

  function schedulePing() {
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(ping, online ? PING_ONLINE_MS : PING_OFFLINE_MS);
  }

  window.addEventListener('offline', () => setOnline(false));
  window.addEventListener('online', () => ping());

  // ---------- Gäste-Formular ----------
  function chip(label, group) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      for (const c of group.querySelectorAll('.chip')) c.setAttribute('aria-pressed', c === b ? 'true' : 'false');
      validateGuestForm();
    });
    return b;
  }

  function addGuestRow(focus) {
    const list = $('guest-list');
    const n = list.children.length + 1;
    const row = document.createElement('div');
    row.className = 'guest-row';
    const id = `guest-${Date.now()}-${n}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    const wrap = document.createElement('div');
    wrap.className = 'guest-row-input';
    const input = document.createElement('input');
    input.type = 'text'; input.id = id; input.maxLength = 120; input.autocomplete = 'off';
    input.addEventListener('input', validateGuestForm);
    wrap.append(input);
    if (n > 1) {
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'remove-guest';
      rm.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      rm.addEventListener('click', () => { row.remove(); relabelGuests(); validateGuestForm(); });
      wrap.append(rm);
    }
    row.append(label, wrap);
    list.append(row);
    relabelGuests();
    if (focus) input.focus();
  }

  function relabelGuests() {
    [...$('guest-list').children].forEach((row, i) => {
      row.querySelector('label').textContent = `Gast ${i + 1} · Vor- und Nachname`;
      const rm = row.querySelector('.remove-guest');
      if (rm) rm.setAttribute('aria-label', `Gast ${i + 1} entfernen`);
    });
  }

  const selected = (group) => group.querySelector('.chip[aria-pressed="true"]')?.textContent || '';
  const guestNames = () => [...$('guest-list').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);

  function validateGuestForm() {
    const reason = selected($('reason-chips'));
    $('reason-other-wrap').hidden = reason !== 'Sonstiges';
    const names = guestNames();
    const valid = selected($('company-chips')) && reason
      && (reason !== 'Sonstiges' || $('reason-other').value.trim()) && names.length > 0;
    $('guest-submit').disabled = !valid || state.busy;
    const self = $('self').checked && !$('self').disabled;
    const g = names.length === 1 ? '1 Gast' : `${names.length || ''} Gäste`.trim();
    $('guest-submit-label').textContent = names.length ? (self ? `${g} + mich buchen` : `${g} buchen`) : 'Buchen';
    setTimer('formIdle', FORM_IDLE_MS, goHome);
  }

  function openGuestForm(data) {
    state.guest = data;
    $('host-name').textContent = `${data.host.firstName} ${data.host.lastName}`.trim();

    const companies = $('company-chips');
    companies.replaceChildren(...data.payingCompanies.map((c) => chip(c, companies)));
    if (!data.payingCompanies.length) {
      const p = document.createElement('p'); p.className = 'empty-hint';
      p.textContent = 'Noch keine Firmen hinterlegt – bitte HR informieren.';
      companies.append(p);
    }
    if (data.payingCompanies.length === 1) companies.firstChild.setAttribute('aria-pressed', 'true');

    const reasons = $('reason-chips');
    reasons.replaceChildren(...[...data.reasons, 'Sonstiges'].map((r) => chip(r, reasons)));
    $('reason-other').value = '';

    $('guest-list').replaceChildren();
    addGuestRow(false);

    const self = $('self');
    const wrap = $('self-wrap');
    self.disabled = data.alreadyBooked;
    self.checked = !data.alreadyBooked;
    wrap.classList.toggle('disabled', data.alreadyBooked);
    $('self-hint').textContent = data.alreadyBooked
      ? 'Dein Essen ist heute schon gebucht'
      : 'Antippen zum Abwählen, falls du heute nicht mitisst';

    show('guest');
    validateGuestForm();
  }

  async function submitGuests() {
    if (state.busy || !state.guest) return;
    state.busy = true;
    $('guest-submit').disabled = true;
    try {
      const result = await api('/api/kiosk/guest/complete', {
        token: state.guest.token,
        payingCompany: selected($('company-chips')),
        reason: selected($('reason-chips')),
        reasonOther: $('reason-other').value,
        guests: guestNames(),
        includeSelf: $('self').checked && !$('self').disabled,
      });
      if (!result.ok) {
        state.busy = false;
        if (result.code === 'invalid') { validateGuestForm(); soundError(); return; }
        return showError(result);
      }
      const n = result.guestCount;
      const title = n === 1 ? '1 Gast gebucht' : `${n} Gäste gebucht`;
      const text = result.selfBooked
        ? `plus dein eigenes Essen · Guten Appetit, ${result.firstName}!`
        : `Danke, ${result.firstName}!`;
      showSuccess(title, text, [
        ['Zahlende Firma', result.payingCompany],
        ['Grund', result.reason],
        ['Gäste', result.guests.join(', ')],
      ]);
    } catch {
      showError({ code: 'network' });
    } finally {
      state.busy = false;
    }
  }

  // ---------- Datenschutzhinweise ----------
  let privacyLoaded = false;
  async function openPrivacy() {
    if (state.busy) return;
    resetPin();
    show('privacy');
    $('privacy-scroll').scrollTop = 0;
    setTimer('privacyIdle', PRIVACY_IDLE_MS, goHome);
    if (privacyLoaded) return;
    try {
      const res = await fetch('/api/privacy', { credentials: 'same-origin' });
      const data = await res.json();
      window.renderPrivacy(data.text, $('privacy-body'));
      privacyLoaded = true;
      setTimeout(() => { privacyLoaded = false; }, 10 * 60 * 1000); // Änderungen aus dem Admin spätestens nach 10 Minuten
    } catch {
      $('privacy-body').textContent = 'Die Datenschutzhinweise konnten nicht geladen werden. Bitte wende dich an HR.';
    }
  }
  $('privacy-scroll').addEventListener('scroll', () => setTimer('privacyIdle', PRIVACY_IDLE_MS, goHome), { passive: true });

  // ---------- Ereignisse ----------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.digit) return addDigit(t.dataset.digit);
    switch (t.dataset.action) {
      case 'delete': return deleteDigit();
      case 'submit': return submitPin();
      case 'guest': return online ? startGuestPin() : showError({ code: 'offline_guest' });
      case 'cancel': return goHome();
      case 'home': return goHome();
      case 'privacy': return openPrivacy();
      case 'privacy-close': return goHome();
      case 'add-guest': return addGuestRow(true);
      case 'submit-guests': return submitGuests();
      default:
    }
  });
  $('self').addEventListener('change', validateGuestForm);
  $('reason-other').addEventListener('input', validateGuestForm);
  $('guest-form').addEventListener('submit', (e) => e.preventDefault());

  // Physische Tastatur (z. B. am PC zum Testen)
  document.addEventListener('keydown', (e) => {
    if (!screens.pin.hasAttribute('data-active')) return;
    if (/^\d$/.test(e.key)) addDigit(e.key);
    else if (e.key === 'Backspace') deleteDigit();
    else if (e.key === 'Enter') submitPin();
    else if (e.key === 'Escape') goHome();
  });

  async function loadConfig() {
    try {
      const res = await request('/api/kiosk/config', { method: 'GET' });
      if (!res.ok) return;
      const cfg = await res.json();
      soundsEnabled = cfg.sounds !== false;
      if (cfg.offlineKey) store.set(KEY_KEY, cfg.offlineKey);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }
  loadConfig();
  schedulePing();

  // Tablet-Seite auch ohne WLAN starten können (nicht in der Klick-Demo)
  if ('serviceWorker' in navigator && window.isSecureContext && !window.KANTINE_DEMO) {
    navigator.serviceWorker.register('/kiosk-sw.js', { scope: '/kiosk' }).catch(() => {});
  }

  setInterval(setToday, 60 * 1000);
  goHome();
})();
