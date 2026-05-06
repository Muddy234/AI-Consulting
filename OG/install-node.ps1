$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$nodeVersion = 'v22.11.0'
$url = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
$installRoot = Join-Path $env:USERPROFILE 'node-portable'
$zipPath = Join-Path $env:USERPROFILE 'node-portable.zip'

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
$size = (Get-Item $zipPath).Length
Write-Host "Downloaded $size bytes"

if (Test-Path $installRoot) {
    Write-Host "Removing existing $installRoot"
    Remove-Item -Recurse -Force $installRoot
}

Write-Host "Extracting to $installRoot"
Expand-Archive -Path $zipPath -DestinationPath $installRoot -Force

# The zip contains a top-level folder like node-v22.11.0-win-x64; flatten it
$inner = Get-ChildItem $installRoot | Select-Object -First 1
$nodeBin = $inner.FullName

Write-Host "Node binary path: $nodeBin"
& "$nodeBin\node.exe" --version
& "$nodeBin\npm.cmd" --version

Write-Host ""
Write-Host "INSTALL_PATH=$nodeBin"
