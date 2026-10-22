# Kantinen-App: neue freigegebene Version einspielen (Windows Server).
#
# Gleicher Ablauf wie scripts/update.sh: Zweig "release" holen, Datenbank sichern,
# Pakete installieren, Tests ausführen, Dienst neu starten, Antwort prüfen.
# Bei einem Fehler wird automatisch die vorherige Version wiederhergestellt.
#
# Nachts über die Aufgabenplanung starten (als Konto mit Rechten auf den Dienst):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\kantine\app\scripts\update.ps1
param(
  [string]$AppDir = 'C:\kantine\app',
  [string]$Service = 'Kantine',
  [string]$Branch = 'release',
  [string]$BackupDir = 'C:\kantine\backups',
  [int]$KeepBackups = 14,
  [int]$HealthTimeout = 40
)
$ErrorActionPreference = 'Stop'
$LogFile = Join-Path $AppDir '..\update.log'

function Log($msg) {
  $line = "[kantine-update] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Output $line
  Add-Content -Path $LogFile -Value $line
}
function Run($exe, [string[]]$argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argList -join ' ') fehlgeschlagen (Code $LASTEXITCODE)" }
}

Set-Location $AppDir
Run git @('fetch', '--quiet', 'origin', $Branch)
$old = (git rev-parse HEAD).Trim()
$new = (git rev-parse "origin/$Branch").Trim()

if ($old -eq $new) { Log "Keine neue Version ($($old.Substring(0,7)))."; exit 0 }
if ((git status --porcelain --untracked-files=no)) {
  Log 'ABBRUCH: Programmdateien wurden auf dem Server geändert. Bitte prüfen (git status).'; exit 1
}
Log "Neue Version gefunden: $($old.Substring(0,7)) -> $($new.Substring(0,7))"

# 1. Datenbank sichern
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$backup = Join-Path $BackupDir ("kantine-{0}-{1}.db" -f (Get-Date -Format 'yyyy-MM-dd-HHmm'), $old.Substring(0,7))
Run node @('--disable-warning=ExperimentalWarning', 'scripts/backup-db.js', $backup)
Get-ChildItem $BackupDir -Filter 'kantine-*.db' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepBackups | Remove-Item -Force

function Rollback($reason) {
  Log "FEHLER: $reason - stelle Version $($old.Substring(0,7)) wieder her."
  git reset --quiet --hard $old
  npm.cmd ci --omit=dev --no-audit --no-fund --silent
  Restart-Service -Name $Service -ErrorAction SilentlyContinue
  Log "Vorherige Version ist wieder aktiv. Sicherung: $backup"
  exit 1
}

# 2. Neue Version und Pakete
try {
  Run git @('reset', '--quiet', '--hard', $new)
  Run npm.cmd @('ci', '--omit=dev', '--no-audit', '--no-fund', '--silent')
} catch { Rollback "Installation fehlgeschlagen: $_" }

# 3. Tests
$ErrorActionPreference = 'Continue'   # npm schreibt Hinweise auf stderr; das ist kein Fehler
& npm.cmd test --silent *> (Join-Path $env:TEMP 'kantine-update-tests.log')
$testCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($testCode -ne 0) { Get-Content (Join-Path $env:TEMP 'kantine-update-tests.log') -Tail 40; Rollback 'Tests fehlgeschlagen' }
Log 'Tests bestanden.'

# 4. Neustart und Prüfung
try { Restart-Service -Name $Service } catch { Rollback "Neustart fehlgeschlagen: $_" }
$port = 3000
$envLine = Get-Content (Join-Path $AppDir '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^PORT=' } | Select-Object -Last 1
if ($envLine) { $port = [int]($envLine -replace '^PORT=', '').Trim('" ') }
$ok = $false
for ($i = 0; $i -lt $HealthTimeout; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$port/api/privacy" | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 1 }
}
if (-not $ok) { Rollback 'App antwortet nach dem Neustart nicht' }
Log "Update erfolgreich: Version $($new.Substring(0,7)) läuft."
