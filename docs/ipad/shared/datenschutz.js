'use strict';
fetch('/api/privacy', { credentials: 'same-origin' })
  .then((r) => r.json())
  .then((d) => {
    window.renderPrivacy(d.text, document.getElementById('privacy-content'));
    const h1 = document.querySelector('.privacy h1');
    if (h1) document.title = `${h1.textContent} · Kantinen-App`;
  })
  .catch(() => { document.getElementById('privacy-content').textContent = 'Die Datenschutzhinweise konnten nicht geladen werden.'; });
