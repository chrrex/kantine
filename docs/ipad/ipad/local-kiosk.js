'use strict';
/**
 * Ergänzungen für das Tablet in der iPad-Version:
 * - Verwaltung öffnen: Logo 3 Sekunden gedrückt halten
 * - Hinweise, wenn noch keine Mitarbeiterliste importiert ist oder der Monats-Export fällig ist
 */
(() => {
  const HOLD_MS = 3000;
  document.addEventListener('DOMContentLoaded', () => {
    const logo = document.querySelector('#screen-pin .logo');
    if (logo) {
      let timer = null;
      const start = (e) => {
        e.preventDefault();
        logo.classList.add('holding');
        timer = setTimeout(() => { logo.classList.remove('holding'); location.href = '../admin/'; }, HOLD_MS);
      };
      const stop = () => { clearTimeout(timer); timer = null; logo.classList.remove('holding'); };
      logo.addEventListener('pointerdown', start);
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) logo.addEventListener(ev, stop);
      logo.addEventListener('contextmenu', (e) => e.preventDefault());
      logo.setAttribute('draggable', 'false');
    }

    const note = document.createElement('div');
    note.className = 'local-note';
    note.setAttribute('role', 'status');
    note.hidden = true;
    document.querySelector('#screen-pin .pin-layout')?.before(note);

    async function refresh() {
      try {
        const cfg = await (await fetch('../api/kiosk/config')).json();
        if (!cfg.employees) {
          note.textContent = 'Noch keine Mitarbeiterliste importiert. HR: Logo 3 Sekunden gedrückt halten, um die Verwaltung zu öffnen.';
          note.hidden = false;
        } else if (cfg.exportDue) {
          note.textContent = 'Hinweis für HR: Die Monatsabrechnung ist fällig. Bitte in der Verwaltung das Excel erstellen.';
          note.hidden = false;
        } else note.hidden = true;
      } catch { note.hidden = true; }
    }
    refresh();
    setInterval(refresh, 10 * 60 * 1000);

    // Einmal pro Nacht neu laden, damit Updates der App ankommen (nur wenn gerade niemand tippt)
    const started = Date.now();
    setInterval(() => {
      const idle = document.getElementById('screen-pin')?.hasAttribute('data-active') && !document.querySelector('.dots .filled, .pin-dots .filled');
      if (new Date().getHours() === 3 && Date.now() - started > 2 * 3600 * 1000 && idle) location.reload();
    }, 5 * 60 * 1000);
  });
})();
