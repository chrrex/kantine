'use strict';
/**
 * Stellt den Datenschutztext dar. Einfache Regeln, kein HTML (Text wird nie als HTML eingefügt):
 *   # Titel        ## Zwischenüberschrift
 *   - Aufzählung   > Hinweisbox
 *   Leerzeile = neuer Absatz, einfacher Zeilenumbruch bleibt erhalten.
 */
window.renderPrivacy = function renderPrivacy(text, target) {
  const article = document.createElement('article');
  article.className = 'privacy';
  let para = null;
  let list = null;
  const close = () => { para = null; list = null; };
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { close(); continue; }
    let m;
    if ((m = line.match(/^##\s+(.*)$/))) { close(); const el = document.createElement('h2'); el.textContent = m[1]; article.append(el); continue; }
    if ((m = line.match(/^#\s+(.*)$/))) { close(); const el = document.createElement('h1'); el.textContent = m[1]; article.append(el); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { close(); const el = document.createElement('p'); el.className = 'privacy-draft'; el.textContent = m[1]; article.append(el); continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/))) {
      para = null;
      if (!list) { list = document.createElement('ul'); article.append(list); }
      const li = document.createElement('li'); li.textContent = m[1]; list.append(li);
      continue;
    }
    list = null;
    if (!para) { para = document.createElement('p'); article.append(para); } else { para.append(document.createElement('br')); }
    para.append(line.trim());
  }
  target.replaceChildren(article);
  return article;
};
