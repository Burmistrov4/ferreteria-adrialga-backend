# Script de migración Prisma → Railway DB
# Uso: .\scripts\migrate-railway.ps1

# Obtén la URL pública de Railway desde:
# Railway → Proyecto → Variables → DATABASE_URL (copia el valor)
# O usa: railway variables --json

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabaseUrl
)

Write-Host "=== Migrando schema a Railway DB ===" -ForegroundColor Cyan
Write-Host "Destino: $($DatabaseUrl -replace 'mysql://[^@]+@','mysql://***@')" -ForegroundColor Gray

# 1. Push del schema
Write-Host "`n[1/3] Aplicando schema (prisma db push)..." -ForegroundColor Yellow
$env:DATABASE_URL = $DatabaseUrl
npx prisma db push --skip-generate

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: prisma db push falló. Verifica la URL y credenciales." -ForegroundColor Red
    exit 1
}

# 2. Generate del cliente
Write-Host "`n[2/3] Generando Prisma Client..." -ForegroundColor Yellow
npx prisma generate

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: prisma generate falló." -ForegroundColor Red
    exit 1
}

# 3. Semilla: tasa BCV inicial (si la tabla está vacía)
Write-Host "`n[3/3] Verificando semilla de tasa BCV..." -ForegroundColor Yellow
$checkQuery = "SELECT COUNT(*) as total FROM tasas_bcv;"
$result = mysql -h $($DatabaseUrl -replace '.*@([^/]+)/.*','$1') `
    -u $($DatabaseUrl -replace 'mysql://([^:]+):.*','$1') `
    -p$($DatabaseUrl -replace 'mysql://[^:]+:([^@]+)@.*','$1') `
    -e $checkQuery 2>$null

if ($result -and $result[1] -eq "0") {
    Write-Host "Tasas BCV vacía. Insertando tasa inicial desde facturas..."
    $seedQuery = @"
INSERT INTO tasas_bcv (Fecha, Tasa, Origen)
SELECT CURDATE(), MAX(Tasa_Cambio), 'Migracion inicial (ultima tasa facturada)'
FROM facturas
WHERE Tasa_Cambio > 1
ON DUPLICATE KEY UPDATE Tasa = VALUES(Tasa);
"@
    mysql -h $($DatabaseUrl -replace '.*@([^/]+)/.*','$1') `
        -u $($DatabaseUrl -replace 'mysql://([^:]+):.*','$1') `
        -p$($DatabaseUrl -replace 'mysql://[^:]+:([^@]+)@.*','$1') `
        -e $seedQuery 2>$null
}

Write-Host "`n=== Migración completada exitosamente ===" -ForegroundColor Green
Write-Host "Tablas aplicadas:" -ForegroundColor Cyan
Write-Host "  - caja (Estado, Fecha_Cierre)" -ForegroundColor Gray
Write-Host "  - movimientos_caja" -ForegroundColor Gray
Write-Host "  - tasas_bcv" -ForegroundColor Gray
Write-Host "  - contadores_fiscales" -ForegroundColor Gray
Write-Host "  - (y todas las demás del schema)" -ForegroundColor Gray