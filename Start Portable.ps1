$env:PORTABLE = "1"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Ensure data directories exist
New-Item -ItemType Directory -Path "$scriptDir\data" -Force | Out-Null
New-Item -ItemType Directory -Path "$scriptDir\data\session" -Force | Out-Null

# Packaged mode
if (Test-Path "$scriptDir\AEGIS.exe") {
    Start-Process -NoNewWindow "$scriptDir\AEGIS.exe" -ArgumentList $args
    exit
}

# Dev mode
if (Test-Path "$scriptDir\node_modules\.bin\electron.cmd") {
    Start-Process -NoNewWindow "$scriptDir\node_modules\.bin\electron.cmd" -ArgumentList @("$scriptDir\.", $args)
    exit
}

Write-Host "Could not find AEGIS.exe or electron. Make sure you are in the correct directory."
