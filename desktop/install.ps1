# Installs or updates the Sandbox desktop app on Windows and opens it. Run it again to update. No admin rights needed.
#   irm https://raw.githubusercontent.com/theolundqvist/sandbox/master/desktop/install.ps1 | iex
# With an invite link:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/theolundqvist/sandbox/master/desktop/install.ps1))) '<invite link>'
# One script block, so nothing it sets stays behind in the PowerShell window that ran it.
& {
$ErrorActionPreference = 'Stop'
# Windows PowerShell draws a progress bar so slowly that it multiplies the download time.
$ProgressPreference = 'SilentlyContinue'

$release = if ($env:SANDBOX_RELEASE) { $env:SANDBOX_RELEASE } else { 'https://github.com/theolundqvist/sandbox/releases/latest/download' }
$dir = Join-Path $env:LOCALAPPDATA 'Programs\Sandbox'
$data = Join-Path $env:APPDATA 'Sandbox'
$log = Join-Path $data 'app.log'
# Next to the app, so the new copy moves into place without crossing drives.
$tmp = "$dir.download"
$old = "$dir.old"

$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -eq 'ARM64' -and [Environment]::OSVersion.Version.Build -lt 22000) { throw 'Sandbox needs Windows 11 on an ARM computer, which runs its x64 build.' }

foreach ($leftover in $tmp, $old) { if (Test-Path $leftover) { Remove-Item -Recurse -Force $leftover } }
New-Item -ItemType Directory -Force -Path $tmp, $data | Out-Null
try {
  $zip = Join-Path $tmp 'Sandbox-win-x64.zip'
  Write-Host 'Downloading Sandbox-win-x64.zip'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$release/Sandbox-win-x64.zip" -OutFile $zip
  } catch {
    throw 'The download failed. Check your connection, then update again.'
  }
  $new = Join-Path $tmp 'Sandbox'
  New-Item -ItemType Directory -Force -Path $new | Out-Null
  tar.exe -xf $zip -C $new
  if ($LASTEXITCODE) { throw 'The download was damaged. Run this again.' }
  if (-not (Test-Path (Join-Path $new 'Sandbox.exe'))) { throw 'The download holds no Sandbox.exe. Run this again.' }

  # When the app updates itself it runs this and waits for the download, then quits on this line.
  if ($env:SANDBOX_APP_PID) {
    Write-Host 'Quit Sandbox to continue.'
    Wait-Process -Id $env:SANDBOX_APP_PID -ErrorAction SilentlyContinue
  }
  # Windows can't replace a program while it runs: the app, or the game server it started.
  $running = { Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith("$dir\", [StringComparison]::OrdinalIgnoreCase) } }
  if (& $running) {
    Write-Host 'Quit Sandbox to continue.'
    while (& $running) { Start-Sleep -Milliseconds 500 }
  }
  # Moved aside first, so a file Windows still holds for a moment never leaves half an app.
  if (Test-Path $dir) {
    for ($i = 0; ; $i++) {
      try { Move-Item $dir $old; break } catch { if ($i -ge 20) { throw } Start-Sleep -Milliseconds 500 }
    }
  }
  Move-Item $new $dir
  if (Test-Path $old) { Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue }
  Write-Host "Installed to $dir"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$exe = Join-Path $dir 'Sandbox.exe'
$shell = New-Object -ComObject WScript.Shell
foreach ($place in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) {
  $link = $shell.CreateShortcut((Join-Path $place 'Sandbox.lnk'))
  $link.TargetPath = $exe
  $link.WorkingDirectory = $dir
  $link.Save()
}
# `sandbox` in a new terminal opens it, with or without a link.
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($path -split ';') -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', $(if ($path) { "$path;$dir" } else { $dir }), 'User') }

# Start-Process starts both logs afresh, so everything in them is from this start.
$open = @{ FilePath = $exe; RedirectStandardOutput = $log; RedirectStandardError = "$log.err" }
if ($args.Count) { $open.ArgumentList = $args }
Start-Process @open
for ($i = 0; $i -lt 80; $i++) {
  Start-Sleep -Milliseconds 250
  $said = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($said -match 'Sandbox is open') { Write-Host 'Sandbox is open. Next time, open it from the Start menu or the desktop.'; return }
  if ($said -match 'Sandbox is already open') { Write-Host 'Sandbox was already open; quit it and open it again to use this version.'; return }
}
if (Test-Path "$log.err") { Get-Content "$log.err" -Tail 20 }
throw "Sandbox didn't open. The lines above are the end of $log.err."
} @args
