'use strict';
/**
 * Baut die iPad-Version (ohne Server) nach dist-ipad/ und kopiert sie nach docs/ipad/.
 * Gleiche Oberfläche wie die App; statt Server läuft ipad/local-api.js im Browser.
 * Aufruf: npm run build:ipad
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-ipad');
const pub = path.join(root, 'public');
const src = path.join(root, 'ipad');
const read = (f) => fs.readFileSync(f, 'utf8');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const dir of ['shared', 'kiosk', 'admin']) fs.cpSync(path.join(pub, dir), path.join(out, dir), { recursive: true });
fs.rmSync(path.join(out, 'kiosk', 'sw.js'), { force: true });
fs.mkdirSync(path.join(out, 'ipad'), { recursive: true });
for (const f of ['local-api.js', 'local-admin.js', 'local-kiosk.js', 'local.css']) fs.copyFileSync(path.join(src, f), path.join(out, 'ipad', f));
fs.cpSync(path.join(src, 'assets'), path.join(out, 'ipad'), { recursive: true });
// Datenschutz-Standardtext ohne Gastromatic und Server
fs.copyFileSync(path.join(src, 'privacy-default.txt'), path.join(out, 'shared', 'privacy-default.txt'));
fs.copyFileSync(require.resolve('exceljs/dist/exceljs.min.js'), path.join(out, 'ipad', 'exceljs.min.js'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

function rewrite(file, own, extraHead, extraScripts, inserts = {}) {
  let html = read(file)
    .replaceAll('href="/shared/', 'href="../shared/')
    .replaceAll('src="/shared/', 'src="../shared/')
    .replaceAll(`href="/${own}/`, 'href="./')
    .replaceAll(`src="/${own}/`, 'src="./')
    .replace(/\s*<link rel="manifest"[^>]*>/, '');
  html = html.replace('</head>', `${extraHead}\n</head>`);
  html = html.replace(new RegExp(`<script src="\\./${own}\\.js"></script>`), (m) => `${extraScripts}\n${m}`);
  for (const [marker, content] of Object.entries(inserts)) {
    if (!html.includes(marker)) throw new Error(`Marker fehlt: ${marker}`);
    html = html.replace(marker, content);
  }
  fs.writeFileSync(file, html);
}

const head = [
  '<link rel="stylesheet" href="../ipad/local.css">',
  '<link rel="apple-touch-icon" href="../ipad/apple-touch-icon.png">',
  '<meta name="apple-mobile-web-app-title" content="Kantine">',
].join('\n');
rewrite(path.join(out, 'kiosk', 'index.html'), 'kiosk',
  `${head}\n<link rel="manifest" href="./manifest.webmanifest">`,
  '<script src="../ipad/local-api.js"></script>\n<script src="../ipad/local-kiosk.js"></script>');
rewrite(path.join(out, 'admin', 'index.html'), 'admin', head,
  '<script src="../ipad/local-api.js"></script>\n<script src="../ipad/local-admin.js"></script>', {
    '<!-- local-export -->': read(path.join(src, 'admin-export.html')).trim(),
    '<!-- local-settings -->': read(path.join(src, 'admin-settings.html')).trim(),
    '<script src="../shared/privacy-render.js"></script>': `${read(path.join(src, 'admin-dialogs.html')).trim()}\n\n<script src="../shared/privacy-render.js"></script>`,
  });
fs.writeFileSync(path.join(out, 'admin', 'index.html'), read(path.join(out, 'admin', 'index.html'))
  .replaceAll('href="/shared/datenschutz.html"', 'href="../shared/datenschutz.html"')
  .replace('<title>Kantine · Verwaltung</title>', '<title>Kantine · Verwaltung (iPad)</title>'));

const privacy = path.join(out, 'shared', 'datenschutz.html');
fs.writeFileSync(privacy, read(privacy)
  .replaceAll('href="/shared/', 'href="./')
  .replace('<script src="/shared/privacy-render.js"></script>', '<script src="../ipad/local-api.js"></script>\n<script src="./privacy-render.js"></script>')
  .replace('<script src="/shared/datenschutz.js"></script>', '<script src="./datenschutz.js"></script>'));
const fontsCss = path.join(out, 'shared', 'fonts.css');
fs.writeFileSync(fontsCss, read(fontsCss).replaceAll("url('/shared/fonts/", "url('fonts/"));

fs.writeFileSync(path.join(out, 'kiosk', 'manifest.webmanifest'), JSON.stringify({
  name: 'Kantine Liebenberg', short_name: 'Kantine', start_url: './', scope: '../', display: 'fullscreen', orientation: 'landscape',
  background_color: '#F5F5F0', theme_color: '#6B7A3E',
  icons: [{ src: '../ipad/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }, { src: '../ipad/icon-512.png', sizes: '512x512', type: 'image/png' }],
}, null, 2));
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kantine Liebenberg</title><meta http-equiv="refresh" content="0; url=./kiosk/"></head>
<body><p><a href="./kiosk/">Zur Kantine</a></p></body></html>
`);

// Service Worker mit Liste aller Dateien
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (!e.name.startsWith('.') && !e.name.endsWith('.txt') || e.name === 'privacy-default.txt') files.push(path.relative(out, p).split(path.sep).join('/'));
  }
})(out);
const list = ['./', './kiosk/', './admin/', ...files.filter((f) => !/LICENSE/.test(f)).map((f) => `./${f}`)];
const version = Date.now().toString(36);
fs.writeFileSync(path.join(out, 'sw.js'), read(path.join(src, 'sw.js')).replace('__VERSION__', version).replace('__FILES__', JSON.stringify(list, null, 0)));

// Kopie für GitHub Pages
const docs = path.join(root, 'docs', 'ipad');
fs.rmSync(docs, { recursive: true, force: true });
fs.cpSync(out, docs, { recursive: true });
console.log(`iPad-Version gebaut: dist-ipad/ und docs/ipad/ (${list.length} Dateien, Version ${version})`);
