<#
.SYNOPSIS
  Windows-native wrapper around deploy/sync-data.sh — sync CityLeaks live player
  data between the production VPS and your local machine, plus backups.

.DESCRIPTION
  Runs the bash script via Git Bash so you don't have to open a Git Bash shell.
  All env-var config (SSH_HOST, SSH_KEY, KEEP, …) is inherited from PowerShell.

.EXAMPLE
  .\deploy\sync-data.ps1 pull
  .\deploy\sync-data.ps1 backup
  .\deploy\sync-data.ps1 restore .\backups\prod-20260616-101500.tar.gz
  .\deploy\sync-data.ps1 list
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('pull', 'backup', 'restore', 'list', 'help')]
  [string]$Command = 'help',

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = 'Stop'

# Locate Git Bash.
$bash = $null
$cmd = Get-Command bash.exe -ErrorAction SilentlyContinue
if ($cmd) { $bash = $cmd.Source }
if (-not $bash) {
  foreach ($p in @(
      "$env:ProgramFiles\Git\bin\bash.exe",
      "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
      "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe")) {
    if (Test-Path $p) { $bash = $p; break }
  }
}
if (-not $bash) { throw "Git Bash (bash.exe) not found. Install Git for Windows." }

# Path to the sibling shell script, in forward-slash form for bash.
$sh = (Join-Path $PSScriptRoot 'sync-data.sh') -replace '\\', '/'

$passArgs = @($Command)
if ($Args) { $passArgs += $Args }

# For the guarded restore, confirm here in PowerShell, then pass --yes so the
# bash side doesn't also need an interactive tty.
if ($Command -eq 'restore' -and ($passArgs -notcontains '--yes')) {
  $archive = if ($Args) { $Args[0] } else { '<missing>' }
  Write-Host "This OVERWRITES live player data on the production server." -ForegroundColor Yellow
  Write-Host "Archive: $archive" -ForegroundColor Yellow
  $reply = Read-Host "Continue? [y/N]"
  if ($reply -notin @('y', 'Y', 'yes', 'YES')) { throw 'Aborted.' }
  $passArgs += '--yes'
}

& $bash $sh @passArgs
exit $LASTEXITCODE
