'use strict';
/**
 * Baut die Klick-Demo für GitHub Pages nach docs/.
 * Gleiche Oberfläche wie die App, aber statt Server ein Simulator im Browser (demo/demo-api.js).
 * Aufruf: npm run build:demo
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs');
const pub = path.join(root, 'public');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const dir of ['shared', 'kiosk', 'admin']) {
  fs.cpSync(path.join(pub, dir), path.join(out, dir), { recursive: true });
}
fs.rmSync(path.join(out, 'kiosk', 'manifest.webmanifest'), { force: true });

fs.mkdirSync(path.join(out, 'demo'), { recursive: true });
fs.copyFileSync(path.join(root, 'demo', 'demo-api.js'), path.join(out, 'demo', 'demo-api.js'));
fs.copyFileSync(path.join(root, 'demo', 'demo.css'), path.join(out, 'demo', 'demo.css'));
fs.copyFileSync(path.join(root, 'demo', 'index.html'), path.join(out, 'index.html'));
fs.copyFileSync(path.join(root, 'demo', 'dkb-stiftung-logo.jpg'), path.join(out, 'demo', 'dkb-stiftung-logo.jpg'));
fs.copyFileSync(require.resolve('exceljs/dist/exceljs.min.js'), path.join(out, 'demo', 'exceljs.min.js'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// Absolute Pfade in relative umschreiben (GitHub Pages liegt unter /kantine/)
function rewriteHtml(file, own) {
  let html = fs.readFileSync(file, 'utf8');
  html = html
    .replaceAll('href="/shared/', 'href="../shared/')
    .replaceAll('src="/shared/', 'src="../shared/')
    .replaceAll(`href="/${own}/`, 'href="./')
    .replaceAll(`src="/${own}/`, 'src="./')
    .replace(/\s*<link rel="manifest"[^>]*>/, '');
  // Simulator vor den App-Skripten laden
  html = html.replace(
    /<script src="\.\/(kiosk|admin)\.js"><\/script>/,
    (m) => `<link rel="stylesheet" href="../demo/demo.css">\n<script src="../demo/demo-api.js"></script>\n${m}`,
  );
  html = html.replace('<title>', '<title>DEMO · ');
  fs.writeFileSync(file, html);
}
rewriteHtml(path.join(out, 'kiosk', 'index.html'), 'kiosk');
rewriteHtml(path.join(out, 'admin', 'index.html'), 'admin');

const privacy = path.join(out, 'shared', 'datenschutz.html');
fs.writeFileSync(privacy, fs.readFileSync(privacy, 'utf8')
  .replaceAll('href="/shared/', 'href="./')
  .replace('<script src="/shared/privacy-render.js"></script>', '<link rel="stylesheet" href="../demo/demo.css">\n<script src="../demo/demo-api.js"></script>\n<script src="./privacy-render.js"></script>')
  .replace('<script src="/shared/datenschutz.js"></script>', '<script src="./datenschutz.js"></script>'));
for (const f of ['admin/index.html']) {
  const file = path.join(out, f);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('href="/shared/datenschutz.html"', 'href="../shared/datenschutz.html"'));
}

const fontsCss = path.join(out, 'shared', 'fonts.css');
fs.writeFileSync(fontsCss, fs.readFileSync(fontsCss, 'utf8').replaceAll("url('/shared/fonts/", "url('fonts/"));

// Versionsnummer an alle eigenen Skripte und Stylesheets hängen, damit Browser nach einem
// Update nie alte und neue Dateien mischen (GitHub Pages lässt bis zu 10 Minuten zwischenspeichern).
const version = Date.now().toString(36);
for (const f of ['index.html', 'kiosk/index.html', 'admin/index.html', 'shared/datenschutz.html']) {
  const file = path.join(out, f);
  const html = fs.readFileSync(file, 'utf8').replace(/((?:src|href)="(?!https?:|#)[^"?]+\.(?:js|css))"/g, `$1?v=${version}"`);
  fs.writeFileSync(file, html);
}
// Auch der Standardtext wird mit Version geladen
const api = path.join(out, 'demo', 'demo-api.js');
fs.writeFileSync(api, fs.readFileSync(api, 'utf8').replace('privacy-default.txt`', `privacy-default.txt?v=${version}\``));

console.log('Demo gebaut: docs/');
