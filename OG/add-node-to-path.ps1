$nodePath = 'C:\Users\NateMcBride\node-portable\node-v22.11.0-win-x64'
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($current -split ';' -notcontains $nodePath) {
    $newPath = if ([string]::IsNullOrEmpty($current)) { $nodePath } else { "$current;$nodePath" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "Added to user PATH: $nodePath"
} else {
    Write-Host "Already in user PATH: $nodePath"
}

Write-Host ""
Write-Host "Open a NEW PowerShell window for PATH changes to take effect."
