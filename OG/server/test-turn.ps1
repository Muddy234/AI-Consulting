$body = @{
  gameId = 'test-' + (Get-Random)
  systemPrompt = 'You are a JSON generator. Return only a JSON object.'
  prompt = 'Return exactly this JSON: {"hello":"world","ok":true}'
} | ConvertTo-Json

try {
  $r = Invoke-WebRequest -Uri http://localhost:3000/turn `
    -Method POST `
    -Body $body `
    -ContentType 'application/json' `
    -TimeoutSec 90 `
    -UseBasicParsing
  Write-Host "Status: $($r.StatusCode)"
  Write-Host "Body:"
  Write-Host $r.Content
} catch {
  Write-Host "ERROR:"
  Write-Host $_.Exception.Message
  if ($_.Exception.Response) {
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Host $reader.ReadToEnd()
  }
}
