# Kantinen-App · Schloss & Gut Liebenberg

Mitarbeitende buchen ihr Mittagessen am Tablet in der Kantine mit ihrem **Gastromatic-Terminal-Pin**. Gebucht wird nur, wer in Gastromatic aktiv ist und heute eingestempelt war. Mitarbeitende können **Gäste** eintragen (zahlende Firma, Gastname, Grund). Einmal im Monat geht automatisch eine **Excel-Datei** an HR für das Steuerbüro: ein Tabellenblatt pro Gesellschaft, ein Blatt für Gäste.

Grundlage: Lastenheft und Wireframes (Oktober 2026).

## Klick-Demo

Online ohne Server ausprobieren: **https://chrrex.github.io/kantine/** (gleiche Oberfläche, Testdaten nur im eigenen Browser, Gastromatic und Mailversand simuliert). Die Demo liegt in `docs/` und wird mit `npm run build:demo` aus `public/` und `demo/` neu gebaut.

## Bestandteile

| Bereich | Adresse | Wer |
| --- | --- | --- |
| Kantinen-Tablet | `/kiosk` (einmalig über den Freischalt-Link öffnen) | alle Mitarbeitenden |
| Verwaltung | `/admin` | HR und Direktion |

## Schnellstart (Testdaten)

Voraussetzung: **Node.js 22.13 oder neuer** (keine Datenbank-Installation, kein Docker nötig – die Daten liegen in einer SQLite-Datei unter `data/`).

```bash
npm install
cp .env.example .env      # Werte eintragen (APP_SECRET, KIOSK_KEY, ADMIN_EMAIL, ADMIN_PASSWORD)
npm start
```

Dann:

1. `http://localhost:3000/admin` öffnen und mit ADMIN_EMAIL / ADMIN_PASSWORD anmelden.
2. Unter **Settings** die Auswahllisten „Zahlende Firma“ und „Grund“ füllen und speichern.
3. Den **Freischalt-Link** (Settings → Tablet) im Browser öffnen: das ist die Kantinenansicht.

Test-Pins im Modus `GASTROMATIC_MODE=mock`:

| Pin | Ergebnis |
| --- | --- |
| 1111, 2222, 3333 | Essen wird gebucht |
| 4444 | nicht aktiv |
| 5555 | heute nicht eingestempelt |
| 6666 | Gastromatic nicht erreichbar → wird trotzdem gebucht, Vermerk „Stempelung nicht geprüft“ |
| 7777 | ausgeschieden |

## Ablauf am Tablet

1. Pin eingeben → Prüfung: Pin bekannt? Aktiv? Heute schon gegessen? Heute eingestempelt?
2. Erfolg: grüner Bildschirm mit Vorname und Ton. Fehler: roter Bildschirm mit Klartext und Fehlerton.
3. Nach 5 falschen Pins in Folge sperrt das Tablet für 1 Minute.
4. „Gäste einladen“: Pin → Firma, Grund (Liste oder „Sonstiges“ mit Freitext), ein oder mehrere Gäste. Das eigene Essen ist vorausgewählt und kann abgewählt werden.

## Gastromatic anbinden

1. In Gastromatic auf der API-Verwaltungsseite einen Zugang anlegen (Client ID + Client Secret) mit Lesezugriff auf Organisationen, Mitarbeiter und – falls angeboten – Stempelzeiten.
2. In der `.env` `GASTROMATIC_MODE=live` setzen und neu starten.
3. Im Admin unter **Settings → Gastromatic** Client ID und Secret eintragen, **Verbindung testen**, dann **Mitarbeiter jetzt abgleichen**.

Was die App abruft (nur lesend, nur diese Felder):

- `/organizations/` → Gesellschaften
- `/organizations/{id}/employees/` → id, Personalnummer, Name, `terminal_id` (Pin), `is_active`, Austritts-/Deaktivierungsdatum
- `/punch_times/` und `/actual_times/` für den heutigen Tag → „war eingestempelt“

Der Abgleich läuft jede Nacht ab 2 Uhr automatisch. Pins werden nur als Hash gespeichert.

**Beim ersten Live-Abgleich prüfen:** Steckt der Terminal-Pin wirklich im Feld `terminal_id`? Die Meldung nach dem Abgleich zeigt, wie viele Mitarbeitende einen Pin haben. Ist die Zahl 0, muss das Feld in `src/gastromatic.js` angepasst werden.

## Excel und Mailversand

- Versandtag (1.–28.) unter Settings. Die Datei enthält alles seit dem letzten Versand bis zum Vortag.
- Absender ist ein eigenes Postfach (SMTP, z. B. Microsoft 365: `smtp.office365.com`, Port 587). Mit **Testmail senden** prüfen.
- Schlägt der Versand fehl, versucht die App es stündlich erneut. Der Status steht im Admin.
- Jederzeit manuell: **Excel herunterladen** (frei wählbarer Zeitraum) oder **Jetzt versenden**.

## Datenschutz und Sicherheit

- Gespeichert: Gastromatic-ID, Personalnummer, Name, Gesellschaft, Pin-Hash, Aktiv-Status; Buchungen und Gästedaten. Keine Bank-, Steuer- oder Sozialversicherungsdaten.
- Buchungen, Gästedaten und Protokoll werden nach 12 Monaten automatisch gelöscht (einstellbar).
- Zugangsdaten (Gastromatic-Secret, Postfach-Passwort) liegen verschlüsselt in der Datenbank.
- Jede Stornierung, jeder Nachtrag und jede Änderung der Settings steht mit Name und Zeitpunkt im Protokoll.
- Datenschutzhinweise: am Tablet über den Button „Datenschutz“, in der Verwaltung über den Link „Datenschutz“. Der Text wird im Admin unter **Settings → Datenschutzhinweise** bearbeitet (mit Vorschau); der Standardtext liegt in `public/shared/privacy-default.txt` und ist ein Entwurf, der vor dem Start geprüft werden muss.
- Schriften werden lokal ausgeliefert (kein Abruf bei Google).
- Die `.env` und der Ordner `data/` gehören nie ins Repository (stehen in `.gitignore`).

## Updates und Freigaben

- Entwickelt wird auf dem Zweig `main`. Auf den Server kommt nur, was auf dem Zweig **`release`** liegt.
- Freigeben: `git push origin main:release` (nur nach erfolgreichen Tests).
- Der Server holt sich neue Versionen jede Nacht um 3:30 selbst (`deploy/kantine-update.timer` → `scripts/update.sh`, Windows: `scripts/update.ps1` über die Aufgabenplanung).
- Das Update-Skript sichert vorher die Datenbank (`/opt/kantine/backups`, 14 Stück), installiert, führt `npm test` aus, startet neu und prüft, ob die App antwortet. Schlägt etwas fehl, wird automatisch die vorherige Version wiederhergestellt.
- Von Hand: `sudo /opt/kantine/app/scripts/update.sh`; Protokoll: `journalctl -u kantine-update`.

## Betrieb

- Läuft auf jedem Server mit Node.js (Linux, Windows). Für den Dauerbetrieb z. B. mit `pm2` oder als systemd-Dienst starten.
- Für den Zugriff von außen einen Reverse Proxy mit HTTPS davorschalten, dann `COOKIE_SECURE=true` und `TRUST_PROXY=1` setzen.
- Sicherung: regelmäßig den Ordner `data/` sichern.
- Tests: `npm test`

## Aufbau

```
server.js              Einstieg, Sicherheits-Header
src/config.js          Konfiguration aus .env
src/db.js              SQLite-Schema, Settings
src/gastromatic.js     API-Client (live) und Testdaten (mock)
src/sync.js            Mitarbeiter-Abgleich
src/booking.js         Prüfungen und Buchungen am Tablet
src/excel.js           Excel-Datei
src/export.js          Monatsversand
src/scheduler.js       nächtlicher Abgleich, Versand, Löschfrist
src/auth.js            Admin-Login, Tablet-Freischaltung
src/routes-*.js        API
public/kiosk/          Tablet-Oberfläche
public/admin/          Verwaltung
```

## Offene Punkte

- Gastromatic-Zugang anlegen und Feld `terminal_id` beim ersten Abgleich prüfen
- Postfach kantine@… einrichten
- Hosting festlegen (Server bei SGL bzw. Stiftung oder externer Anbieter, Serverstandort Deutschland)
- Spaltenwünsche des Steuerbüros abgleichen
- Betriebsrat informieren
- Falls eine Person mehreren Gesellschaften mit demselben Pin zugeordnet ist, wird das Essen der Gesellschaft mit der kleineren Personalnummer zugeordnet – mit HR klären, ob das passt
- Später: Übernahme ins WIR-Portal
