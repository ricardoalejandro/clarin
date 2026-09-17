# Read-only, bounded diagnostics. Does not install software, reboot, alter
# firewall/BitLocker, read credentials or open the user's browser profiles.
[CmdletBinding()]
param([string]$CandidateDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

try {
    $candidateRoot = [IO.Path]::GetFullPath($CandidateDirectory)
    $manifest = Get-Content -LiteralPath (Join-Path $candidateRoot 'release-manifest.json') -Raw | ConvertFrom-Json
    $report = Get-Content -LiteralPath (Join-Path $candidateRoot 'windows-qa-template.json') -Raw | ConvertFrom-Json
    $installerHash = (Get-FileHash -LiteralPath (Join-Path $candidateRoot 'Clarin-Offline-Setup.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($manifest.protocol_version -ne 3 -or $manifest.installer_sha256 -ne $installerHash -or $report.installer_sha256 -ne $installerHash) { throw 'candidate_hash_mismatch' }
    $os = Get-CimInstance Win32_OperatingSystem
    $processor = Get-CimInstance Win32_Processor | Select-Object -First 1
    $supported = [int]$os.BuildNumber -ge 22000 -and $os.ProductType -eq 1 -and $processor.Architecture -eq 9
    $service = Get-CimInstance Win32_Service -Filter "Name='ClarinOfflineV3'"
    $serviceRunning = $null -ne $service -and $service.State -eq 'Running'
    $report.environment.os = if ($supported) { 'Windows 11' } else { 'unsupported' }
    $report.environment.arch = if ($processor.Architecture -eq 9) { 'x64' } else { 'unsupported' }
    $report.environment.real_service = $serviceRunning
    $report.completed_at = [DateTime]::UtcNow.ToString('o')
    $installRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Clarin\OfflineV3'
    $observedBinaries = @()
    foreach ($binary in $manifest.binaries) {
        # Never accept an arbitrary filename/path from a copied manifest.
        if ($binary.name -notin @('clarin-offline-service.exe','clarin-offline-principal.exe')) { throw 'invalid_binary_name' }
        $file = Join-Path $installRoot $binary.name
        $matches = $false
        if (Test-Path -LiteralPath $file -PathType Leaf) { $matches = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -eq $binary.sha256 }
        $observedBinaries += @{ name=$binary.name; matches_candidate=$matches }
    }
    $healthPass = $false
    $deniedOriginPass = $false
    try {
        $headers = @{ Origin='https://clarin.naperu.cloud'; 'X-Clarin-Protocol'='3'; 'X-Clarin-Request-ID'=[guid]::NewGuid().ToString() }
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17373/v3/health' -Headers $headers -TimeoutSec 5
        $healthPass = $health.protocol -eq 3 -and $health.service_version -eq $manifest.version
        $headers.Origin = 'https://example.invalid'
        try { $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:17373/v3/health' -Headers $headers -TimeoutSec 5 }
        catch { if ($null -ne $_.Exception.Response) { $deniedOriginPass = [int]$_.Exception.Response.StatusCode -eq 403 } }
    } catch { $healthPass = $false }
    foreach ($browser in $report.browsers) {
        foreach ($check in $browser.checks) {
            $check.status = 'not_run'
            $check.evidence_sha256 = ''
            $check.simulated = $false
        }
        $relative = if ($browser.channel -eq 'chrome') { 'Google\Chrome\Application\chrome.exe' } else { 'Microsoft\Edge\Application\msedge.exe' }
        foreach ($base in @([Environment]::GetFolderPath('ProgramFiles'),[Environment]::GetFolderPath('ProgramFilesX86'),[Environment]::GetFolderPath('LocalApplicationData'))) {
            $browserFile = Join-Path $base $relative
            if (Test-Path -LiteralPath $browserFile -PathType Leaf) { $browser.version = (Get-Item -LiteralPath $browserFile).VersionInfo.ProductVersion; break }
        }
        # All browser-flow checks remain not_run. Machine diagnostics do not
        # prove login, isolation, DPAPI reboot recovery or real Chrome/Edge LNA.
    }
    $diagnostics = @{ schema_version=1; supported_windows=$supported; service_running=$serviceRunning; local_service_account=($null -ne $service -and $service.StartName -eq 'NT AUTHORITY\LocalService'); health_pass=$healthPass; denied_origin_pass=$deniedOriginPass; binaries=$observedBinaries; browser_flows='not_run'; contains_credentials=$false }
    $output = Join-Path $candidateRoot ('diagnostics-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $output | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $output 'diagnostics.json'), ($diagnostics | ConvertTo-Json -Depth 8), $utf8)
    [IO.File]::WriteAllText((Join-Path $output 'windows-qa-report.json'), ($report | ConvertTo-Json -Depth 10), $utf8)
    Write-Host "Diagnostico generado: $output"
    Write-Host 'Las pruebas del flujo en Chrome/Edge siguen pendientes. Este informe NO autoriza la activacion.'
    exit 0
} catch {
    Write-Error 'No se pudo completar el diagnostico acotado. No se modifico el servicio ni se leyeron credenciales.' -ErrorAction Continue
    exit 1
}
