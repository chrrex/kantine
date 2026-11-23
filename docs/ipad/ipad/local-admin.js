'use strict';
/**
 * Verwaltung in der iPad-Version: Anmeldung mit Admin-PIN, Mitarbeiterliste importieren,
 * Monatsabrechnung erstellen und teilen, Datensicherung. Wird vor admin.js geladen.
 */
(() => {
  document.documentElement.classList.add('local');
  const $ = (id) => document.getElementById(id);
  const L = () => window.kantineLocal;
  const monthName = (m) => `${['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'][Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const de = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
  const dateTimeDe = (ts) => {
    if (!ts) return '';
    const d = new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) { if (k === 'class') el.className = v; else el.setAttribute(k, v); }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }
  const api = async (path, body) => (await fetch(`../api/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();

  /** Teilen-Menü (iPad) oder Download. Muss direkt aus einem Tipp aufgerufen werden. */
  async function shareOrDownload(file, forceDownload = false, throwIfNotAllowed = false) {
    if (!forceDownload && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name });
        return 'geteilt';
      } catch (err) {
        if (err && err.name === 'AbortError') return null;
        if (err && err.name === 'NotAllowedError' && throwIfNotAllowed) throw err;
      }
    }
    const url = URL.createObjectURL(file);
    const a = h('a', { href: url, download: file.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'heruntergeladen';
  }

  document.addEventListener('DOMContentLoaded', () => {
    // ---------- Anmeldung ----------
    const email = $('login-email');
    email.required = false; email.type = 'text'; email.value = 'admin';
    const pw = $('login-password');
    pw.setAttribute('inputmode', 'numeric');
    pw.setAttribute('autocomplete', 'off');
    const pwLabel = document.querySelector('label[for="login-password"]');
    const submit = document.querySelector('#login-form button[type="submit"]');
    const hint = h('p', { class: 'small muted', id: 'login-hint' });
    pw.after(hint);
    const forgot = h('button', { class: 'link small', type: 'button' }, 'Admin-PIN vergessen?');
    submit.after(forgot);
    const back = h('a', { class: 'small back-link', href: '../kiosk/' }, '← Zurück zur Kantine');
    document.querySelector('.login-card').append(back);

    async function prepareLogin() {
      const info = await api('local/info').catch(() => ({}));
      if (info.adminSet === false) {
        pwLabel.textContent = 'Neue Admin-PIN festlegen (6 bis 12 Ziffern)';
        hint.textContent = 'Erste Einrichtung: Diese PIN brauchen HR und Direktion künftig für die Verwaltung. Danach erhältst du einen Wiederherstellungscode.';
        submit.textContent = 'Admin-PIN festlegen';
        forgot.hidden = true;
      } else {
        pwLabel.textContent = 'Admin-PIN';
        hint.textContent = '';
        submit.textContent = 'Anmelden';
        forgot.hidden = false;
      }
    }
    prepareLogin();
    new MutationObserver(() => { if (!$('view-login').hidden) { prepareLogin(); pw.focus(); } }).observe($('view-login'), { attributes: true, attributeFilter: ['hidden'] });

    window.addEventListener('kantine-recovery', (e) => {
      $('recovery-code').textContent = e.detail;
      $('dlg-recovery').showModal();
    });
    forgot.addEventListener('click', () => { $('forgot-error').hidden = true; $('forgot-code').value = ''; $('forgot-pin').value = ''; $('dlg-forgot').showModal(); });
    $('forgot-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await api('local/recover', { code: $('forgot-code').value, pin: $('forgot-pin').value });
      if (!r.ok) { $('forgot-error').textContent = r.error; $('forgot-error').hidden = false; return; }
      $('dlg-forgot').close();
      location.reload();
    });

    // Filter „Art“: Gruppen ergänzen
    $('f-type').append(h('option', { value: 'group' }, 'Gruppen'));

    // Navigation: zurück zum Tablet
    const navSpacer = document.querySelector('.nav .spacer');
    navSpacer.after(h('a', { class: 'small back-link', href: '../kiosk/' }, 'Zur Kantine'));

    // Statuskarten umbenennen
    const labels = document.querySelectorAll('.cards .stat-label');
    if (labels.length === 4) {
      labels[0].textContent = 'Essen diesen Monat';
      labels[1].textContent = 'Mitarbeiterliste';
      labels[2].textContent = 'Letzter Export';
      labels[3].textContent = 'Abrechnung fällig ab';
    }
    let status = null;
    // admin.js schreibt hier die Server-Texte hinein; wir ersetzen sie (nur wenn nötig, sonst Endlosschleife)
    function setText(id, text) { if ($(id).textContent !== text) $(id).textContent = text; }
    function applyStatus() {
      if (!status) return;
      setText('st-sync', status.employees ? `${status.employees} mit PIN · ${dateTimeDe(status.sync.at)}` : 'noch nicht importiert');
      if (status.nextSend) setText('st-next', de(status.nextSend));
      setText('st-guests', `seit ${de(status.periodFrom)} · ${status.guests} Gästeessen · ${status.groupMeals || 0} Gruppenessen`);
      setText('st-export', status.lastExport ? `${status.lastExport.month === 'all' ? 'Alle Daten' : (status.lastExport.month ? monthName(status.lastExport.month) : `bis ${de(status.lastExport.period_to)}`)} · ${dateTimeDe(status.lastExport.at)}` : 'noch keiner');
    }
    for (const id of ['st-sync', 'st-export', 'st-next', 'st-guests']) new MutationObserver(applyStatus).observe($(id), { childList: true, characterData: true, subtree: true });

    // ---------- Monatsabrechnung ----------
    async function refresh() {
      if ($('view-app').hidden) return;
      const s = await api('admin/status');
      if (!s.ok) return;
      status = s;
      applyStatus();
      $('lx-due').hidden = !s.exportDue;
      $('lx-due').textContent = `Die Abrechnung für ${s.dueLabel} ist fällig. Bitte unten exportieren und ablegen oder verschicken.`;
      renderMonths();
      $('li-status').textContent = s.employees ? `${s.employees} Mitarbeitende mit PIN · zuletzt importiert ${dateTimeDe(s.sync.at)}${s.importFile ? ` aus „${s.importFile}“` : ''}` : 'Noch keine Mitarbeiterliste importiert.';
      $('lb-persist').textContent = s.persisted
        ? 'Der Speicher ist dauerhaft geschützt.'
        : 'Hinweis: Die App sollte über „Zum Home-Bildschirm“ gestartet werden, damit iPadOS die Daten nicht automatisch löscht.';
    }
    new MutationObserver(refresh).observe($('view-app'), { attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('hashchange', refresh);
    document.addEventListener('kantine-refresh', refresh);

    const lastCell = (ts) => (ts ? dateTimeDe(ts) : h('span', { class: 'never' }, 'noch nie'));
    async function renderMonths() {
      const m = await L().months().catch(() => null);
      if (!m) return;
      $('lx-rows').replaceChildren(...m.rows.map((r) => h('tr', {},
        h('td', { class: 'nowrap' }, r.label, r.current ? h('span', { class: 'current' }, ' (läuft noch)') : null),
        h('td', { class: 'num' }, String(r.meals)),
        h('td', { class: 'num' }, String(r.guests)),
        h('td', { class: 'num' }, String(r.groups)),
        h('td', { class: 'nowrap' }, r.current && !r.lastExport ? '–' : lastCell(r.lastExport)),
        h('td', { class: 'action' }, exportButton(r.month, r.label)))));
      $('lx-all-meals').textContent = String(m.total.meals);
      $('lx-all-guests').textContent = String(m.total.guests);
      $('lx-all-groups').textContent = String(m.total.groups);
      $('lx-all-last').replaceChildren(m.total.lastExport ? dateTimeDe(m.total.lastExport) : '–');
      $('lx-empty').hidden = m.rows.length > 0;
      $('lx-all').disabled = m.rows.length === 0;
    }

    /** Excel erstellen und sofort teilen. Lässt Safari das Teilen nach dem Erstellen nicht zu,
        wird der Button zu „Jetzt teilen“ und ein zweiter Tipp öffnet das Teilen-Menü. */
    async function runExport(btn, key, label) {
      const original = btn.dataset.label || btn.textContent;
      btn.dataset.label = original;
      if (btn._built) {
        const built = btn._built;
        const how = await shareOrDownload(built.file);
        if (how) await done(btn, built, label, how);
        return;
      }
      btn.disabled = true; btn.textContent = 'Erstelle …';
      $('lx-result').textContent = '';
      try {
        const built = await L().buildExport(key);
        if (built.empty) { $('lx-result').textContent = built.message; return; }
        let how;
        try {
          how = await shareOrDownload(built.file, false, true);
        } catch (err) {
          if (err && err.name === 'NotAllowedError') {
            btn._built = built; btn.textContent = 'Jetzt teilen';
            $('lx-result').textContent = `${built.file.name} ist fertig. Bitte noch einmal auf „Jetzt teilen“ tippen.`;
            return;
          }
          throw err;
        }
        if (how) await done(btn, built, label, how);
        else $('lx-result').textContent = 'Export abgebrochen.';
      } catch (err) {
        $('lx-result').textContent = `Fehler: ${err.message}`;
      } finally {
        btn.disabled = false;
        if (!btn._built) btn.textContent = original;
      }
    }
    async function done(btn, built, label, how) {
      btn._built = null; btn.textContent = btn.dataset.label;
      await L().markExported(built.key, built.from, built.to, built.counts, how);
      $('lx-result').textContent = `${label}: ${built.counts.bookings} Essen, ${built.counts.guests} Gästeessen und ${built.counts.groupMeals} Gruppenessen exportiert (${how}).`;
      document.dispatchEvent(new Event('kantine-refresh'));
    }
    function exportButton(key, label) {
      const b = h('button', { class: 'btn', type: 'button' }, 'Exportieren');
      b.addEventListener('click', () => runExport(b, key, label));
      return b;
    }
    $('lx-all').addEventListener('click', () => runExport($('lx-all'), 'all', 'Alle Daten'));
    // Nach Storno oder Nachtrag lädt admin.js die Liste neu – dann auch die Monatstabelle aktualisieren
    let monthsTimer;
    new MutationObserver(() => { clearTimeout(monthsTimer); monthsTimer = setTimeout(renderMonths, 150); }).observe($('rows'), { childList: true });

    // ---------- Mitarbeiterliste ----------
    let pendingFile = null;
    function report(r) {
      const box = $('li-report');
      const parts = [];
      const s = r.summary;
      if (s) {
        parts.push(h('p', {}, h('strong', {}, `${s.total} Personen erkannt`), ` · ${s.active} aktiv · ${s.withPin} mit PIN · ${s.added} neu · ${s.deactivated} werden gesperrt (fehlen in der Liste)`));
        if (s.companies.length) parts.push(h('p', { class: 'small' }, `Gesellschaften: ${s.companies.join(', ')}`));
      }
      if (r.errors.length) parts.push(h('p', { class: 'error small' }, 'Bitte die Datei korrigieren und erneut auswählen:'), h('ul', { class: 'report err' }, r.errors.slice(0, 30).map((t) => h('li', {}, t))));
      if (r.warnings.length) parts.push(h('ul', { class: 'report warn' }, r.warnings.slice(0, 30).map((t) => h('li', {}, t))));
      box.replaceChildren(...parts);
      box.hidden = false;
    }
    $('li-file').addEventListener('change', async () => {
      const file = $('li-file').files[0];
      $('li-file').value = '';
      if (!file) return;
      pendingFile = null; $('li-apply').hidden = true; $('li-discard').hidden = true;
      $('li-result').textContent = `Prüfe „${file.name}“ …`;
      try {
        const r = await L().previewImport(file);
        report(r);
        if (r.ok) { pendingFile = file; $('li-apply').hidden = false; $('li-discard').hidden = false; $('li-result').textContent = 'Vorschau – noch nichts übernommen.'; } else $('li-result').textContent = '';
      } catch (err) { $('li-report').hidden = true; $('li-result').textContent = `Fehler: ${err.message}`; }
    });
    $('li-discard').addEventListener('click', () => { pendingFile = null; $('li-apply').hidden = true; $('li-discard').hidden = true; $('li-report').hidden = true; $('li-result').textContent = 'Verworfen.'; });
    $('li-apply').addEventListener('click', async () => {
      if (!pendingFile) return;
      try {
        const r = await L().applyImport(pendingFile);
        report(r);
        $('li-result').textContent = r.applied ? 'Mitarbeiterliste übernommen.' : 'Nicht übernommen.';
        if (r.applied) { pendingFile = null; $('li-apply').hidden = true; $('li-discard').hidden = true; loadEmployees(); document.dispatchEvent(new Event('kantine-refresh')); }
      } catch (err) { $('li-result').textContent = `Fehler: ${err.message}`; }
    });
    $('li-template').addEventListener('click', async () => {
      try { await shareOrDownload(await L().template()); } catch (err) { $('li-result').textContent = `Fehler: ${err.message}`; }
    });
    async function loadEmployees() {
      const r = await (await fetch(`../api/admin/employees?q=${encodeURIComponent($('li-search').value)}`)).json();
      if (!r.ok) return;
      $('li-rows').replaceChildren(...r.rows.map((e) => {
        const del = h('button', { class: 'link danger-link', type: 'button' }, 'Löschen');
        del.addEventListener('click', async () => {
          if (!confirm(`${e.first_name} ${e.last_name} löschen? Die Person kann danach nicht mehr buchen. Bereits gebuchte Essen bleiben für die Abrechnung erhalten.`)) return;
          try {
            const res = await L().deleteEmployee(e.id);
            $('li-del-result').textContent = `${e.first_name} ${e.last_name} gelöscht.${res.keptForBookings ? ' Die bisherigen Buchungen bleiben in der Abrechnung, bis die Löschfrist abläuft.' : ''}`;
            loadEmployees();
            document.dispatchEvent(new Event('kantine-refresh'));
          } catch (err) { $('li-del-result').textContent = `Fehler: ${err.message}`; }
        });
        return h('tr', {},
          h('td', {}, e.staff_number || ''), h('td', { class: 'nowrap' }, `${e.last_name}, ${e.first_name}`), h('td', {}, e.company),
          h('td', {}, e.is_active ? (e.has_pin ? 'aktiv' : 'aktiv, ohne PIN') : 'gesperrt'), h('td', {}, del));
      }));
    }
    $('li-details').addEventListener('toggle', () => { if ($('li-details').open) loadEmployees(); });
    let searchTimer;
    $('li-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadEmployees, 200); });

    // Person hinzufügen
    async function loadCompanies() {
      const r = await (await fetch('../api/admin/companies')).json();
      if (r.ok) $('ea-companies').replaceChildren(...r.rows.map((c) => h('option', { value: c.name })));
    }
    $('li-add').addEventListener('toggle', () => { if ($('li-add').open) { loadCompanies(); $('ea-first').focus(); } });
    $('ea-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const r = await L().addEmployee({ first_name: $('ea-first').value, last_name: $('ea-last').value, staff_number: $('ea-nr').value, pin: $('ea-pin').value, company: $('ea-company').value });
        $('ea-result').textContent = `${r.name} ${r.revived ? 'wieder aktiviert' : 'hinzugefügt'} – kann jetzt am Tablet buchen.`;
        for (const id of ['ea-first', 'ea-last', 'ea-nr', 'ea-pin']) $(id).value = '';
        loadCompanies();
        if ($('li-details').open) loadEmployees();
        document.dispatchEvent(new Event('kantine-refresh'));
      } catch (err) { $('ea-result').textContent = err.message; }
    });

    // ---------- Erinnerungstag (spiegelt das versteckte Feld der Server-Version) ----------
    const day = $('lx-day');
    for (let d = 1; d <= 28; d++) day.append(h('option', { value: String(d) }, `${d}. des Monats`));
    const sendDay = $('s-send-day');
    const syncDay = () => { if (sendDay.value) day.value = sendDay.value; };
    new MutationObserver(syncDay).observe(sendDay, { childList: true });
    sendDay.addEventListener('change', syncDay);
    window.addEventListener('hashchange', () => setTimeout(syncDay, 300));
    day.addEventListener('change', () => { sendDay.value = day.value; sendDay.dispatchEvent(new Event('change')); });
    setInterval(() => { if (document.activeElement !== day && sendDay.value && day.value !== sendDay.value) syncDay(); }, 1000);

    // ---------- Datensicherung ----------
    let backupFile = null;
    $('lb-create').addEventListener('click', async () => {
      try {
        backupFile = await L().backup();
        if (navigator.canShare && navigator.canShare({ files: [backupFile] })) {
          $('lb-share').hidden = false;
          $('lb-result').textContent = `${backupFile.name} ist bereit.`;
        } else {
          await shareOrDownload(backupFile);
          $('lb-result').textContent = `${backupFile.name} wurde heruntergeladen.`;
        }
      } catch (err) { $('lb-result').textContent = `Fehler: ${err.message}`; }
    });
    $('lb-share').addEventListener('click', async () => {
      if (!backupFile) return;
      const how = await shareOrDownload(backupFile);
      if (how) { $('lb-result').textContent = `Sicherung ${how}.`; $('lb-share').hidden = true; }
    });
    $('lb-file').addEventListener('change', async () => {
      const file = $('lb-file').files[0];
      $('lb-file').value = '';
      if (!file) return;
      if (!confirm(`Sicherung „${file.name}“ einspielen? Alle aktuellen Daten auf diesem iPad werden dadurch ersetzt.`)) return;
      try {
        const r = await L().restore(file);
        alert(`Sicherung vom ${dateTimeDe(r.created)} eingespielt (${r.bookings} Buchungen). Bitte mit der Admin-PIN aus dieser Sicherung anmelden.`);
        location.reload();
      } catch (err) { $('lb-result').textContent = `Fehler: ${err.message}`; }
    });

    // ---------- Version und Updates ----------
    $('lv-version').textContent = L().version;
    window.addEventListener('kantine-update-ready', () => {
      $('lv-result').textContent = 'Neue Version geladen – die Seite startet neu …';
      const busy = () => [...document.querySelectorAll('dialog')].some((d) => d.open);
      const go = () => (busy() ? setTimeout(go, 5000) : location.reload());
      setTimeout(go, 1200);
    });
    $('lv-check').addEventListener('click', async () => {
      $('lv-install').hidden = true;
      $('lv-result').textContent = 'Suche nach Updates …';
      try {
        const r = await L().checkUpdate();
        if (r.available) {
          $('lv-result').textContent = `Neue Version verfügbar: ${r.label}.`;
          $('lv-install').hidden = false;
        } else $('lv-result').textContent = 'Du hast die neueste Version.';
      } catch (err) { $('lv-result').textContent = err.message; }
    });
    $('lv-install').addEventListener('click', async () => {
      $('lv-install').disabled = true;
      $('lv-result').textContent = 'Lade Update herunter …';
      try {
        const r = await L().installUpdate();
        $('lv-result').textContent = `Version ${r.label} installiert. Die App startet neu …`;
        setTimeout(() => location.reload(), 1200);
      } catch (err) { $('lv-result').textContent = `Update fehlgeschlagen: ${err.message} Die bisherige Version bleibt aktiv.`; }
      finally { $('lv-install').disabled = false; }
    });

    // ---------- Buchungen löschen ----------
    $('lr-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!$('lr-pin').value) { $('lr-result').textContent = 'Bitte zur Bestätigung die Admin-PIN eingeben.'; return; }
      if (!confirm('Wirklich ALLE Buchungen, Gästeessen und Exporte löschen? Das lässt sich nur mit einer Sicherung rückgängig machen. Mitarbeitende bleiben erhalten.')) return;
      try {
        const c = await L().resetBookings($('lr-pin').value);
        $('lr-result').textContent = `Gelöscht: ${c.essen} Essen, ${c.gaeste} Gästeessen, ${c.gruppen} Gruppen, ${c.exporte} Exporte. Die Mitarbeitenden sind unverändert.`;
        document.dispatchEvent(new Event('kantine-refresh'));
      } catch (err) { $('lr-result').textContent = err.message; }
      finally { $('lr-pin').value = ''; }
    });

    // ---------- Admin-PIN ändern ----------
    $('lp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const code = await L().changePin($('lp-current').value, $('lp-next').value);
        $('lp-current').value = ''; $('lp-next').value = '';
        $('lp-result').textContent = 'Admin-PIN geändert.';
        $('recovery-code').textContent = code;
        $('dlg-recovery').showModal();
      } catch (err) { $('lp-result').textContent = err.message; }
    });
  });
})();
