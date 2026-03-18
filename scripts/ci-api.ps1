# ci-api.ps1 — CollegeInsight API caller for OpenClaw (Windows)
# Usage: ci-api.ps1 <endpoint>
# Example: ci-api.ps1 /twin/colleges
#          ci-api.ps1 /twin/activities
param(
    [Parameter(Mandatory=$true)][string]$Endpoint,
    [string]$Method = "GET"
)
$BaseUrl = if ($env:CI_BASE_URL) { $env:CI_BASE_URL } else { "http://192.168.86.20:4200" }
$ApiKey = if ($env:CI_API_KEY) { $env:CI_API_KEY } else { "ci_9TCnGGB6fvlQCZgnxpafKAnupM8hF2ag" }
$headers = @{ "X-Api-Key" = $ApiKey; "Content-Type" = "application/json" }
$response = Invoke-RestMethod -Uri "$BaseUrl$Endpoint" -Method $Method -Headers $headers
$response | ConvertTo-Json -Depth 10
