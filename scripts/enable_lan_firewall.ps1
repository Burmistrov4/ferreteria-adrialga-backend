# Habilita acceso SOLO a Adrialga TCP/3000 desde la subred LAN DETECTADA.
# Ejecutar manualmente desde PowerShell como Administrador en una red de confianza.
# No abre el scraper 8000, no usa Any/Internet y no configura port-forwarding.
#
# Mejora Ciclo 3: la IP y la subred se DETECTAN de la interfaz IPv4 activa en
# lugar de estar hardcodeadas, para no romper la regla si el DHCP reasigna la IP
# (el megaprompt prohíbe asumir que una IP histórica sigue asignada).
$ErrorActionPreference = 'Stop'

$ruleName = 'Adrialga-Local-LAN-3000'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'Abre PowerShell con Ejecutar como administrador y vuelve a correr este script.'
  exit 1
}

# Detectar la interfaz LAN activa: IPv4 Preferred, no loopback, no APIPA 169.254.*.
$candidatas = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*' }

if ($candidatas.Count -eq 0) {
  Write-Error 'No se detectó una IP privada activa con estado Preferred. Conéctate a la red de confianza y reintenta.'
  exit 1
}

Write-Host 'Interfaces IPv4 activas detectadas (no loopback, no APIPA):'
$candidatas | Select-Object InterfaceAlias, IPAddress, PrefixLength | Format-Table -AutoSize

# Preferir una IP de red privada RFC1918; si no hay, usar la primera detectada.
$sel = $candidatas | Where-Object { $_.IPAddress -match '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' } | Select-Object -First 1
if (-not $sel) { $sel = $candidatas | Select-Object -First 1 }

$localIp = $sel.IPAddress
$interfaceAlias = $sel.InterfaceAlias

# Subred /24 derivada del tercer octeto (LAN doméstica/oficina típica).
$octetos = $localIp.Split('.')
$remoteSubnet = "$($octetos[0]).$($octetos[1]).$($octetos[2]).0/24"

$profileObj = Get-NetConnectionProfile -InterfaceAlias $interfaceAlias -ErrorAction SilentlyContinue
$profile = if ($profileObj) { $profileObj.NetworkCategory } else { 'Public' }

Write-Host "Interfaz: $interfaceAlias"
Write-Host "Perfil de Windows: $profile"
Write-Host "Host local: $localIp"
Write-Host "Dispositivos permitidos por IP: $remoteSubnet"
Write-Host 'Puerto abierto: TCP/3000 unicamente'
if ($profile -eq 'Public') {
  Write-Warning 'Windows clasifica esta red como PUBLIC. Solo continua si controlas y confias en todos los dispositivos de esa subred.'
  $confirm = Read-Host "Para abrir TCP/3000 solo a $remoteSubnet, escribe ABRIR-$remoteSubnet"
  if ($confirm -ne "ABRIR-$remoteSubnet") {
    Write-Host 'Cancelado; no se modifico el Firewall.'
    exit 2
  }
} else {
  $confirm = Read-Host "Confirma que esta es tu LAN de confianza escribiendo ABRIR-$remoteSubnet"
  if ($confirm -ne "ABRIR-$remoteSubnet") {
    Write-Host 'Cancelado; no se modifico el Firewall.'
    exit 2
  }
}

$existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "La regla $ruleName ya existe; no se duplico ni se modifico."
  $existing | Select-Object Name, Enabled, Profile, Direction, Action | Format-List
  exit 0
}

New-NetFirewallRule -Name $ruleName -DisplayName 'Adrialga Local LAN TCP 3000 (scoped subnet)' -Direction Inbound -Action Allow -Enabled True -Protocol TCP -LocalPort 3000 -LocalAddress $localIp -RemoteAddress $remoteSubnet -Profile $profile -EdgeTraversalPolicy Block | Out-Null

Write-Host 'FIREWALL_RULE=CREATED'
Get-NetFirewallRule -Name $ruleName | Select-Object Name, Enabled, Profile, Direction, Action | Format-List
Get-NetFirewallRule -Name $ruleName | Get-NetFirewallAddressFilter | Select-Object LocalAddress, RemoteAddress | Format-List
Get-NetFirewallRule -Name $ruleName | Get-NetFirewallPortFilter | Select-Object Protocol, LocalPort | Format-List
Write-Host "Para revertir, desde PowerShell Administrador: Remove-NetFirewallRule -Name '$ruleName'"
