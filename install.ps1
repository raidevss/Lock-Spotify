# Lock Spotify installer / updater
# Installs Spotify (desktop version) + Spicetify if needed, then installs or updates the Volume Lock extension.
# Safe to run again at any time: it only does what is missing and always pulls the latest Volume Lock.
#
#   Run:  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/raidevss/Lock-Spotify/main/install.ps1 | iex"

function Install-LockSpotify {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # makes Invoke-WebRequest much faster on PowerShell 5.1
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repoRaw = 'https://raw.githubusercontent.com/raidevss/Lock-Spotify/main'
  $spotifyExe = Join-Path $env:APPDATA 'Spotify\Spotify.exe'
  $spotifyPrefs = Join-Path $env:APPDATA 'Spotify\prefs'
  $spicetifyDir = Join-Path $env:LOCALAPPDATA 'spicetify'
  $spicetify = Join-Path $spicetifyDir 'spicetify.exe'

  function Step($text) { Write-Host "`n> $text" -ForegroundColor Cyan }
  function Ok($text) { Write-Host "  $text" -ForegroundColor Green }
  # Closes Spotify the normal way first so it saves its data to disk (the Volume Lock
  # password and locked/unlocked state live there). Force-closes only if it won't quit.
  function Close-Spotify {
    if (-not (Get-Process Spotify -ErrorAction SilentlyContinue)) { return }
    & taskkill.exe /IM Spotify.exe 2>&1 | Out-Null
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Process Spotify -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Get-Process Spotify -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
  }
  # Runs spicetify, shows its output, returns only the exit code.
  function Run-Spicetify {
    & $spicetify @args | Out-Host
    return $LASTEXITCODE
  }

  # --- 0. Must run as the normal user (Spicetify refuses to run elevated) ---
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this as the normal Windows user (not "Run as administrator").'
  }

  # --- 1. Microsoft Store Spotify can't be modded: replace it with the desktop version ---
  $storeSpotify = Get-AppxPackage -Name 'SpotifyAB.SpotifyMusic' -ErrorAction SilentlyContinue
  if ($storeSpotify) {
    Step 'Removing the Microsoft Store version of Spotify (it cannot be locked)'
    Get-Process Spotify -ErrorAction SilentlyContinue | Stop-Process -Force
    $storeSpotify | Remove-AppxPackage
    Ok 'Removed'
  }

  # --- 2. Desktop Spotify ---
  if (-not (Test-Path $spotifyExe)) {
    Step 'Installing Spotify'
    $setup = Join-Path $env:TEMP 'SpotifySetup.exe'
    Invoke-WebRequest -UseBasicParsing 'https://download.scdn.co/SpotifySetup.exe' -OutFile $setup
    Start-Process $setup -ArgumentList '/silent' -Wait
    Remove-Item $setup -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $spotifyExe)) { throw 'Spotify did not install. Install it from spotify.com/download and run this again.' }
    Ok 'Spotify installed'
  }
  # Spicetify needs the prefs file, which Spotify creates on its first launch.
  if (-not (Test-Path $spotifyPrefs)) {
    Step 'Starting Spotify once to finish its setup'
    if (-not (Get-Process Spotify -ErrorAction SilentlyContinue)) { Start-Process $spotifyExe }
    $deadline = (Get-Date).AddMinutes(2)
    while (-not (Test-Path $spotifyPrefs) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
    if (-not (Test-Path $spotifyPrefs)) { throw 'Spotify did not finish starting. Open Spotify once, then run this again.' }
    Start-Sleep -Seconds 3
    Ok 'Spotify ready'
  }

  # --- 3. Spicetify ---
  if (-not (Test-Path $spicetify)) {
    Step 'Installing Spicetify'
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { 'x32' } }
    $release = Invoke-RestMethod 'https://api.github.com/repos/spicetify/cli/releases/latest'
    $version = $release.tag_name -replace '^v', ''
    $zip = Join-Path $env:TEMP 'spicetify.zip'
    Invoke-WebRequest -UseBasicParsing "https://github.com/spicetify/cli/releases/download/v$version/spicetify-$version-windows-$arch.zip" -OutFile $zip
    New-Item -ItemType Directory -Force $spicetifyDir | Out-Null
    Expand-Archive $zip -DestinationPath $spicetifyDir -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if ($userPath -notlike "*$spicetifyDir*") {
      [Environment]::SetEnvironmentVariable('PATH', "$userPath;$spicetifyDir", 'User')
    }
    Ok "Spicetify v$version installed"
  }
  Run-Spicetify -q config | Out-Null # first run creates Spicetify's config file

  # --- 4. Volume Lock extension (always the latest from GitHub) ---
  Step 'Downloading the latest Volume Lock'
  $userData = (& $spicetify path userdata).Trim()
  $extDir = Join-Path $userData 'Extensions'
  New-Item -ItemType Directory -Force $extDir | Out-Null
  $extFile = Join-Path $extDir 'volumeLock.js'
  Invoke-WebRequest -UseBasicParsing "$repoRaw/volumeLock.js?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -OutFile $extFile
  $extVersion = (Select-String -Path $extFile -Pattern '^// VERSION:\s*([\d.]+)').Matches[0].Groups[1].Value
  Ok "Volume Lock v$extVersion downloaded"

  $enabled = (& $spicetify config extensions) -split '\|' | ForEach-Object { $_.Trim() }
  if ($enabled -notcontains 'volumeLock.js') {
    Run-Spicetify -q config extensions volumeLock.js | Out-Null
  }

  # --- 5. Even out loudness between songs: turn on Spotify's "Normalize volume" ---
  # Spotify keeps this in its prefs files and rewrites them on exit, so close it first.
  # Set LOCK_SPOTIFY_NO_NORMALIZE=1 to skip.
  if ($env:LOCK_SPOTIFY_NO_NORMALIZE -ne '1') {
    Step 'Turning on "Normalize volume" (keeps every song at a similar loudness)'
    Close-Spotify
    $prefFiles = @($spotifyPrefs) + @(Get-ChildItem (Join-Path $env:APPDATA 'Spotify\Users') -Filter prefs -Recurse -ErrorAction SilentlyContinue | ForEach-Object FullName)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    foreach ($file in $prefFiles) {
      if (-not (Test-Path $file)) { continue }
      $lines = @([IO.File]::ReadAllLines($file) | Where-Object { $_ -notmatch '^audio\.normalize_v2=' })
      $lines += 'audio.normalize_v2=true'
      [IO.File]::WriteAllLines($file, [string[]]$lines, $utf8)
    }
    Ok 'Normalize volume is on'
  }

  # --- 6. Stop Spotify from updating itself (an update would remove the lock) ---
  Step 'Blocking Spotify auto-updates'
  Close-Spotify # Spotify.exe can't be changed while it's running
  if ($env:LOCK_SPOTIFY_ALLOW_UPDATES -eq '1') { Ok 'Skipped (LOCK_SPOTIFY_ALLOW_UPDATES=1)' }
  elseif ((Run-Spicetify spotify-updates block) -eq 0) { Ok 'Blocked' }
  else { Write-Host '  Could not block updates. If the lock disappears after a Spotify update, run this installer again.' -ForegroundColor Yellow }

  # --- 7. Apply ---
  # Your password and lock state are kept: this only replaces the extension file.
  Step 'Applying to Spotify (Spotify will restart)'
  Close-Spotify
  $backupDir = Join-Path $userData 'Backup'
  $hasBackup = (Test-Path $backupDir) -and (Get-ChildItem $backupDir -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($hasBackup) { $code = Run-Spicetify apply } else { $code = Run-Spicetify backup apply }
  if ($code -ne 0) {
    # Usually means Spotify updated since the last backup: rebuild it.
    Write-Host '  Rebuilding Spicetify backup for this Spotify version...' -ForegroundColor Yellow
    $code = Run-Spicetify restore backup apply
    if ($code -ne 0) { throw "Spicetify apply failed (exit code $code)." }
  }
  Ok 'Applied'

  $spotifyVersion = (Get-Item $spotifyExe).VersionInfo.ProductVersion
  Write-Host "`nDone. Volume Lock v$extVersion is installed (Spotify $spotifyVersion)." -ForegroundColor Green
  Write-Host 'Your password and locked/unlocked state were kept.'
  Write-Host 'In Spotify: click the lock next to the volume to lock it. Password settings are in Settings > Volume lock.'
}

try {
  Install-LockSpotify
}
catch {
  Write-Host "`nInstall failed: $($_.Exception.Message)" -ForegroundColor Red
}
