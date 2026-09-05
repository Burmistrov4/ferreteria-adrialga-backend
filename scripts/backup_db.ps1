<#
.SYNOPSIS
  Respaldo de la base de datos MySQL de Adrialga (Fase 6 - Producción).
.DESCRIPTION
  Lee DATABASE_URL desde el .env del backend, ejecuta mysqldump y comprime
  el volcado con gzip (via .NET). Retiene los últimos 30 respaldos.
  Programar en Task Scheduler: powershell -ExecutionPolicy Bypass -File backup_db.ps1
#>
param(
    [string]$BackendDir = (Split-Path -Parent $PSScriptRoot),
    [int]$RetencionDias = 30
)

$ErrorActionPreference = 'Stop'

# ── 1. Cargar DATABASE_URL del .env ──
$envFile = Join-Path $BackendDir '.env'
if (-not (Test-Path $envFile)) { throw ".env no encontrado: $envFile" }
$dbUrl = (Select-String -LiteralPath $envFile -Pattern '^DATABASE_URL=(.+)$').Matches[0].Groups[1].Value.Trim()

# mysql://usuario:password@host:puerto/basedatos
if ($dbUrl -notmatch '^mysql://([^:]+):([^@]*)@([^:/]+):?(\d+)?/(.+)$') {
    throw "DATABASE_URL con formato inesperado"
}
$usuario = $Matches[1]; $password = $Matches[2]; $hostDb = $Matches[3]
$puerto = if ($Matches[4]) { $Matches[4] } else { '3306' }
$baseDatos = $Matches[5]

# ── 2. Localizar mysqldump ──
$mysqldump = (Get-Command mysqldump -ErrorAction SilentlyContinue).Source
if (-not $mysqldump) {
    $candidatos = @(
        'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe',
        'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe',
        'C:\xampp\mysql\bin\mysqldump.exe'
    )
    $mysqldump = $candidatos | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $mysqldump) { throw 'mysqldump.exe no encontrado en PATH ni rutas estándar' }

# ── 3. Ejecutar el volcado ──
$backupDir = Join-Path $BackendDir 'backups'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$sqlPath = Join-Path $backupDir "adrialga_$stamp.sql"
$gzPath  = "$sqlPath.gz"

$env:MYSQL_PWD = $password   # evita advertencia de password en línea de comandos
& $mysqldump --host=$hostDb --port=$puerto --user=$usuario `
    --single-transaction --routines --triggers --set-gtid-purged=OFF `
    --result-file="$sqlPath" $baseDatos
if ($LASTEXITCODE -ne 0) { throw "mysqldump falló con código $LASTEXITCODE" }
Remove-Item Env:\MYSQL_PWD

# ── 4. Comprimir (gzip) ──
$inFs = [System.IO.File]::OpenRead($sqlPath)
$outFs = [System.IO.File]::Create($gzPath)
$gz = New-Object System.IO.Compression.GZipStream($outFs, [System.IO.Compression.CompressionLevel]::Optimal)
$inFs.CopyTo($gz); $gz.Dispose(); $inFs.Dispose(); $outFs.Dispose()
Remove-Item $sqlPath

# ── 5. Retención: eliminar respaldos antiguos ──
Get-ChildItem $backupDir -Filter 'adrialga_*.sql.gz' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetencionDias) } |
    Remove-Item -Force

Write-Host "OK Respaldo creado: $gzPath ($([math]::Round((Get-Item $gzPath).Length/1KB,1)) KB)"
