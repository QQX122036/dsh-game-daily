# zzz-server.ps1 - manage ZenlessZoneZero-OneDragon backend (start / stop / status)
# ASCII only on purpose: PowerShell 5.1 would misread a BOM-less UTF-8 file whose text is non-ASCII.
param(
  [ValidateSet('status', 'start', 'stop')][string]$Action = 'status',
  [string]$Root = $(if ($env:ZZZ_OD_ROOT) { $env:ZZZ_OD_ROOT } else { 'D:\software\ZenlessZoneZero-OneDragon' }),
  [int]$Port = $(if ($env:ZZZ_OD_PORT) { [int]$env:ZZZ_OD_PORT } else { 23001 }),
  [int]$WaitSeconds = 40,
  [string]$ResultPath = '',
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$healthUrl = "http://127.0.0.1:$Port/health"

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  if ($ResultPath) {
    $dir = Split-Path -Parent $ResultPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  }
  Write-Output $json
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$isAdmin = Test-Admin

# status never needs elevation
if ($Action -eq 'status') {
  Write-Result ([ordered]@{ ok = (Test-Health); action = 'status'; admin = $isAdmin; root = $Root; url = $healthUrl })
  exit 0
}

# start / stop may need admin (game runs as admin; window switch / process kill require the same level)
if (-not $isAdmin -and -not $Elevated) {
  if (-not $ResultPath) {
    $ResultPath = Join-Path (Join-Path $Root '.debug') ("mcp-server-" + $Action + "-" + [guid]::NewGuid().ToString('N') + ".json")
  }
  if (Test-Path $ResultPath) { Remove-Item $ResultPath -Force -ErrorAction SilentlyContinue }
  $scriptPath = $PSCommandPath
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`"", '-Action', $Action, '-Root', "`"$Root`"", '-Port', "$Port", '-WaitSeconds', "$WaitSeconds", '-Elevated', '-ResultPath', "`"$ResultPath`"")
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -Wait | Out-Null
  } catch {
    Write-Result ([ordered]@{ ok = $false; action = $Action; error = 'elevation denied: ' + $_.Exception.Message })
    exit 1
  }
  $limit = (Get-Date).AddSeconds($WaitSeconds + 90)
  while ((Get-Date) -lt $limit) {
    if (Test-Path $ResultPath) {
      $text = [System.IO.File]::ReadAllText($ResultPath)
      if ($text -and $text.Trim().Length -gt 0) { Write-Output $text; exit 0 }
    }
    Start-Sleep -Milliseconds 400
  }
  Write-Result ([ordered]@{ ok = $false; action = $Action; error = 'elevated run did not write a result in time'; resultPath = $ResultPath })
  exit 1
}

# elevated branch
$debugDir = Join-Path $Root '.debug'
if (-not (Test-Path $debugDir)) { New-Item -ItemType Directory -Path $debugDir -Force | Out-Null }

if ($Action -eq 'stop') {
  $killed = @()
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*zzz_od.backend*' }
    foreach ($p in $procs) {
      try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed += $p.ProcessId } catch { }
    }
  } catch { }
  $limit = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $limit -and (Test-Health)) { Start-Sleep -Milliseconds 500 }
  Write-Result ([ordered]@{ ok = (-not (Test-Health)); action = 'stop'; admin = $isAdmin; killed = $killed; url = $healthUrl })
  exit 0
}

# start
if (Test-Health) {
  Write-Result ([ordered]@{ ok = $true; action = 'start'; admin = $isAdmin; alreadyRunning = $true; url = $healthUrl })
  exit 0
}
$python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
  Write-Result ([ordered]@{ ok = $false; action = 'start'; admin = $isAdmin; error = "python not found: $python"; root = $Root })
  exit 1
}
$env:PYTHONPATH = (Join-Path $Root 'src')
$outLog = Join-Path $debugDir 'python-out.log'
$errLog = Join-Path $debugDir 'python-err.log'
foreach ($f in @($outLog, $errLog)) {
  if (Test-Path $f) {
    try { Move-Item -Path $f -Destination ($f + '.1') -Force } catch { }
  }
}
$proc = Start-Process -FilePath $python -ArgumentList @('-m', 'zzz_od.backend') -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
$limit = (Get-Date).AddSeconds($WaitSeconds)
$ready = $false
while ((Get-Date) -lt $limit) {
  Start-Sleep -Milliseconds 500
  if (Test-Health) { $ready = $true; break }
  if ($proc.HasExited) { break }
}
Write-Result ([ordered]@{ ok = $ready; action = 'start'; admin = $isAdmin; pid = $proc.Id; exited = $proc.HasExited; url = $healthUrl; outLog = $outLog; errLog = $errLog })
if ($ready) { exit 0 } else { exit 1 }
