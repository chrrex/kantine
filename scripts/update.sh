#!/usr/bin/env bash
# Kantinen-App: neue freigegebene Version einspielen (Linux).
#
# Holt den Zweig "release" von GitHub. Gibt es eine neue Version:
#   1. Datenbank sichern
#   2. neue Version auschecken und Pakete installieren
#   3. automatische Tests ausführen
#   4. Dienst neu starten und prüfen, ob die App antwortet
# Schlägt Schritt 2–4 fehl, wird automatisch die vorherige Version wiederhergestellt.
#
# Läuft nachts über den systemd-Timer "kantine-update" (als root) oder von Hand:
#   sudo /opt/kantine/app/scripts/update.sh
#
# Einstellungen (optional) in /etc/default/kantine-update:
#   APP_DIR, APP_USER, SERVICE, BRANCH, BACKUP_DIR, KEEP_BACKUPS
set -euo pipefail

[ -f /etc/default/kantine-update ] && . /etc/default/kantine-update

APP_DIR="${APP_DIR:-/opt/kantine/app}"
APP_USER="${APP_USER:-kantine}"
SERVICE="${SERVICE:-kantine}"
BRANCH="${BRANCH:-release}"
BACKUP_DIR="${BACKUP_DIR:-/opt/kantine/backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-14}"
RESTART_CMD="${RESTART_CMD:-systemctl restart $SERVICE}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-40}"

log() { echo "[kantine-update] $(date '+%F %T') $*"; }

# Befehle als App-Benutzer ausführen (nie als root an den Programmdateien arbeiten)
as_app() {
  if [ "$(id -u)" -eq 0 ] && [ "$(id -un)" != "$APP_USER" ]; then
    runuser -u "$APP_USER" -- env HOME="$(getent passwd "$APP_USER" | cut -d: -f6)" "$@"
  else
    "$@"
  fi
}

cd "$APP_DIR"

as_app git fetch --quiet origin "$BRANCH"
OLD="$(as_app git rev-parse HEAD)"
NEW="$(as_app git rev-parse "origin/$BRANCH")"

if [ "$OLD" = "$NEW" ]; then
  log "Keine neue Version (${OLD:0:7})."
  exit 0
fi

if [ -n "$(as_app git status --porcelain --untracked-files=no)" ]; then
  log "ABBRUCH: Programmdateien wurden auf dem Server geändert. Bitte prüfen (git status)."
  exit 1
fi

log "Neue Version gefunden: ${OLD:0:7} -> ${NEW:0:7}"
as_app git log --oneline "$OLD..$NEW" | sed 's/^/    /' || true

# 1. Datenbank sichern
mkdir -p "$BACKUP_DIR"
chown "$APP_USER" "$BACKUP_DIR" 2>/dev/null || true
chmod 700 "$BACKUP_DIR" 2>/dev/null || true
BACKUP_FILE="$BACKUP_DIR/kantine-$(date +%F-%H%M)-${OLD:0:7}.db"
as_app node --disable-warning=ExperimentalWarning scripts/backup-db.js "$BACKUP_FILE"
# alte Sicherungen aufräumen
ls -1t "$BACKUP_DIR"/kantine-*.db 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f

rollback() {
  log "FEHLER: $1 – stelle Version ${OLD:0:7} wieder her."
  as_app git reset --quiet --hard "$OLD"
  as_app npm ci --omit=dev --no-audit --no-fund --silent
  $RESTART_CMD || true
  log "Vorherige Version ${OLD:0:7} ist wieder aktiv. Sicherung: $BACKUP_FILE"
  exit 1
}

# 2. Neue Version auschecken und Pakete installieren
as_app git reset --quiet --hard "$NEW"
as_app npm ci --omit=dev --no-audit --no-fund --silent || rollback "Pakete konnten nicht installiert werden"

# 3. Automatische Tests (laufen mit eigener Testdatenbank, echte Daten bleiben unberührt)
as_app npm test --silent >/tmp/kantine-update-tests.log 2>&1 || { tail -n 40 /tmp/kantine-update-tests.log; rollback "Tests fehlgeschlagen"; }
log "Tests bestanden."

# 4. Neu starten und prüfen
$RESTART_CMD || rollback "Neustart fehlgeschlagen"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2 | tr -d '[:space:]"' || true)"
PORT="${PORT:-3000}"
ok=0
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/privacy"; then ok=1; break; fi
  sleep 1
done
[ "$ok" -eq 1 ] || rollback "App antwortet nach dem Neustart nicht"

log "Update erfolgreich: Version ${NEW:0:7} läuft."
