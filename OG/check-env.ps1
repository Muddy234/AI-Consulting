Write-Host "=== Broad scan for any 'ANTHROPIC' or 'CLAUDE' env vars ===" -ForegroundColor Cyan

$found = New-Object System.Collections.ArrayList

foreach ($scope in @('User','Machine','Process')) {
    $vars = [Environment]::GetEnvironmentVariables($scope)
    foreach ($entry in $vars.GetEnumerator()) {
        $name = $entry.Key
        if ($name -match 'ANTHROPIC|CLAUDE') {
            $val = $entry.Value
            $masked = if ($val.Length -gt 8) { $val.Substring(0,4) + '...' + $val.Substring($val.Length-4) } else { '***' }
            [void]$found.Add("$scope`: $name = $masked (len $($val.Length))")
        }
    }
}

if ($found.Count -eq 0) {
    Write-Host "No ANTHROPIC/CLAUDE variables found anywhere." -ForegroundColor Green
} else {
    foreach ($f in $found) { Write-Host "  $f" -ForegroundColor Red }
}
