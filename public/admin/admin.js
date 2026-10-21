'use strict';
(() => {
  const $ = (id) => document.getElementById(id);

  /** Element bauen, Texte immer als textContent (kein HTML aus Daten). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (res.status === 401 && !path.endsWith('/login')) { showLogin(); throw new Error('Bitte anmelden.'); }
    const data = await res.json().catch(() => ({ ok: false, error: 'Unerwartete Antwort.' }));
    return data;
  }

  const de = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
  const deShort = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : '');
  const dateTimeDe = (isoTs) => {
    if (!isoTs) return '';
    const d = new Date(isoTs.includes('T') ? isoTs : `${isoTs.replace(' ', 'T')}Z`);
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // ---------- Login ----------
  function showLogin() {
    $('view-app').hidden = true;
    $('view-login').hidden = false;
    $('login-email').focus();
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').hidden = true;
    const r = await api('/api/admin/login', { method: 'POST', body: { email: $('login-email').value, password: $('login-password').value } });
    if (!r.ok) { $('login-error').textContent = r.error; $('login-error').hidden = false; return; }
    $('login-password').value = '';
    startApp(r.user);
  });

  $('logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    showLogin();
  });

  // ---------- Navigation ----------
  const tabs = ['buchungen', 'settings', 'protokoll'];
  function route() {
    const tab = tabs.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'buchungen';
    for (const t of tabs) {
      $(`tab-${t}`).hidden = t !== tab;
      document.querySelector(`[data-tab="${t}"]`).toggleAttribute('aria-current', t === tab);
      if (t === tab) document.querySelector(`[data-tab="${t}"]`).setAttribute('aria-current', 'page');
    }
    if (tab === 'buchungen') loadBookingsTab();
    if (tab === 'settings') loadSettings();
    if (tab === 'protokoll') loadAudit();
  }
  window.addEventListener('hashchange', route);

  function startApp(user) {
    $('me').textContent = user.name || user.email;
    $('view-login').hidden = true;
    $('view-app').hidden = false;
    route();
  }

  // ---------- Buchungen ----------
  let companiesLoaded = false;
  let filtersInitialised = false;

  async function loadStatus() {
    const s = await api('/api/admin/status');
    if (!s.ok) return;
    $('mock-banner').hidden = !s.mock;
    $('st-meals').textContent = s.meals;
    $('st-guests').textContent = `seit ${de(s.periodFrom)} · ${s.guests} Gästeessen`;
    const sync = $('st-sync');
    sync.replaceChildren(
      h('span', { class: `light ${s.sync.status === 'ok' ? 'ok' : 'err'}`, 'aria-hidden': 'true' }),
      s.sync.at ? `${s.sync.status === 'ok' ? 'OK' : 'Fehler'} · ${dateTimeDe(s.sync.at)}` : 'noch nicht gelaufen',
    );
    if (s.sync.error) sync.title = s.sync.error;
    $('st-export').textContent = s.lastExport
      ? `${dateTimeDe(s.lastExport.at)} · ${s.lastExport.status === 'sent' ? 'gesendet' : 'fehlgeschlagen'}`
      : 'noch keiner';
    $('st-next').textContent = de(s.nextSend);
    return s;
  }

  async function loadBookingsTab() {
    const s = await loadStatus();
    if (!filtersInitialised && s) {
      $('f-from').value = s.periodFrom;
      $('f-to').value = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
      filtersInitialised = true;
    }
    if (!companiesLoaded) {
      const c = await api('/api/admin/companies');
      if (c.ok) {
        $('f-company').replaceChildren(h('option', { value: '' }, 'Alle'), ...c.rows.map((r) => h('option', { value: r.id }, r.name)));
        companiesLoaded = true;
      }
    }
    loadBookings();
  }

  async function loadBookings() {
    const p = new URLSearchParams({
      from: $('f-from').value, to: $('f-to').value, company: $('f-company').value, type: $('f-type').value, q: $('f-q').value,
    });
    const r = await api(`/api/admin/bookings?${p}`);
    if (!r.ok) return;
    const tbody = $('rows');
    tbody.replaceChildren(...r.rows.map(bookingRow));
    $('rows-empty').hidden = r.rows.length > 0;
  }

  function bookingRow(r) {
    const notes = [];
    if (r.kind === 'meal' && !r.punch_checked) notes.push(h('span', { class: 'tag warn' }, 'Stempelung nicht geprüft'));
    if (r.source === 'admin') notes.push(h('span', { class: 'tag green' }, `Nachgetragen · ${r.comment || ''}`));
    if (r.kind === 'guest') notes.push(h('span', { class: 'small' }, `${r.paying_company} · ${r.reason}`));
    if (r.cancelled_at) notes.push(h('span', { class: 'tag grey' }, `Storniert · ${r.cancel_comment || ''}`));

    const what = r.kind === 'meal' ? 'Essen' : `Gast · ${r.guest_name}`;
    const action = r.cancelled_at
      ? h('span', { class: 'small muted' }, r.cancelled_by || '')
      : h('button', { class: 'link', type: 'button', onclick: () => openCancel(r) }, 'Stornieren');

    return h('tr', { class: r.cancelled_at ? 'cancelled' : '' },
      h('td', { class: 'nowrap' }, deShort(r.date)),
      h('td', {}, r.time),
      h('td', {}, r.staff_number || ''),
      h('td', { class: 'name nowrap' }, `${r.last_name}, ${r.first_name}`),
      h('td', {}, r.company),
      h('td', {}, what),
      h('td', {}, notes),
      h('td', {}, action),
    );
  }

  let filterTimer;
  $('filters').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(loadBookings, 250); });
  $('filters').addEventListener('submit', (e) => e.preventDefault());

  $('download').addEventListener('click', async () => {
    const p = new URLSearchParams({ from: $('f-from').value, to: $('f-to').value });
    const res = await fetch(`/api/admin/export.xlsx?${p}`, { credentials: 'same-origin' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Download fehlgeschlagen.');
      return;
    }
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'Kantine.xlsx';
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  // Stornieren
  let cancelTarget = null;
  function openCancel(r) {
    cancelTarget = r;
    $('cancel-what').textContent = `${de(r.date)} ${r.time} · ${r.first_name} ${r.last_name} · ${r.kind === 'meal' ? 'Essen' : `Gast ${r.guest_name}`}`;
    $('cancel-comment').value = '';
    $('cancel-error').hidden = true;
    $('dlg-cancel').showModal();
  }
  $('cancel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const path = cancelTarget.kind === 'meal' ? 'bookings' : 'guests';
    const r = await api(`/api/admin/${path}/${cancelTarget.id}/cancel`, { method: 'POST', body: { comment: $('cancel-comment').value } });
    if (!r.ok) { $('cancel-error').textContent = r.error; $('cancel-error').hidden = false; return; }
    $('dlg-cancel').close();
    loadBookingsTab();
  });

  // Nachtragen
  let addEmployee = null;
  $('open-add').addEventListener('click', () => {
    addEmployee = null;
    $('add-search').value = '';
    $('add-results').replaceChildren();
    $('add-picked').textContent = '';
    $('add-date').value = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    $('add-date').max = $('add-date').value;
    $('add-comment').value = '';
    $('add-error').hidden = true;
    $('dlg-add').showModal();
  });
  let searchTimer;
  $('add-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('add-search').value.trim();
      if (q.length < 2) { $('add-results').replaceChildren(); return; }
      const r = await api(`/api/admin/employees?q=${encodeURIComponent(q)}`);
      $('add-results').replaceChildren(...(r.rows || []).map((e) => h('li', {}, h('button', {
        type: 'button',
        onclick: () => {
          addEmployee = e;
          $('add-picked').textContent = `Ausgewählt: ${e.last_name}, ${e.first_name} (${e.staff_number || 'ohne Nr.'}) · ${e.company}${e.is_active ? '' : ' · inaktiv'}`;
          $('add-results').replaceChildren();
        },
      }, `${e.last_name}, ${e.first_name} · ${e.staff_number || '–'} · ${e.company}${e.is_active ? '' : ' (inaktiv)'}`))));
    }, 200);
  });
  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('add-error');
    if (!addEmployee) { err.textContent = 'Bitte einen Mitarbeiter auswählen.'; err.hidden = false; return; }
    const r = await api('/api/admin/bookings', { method: 'POST', body: { employeeId: addEmployee.id, date: $('add-date').value, time: $('add-time').value, comment: $('add-comment').value } });
    if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
    $('dlg-add').close();
    loadBookingsTab();
  });
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

  // ---------- Settings ----------
  const lists = { recipients: [], paying_companies: [], reasons: [] };
  let dirty = false;
  const markDirty = () => { dirty = true; $('save-state').textContent = 'Ungespeicherte Änderungen'; };

  function renderList(key) {
    const ul = $(`s-${key}`);
    ul.replaceChildren(...lists[key].map((item, i) => h('li', {}, h('span', {}, item),
      h('button', { class: 'link', type: 'button', onclick: () => { lists[key].splice(i, 1); renderList(key); markDirty(); } }, 'Entfernen'))));
    if (!lists[key].length) ul.append(h('li', { class: 'empty-item' }, 'Noch keine Einträge'));
  }

  for (const btn of document.querySelectorAll('[data-add]')) {
    const key = btn.dataset.add;
    const input = key === 'recipients' ? $('s-recipient-new') : $(`s-${key}-new`);
    const add = () => {
      const v = input.value.trim();
      if (!v || lists[key].includes(v)) return;
      lists[key].push(v);
      input.value = '';
      renderList(key);
      markDirty();
    };
    btn.addEventListener('click', add);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  }

  async function loadSettings() {
    const r = await api('/api/admin/settings');
    if (!r.ok) return;
    const s = r.settings;
    const sel = $('s-send-day');
    if (!sel.options.length) for (let d = 1; d <= 28; d++) sel.append(h('option', { value: d }, `${d}. des Monats`));
    sel.value = s.send_day;
    $('s-smtp-host').value = s.smtp_host;
    $('s-smtp-port').value = s.smtp_port;
    $('s-smtp-user').value = s.smtp_user;
    $('s-smtp-from').value = s.smtp_from;
    $('s-smtp-pass').value = '';
    $('s-smtp-pass').placeholder = s.smtp_pass_set ? 'Passwort gespeichert (leer lassen = unverändert)' : 'Passwort';
    $('s-g-id').value = s.gastromatic_client_id;
    $('s-g-secret').value = '';
    $('s-g-secret').placeholder = s.gastromatic_client_secret_set ? 'gespeichert (leer lassen = unverändert)' : '';
    $('g-mode').textContent = s.gastromatic_mode === 'mock'
      ? 'Testmodus aktiv (GASTROMATIC_MODE=mock). Für echte Daten in der .env auf „live“ umstellen.'
      : 'Live-Anbindung aktiv. Automatischer Abgleich jede Nacht.';
    $('s-sounds').checked = s.sounds_enabled !== '0';
    $('s-retention').value = s.retention_months;
    $('kiosk-url').value = s.kiosk_url;
    for (const k of Object.keys(lists)) { lists[k] = s[k] || []; renderList(k); }
    dirty = false;
    $('save-state').textContent = '';
    loadGastroStatus();
    loadUsers();
    if (!privacyDirty) loadPrivacy();
  }

  async function loadGastroStatus() {
    const s = await api('/api/admin/status');
    if (!s.ok) return;
    $('g-status').replaceChildren(
      h('span', { class: `light ${s.sync.status === 'ok' ? 'ok' : 'err'}`, 'aria-hidden': 'true' }),
      s.sync.at ? `${s.sync.status === 'ok' ? 'Letzter Abgleich' : 'Abgleich fehlgeschlagen'}: ${dateTimeDe(s.sync.at)}${s.sync.error ? ` · ${s.sync.error}` : ''}` : 'Noch kein Abgleich',
    );
  }

  for (const id of ['s-send-day', 's-smtp-host', 's-smtp-port', 's-smtp-user', 's-smtp-pass', 's-smtp-from', 's-g-id', 's-g-secret', 's-sounds', 's-retention']) {
    $(id).addEventListener('input', markDirty);
    $(id).addEventListener('change', markDirty);
  }

  async function saveSettings() {
    const body = {
      send_day: Number($('s-send-day').value),
      smtp_host: $('s-smtp-host').value,
      smtp_port: $('s-smtp-port').value,
      smtp_user: $('s-smtp-user').value,
      smtp_from: $('s-smtp-from').value,
      smtp_pass: $('s-smtp-pass').value,
      gastromatic_client_id: $('s-g-id').value,
      gastromatic_client_secret: $('s-g-secret').value,
      sounds_enabled: $('s-sounds').checked ? '1' : '0',
      retention_months: Number($('s-retention').value),
      ...lists,
    };
    const r = await api('/api/admin/settings', { method: 'PUT', body });
    $('save-state').textContent = r.ok ? 'Gespeichert' : r.error;
    if (r.ok) { dirty = false; loadSettings(); }
    return r.ok;
  }
  $('save-settings').addEventListener('click', saveSettings);

  async function withSave(fn) { if (dirty && !(await saveSettings())) return; await fn(); }

  $('test-mail').addEventListener('click', () => withSave(async () => {
    $('mail-result').textContent = 'Sende Testmail …';
    const r = await api('/api/admin/test-mail', { method: 'POST' });
    $('mail-result').textContent = r.ok ? 'Testmail wurde verschickt.' : `Fehler: ${r.error}`;
  }));
  $('send-now').addEventListener('click', () => withSave(async () => {
    if (!confirm('Excel jetzt an die Empfänger senden? Der Zeitraum gilt danach als versendet.')) return;
    $('mail-result').textContent = 'Versende …';
    const r = await api('/api/admin/send-now', { method: 'POST' });
    $('mail-result').textContent = !r.ok ? `Fehler: ${r.error}` : r.skipped ? r.message : `Versendet: ${de(r.from)} – ${de(r.to)} (${r.counts.bookings} Essen, ${r.counts.guests} Gäste)`;
  }));
  $('g-test').addEventListener('click', () => withSave(async () => {
    $('g-result').textContent = 'Teste Verbindung …';
    const r = await api('/api/admin/gastromatic/test', { method: 'POST' });
    $('g-result').textContent = r.ok ? `Verbindung OK · ${r.organizations} Gesellschaft(en) gefunden${r.mock ? ' (Testdaten)' : ''}` : `Fehler: ${r.error}`;
  }));
  $('g-sync').addEventListener('click', () => withSave(async () => {
    $('g-result').textContent = 'Gleiche Mitarbeiter ab …';
    const r = await api('/api/admin/gastromatic/sync', { method: 'POST' });
    $('g-result').textContent = r.ok ? `${r.employees} Mitarbeitende, davon ${r.withPin} mit Terminal-Pin, aus ${r.companies} Gesellschaft(en)` : `Fehler: ${r.error}`;
    companiesLoaded = false;
    loadGastroStatus();
  }));
  $('copy-kiosk').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('kiosk-url').value); $('copy-kiosk').textContent = 'Kopiert'; } catch { $('kiosk-url').select(); }
    setTimeout(() => { $('copy-kiosk').textContent = 'Kopieren'; }, 2000);
  });

  // Benutzer
  async function loadUsers() {
    const r = await api('/api/admin/users');
    if (!r.ok) return;
    $('users').replaceChildren(...r.rows.map((u) => h('li', {},
      h('span', {}, `${u.name || '–'} · ${u.email}`),
      u.id === r.me ? h('span', { class: 'small muted' }, 'du') : h('button', {
        class: 'link', type: 'button',
        onclick: async () => {
          if (!confirm(`${u.email} wirklich entfernen?`)) return;
          const d = await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
          if (!d.ok) alert(d.error);
          loadUsers();
        },
      }, 'Entfernen'))));
  }
  $('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/admin/users', { method: 'POST', body: { name: $('u-name').value, email: $('u-email').value, password: $('u-pass').value } });
    $('user-error').hidden = r.ok;
    if (!r.ok) { $('user-error').textContent = r.error; return; }
    $('u-name').value = ''; $('u-email').value = ''; $('u-pass').value = '';
    loadUsers();
  });
  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/admin/password', { method: 'POST', body: { current: $('pw-current').value, next: $('pw-next').value } });
    $('pw-result').textContent = r.ok ? 'Passwort geändert.' : r.error;
    if (r.ok) { $('pw-current').value = ''; $('pw-next').value = ''; }
  });

  // ---------- Datenschutzhinweise ----------
  let privacyDirty = false;
  function renderPrivacyPreview() {
    const t = $('privacy-text').value;
    window.renderPrivacy(t, $('privacy-preview'));
    $('privacy-count').textContent = `${t.length.toLocaleString('de-DE')} von 20.000 Zeichen`;
  }
  async function loadPrivacy() {
    const r = await api('/api/privacy');
    $('privacy-text').value = r.text || '';
    privacyDirty = false;
    $('privacy-result').textContent = r.custom ? '' : 'Es wird der Standardtext angezeigt.';
    renderPrivacyPreview();
  }
  $('privacy-text').addEventListener('input', () => { privacyDirty = true; $('privacy-result').textContent = 'Ungespeicherte Änderungen'; renderPrivacyPreview(); });
  $('privacy-save').addEventListener('click', async () => {
    const r = await api('/api/admin/privacy', { method: 'PUT', body: { text: $('privacy-text').value } });
    $('privacy-result').textContent = r.ok ? 'Gespeichert. Das Tablet zeigt den neuen Text beim nächsten Öffnen (spätestens nach 10 Minuten).' : r.error;
    if (r.ok) privacyDirty = false;
  });
  $('privacy-reset').addEventListener('click', async () => {
    if (!confirm('Eigenen Text verwerfen und den Standardtext wiederherstellen?')) return;
    const r = await api('/api/admin/privacy', { method: 'DELETE' });
    if (r.ok) { await loadPrivacy(); $('privacy-result').textContent = 'Standardtext wiederhergestellt.'; }
  });

  // ---------- Protokoll ----------
  const ACTIONS = {
    login: 'Anmeldung', booking_added: 'Buchung nachgetragen', booking_cancelled: 'Buchung storniert',
    guest_cancelled: 'Gast storniert', settings_changed: 'Settings geändert', export_sent: 'Excel versendet',
    export_failed: 'Excel-Versand fehlgeschlagen', export_downloaded: 'Excel heruntergeladen',
    gastromatic_sync: 'Mitarbeiter abgeglichen', user_created: 'Benutzer angelegt', user_deleted: 'Benutzer entfernt',
    password_changed: 'Passwort geändert',
    privacy_changed: 'Datenschutzhinweise geändert', privacy_reset: 'Datenschutzhinweise zurückgesetzt',
  };
  async function loadAudit() {
    const r = await api('/api/admin/audit');
    if (!r.ok) return;
    $('audit-rows').replaceChildren(...r.rows.map((a) => h('tr', {},
      h('td', { class: 'nowrap' }, a.at),
      h('td', {}, a.actor),
      h('td', {}, ACTIONS[a.action] || a.action),
      h('td', { class: 'details' }, a.details || ''),
    )));
  }

  window.addEventListener('beforeunload', (e) => { if (dirty || privacyDirty) e.preventDefault(); });

  // ---------- Start ----------
  api('/api/admin/me').then((r) => (r.ok ? startApp(r.user) : showLogin())).catch(showLogin);
})();
