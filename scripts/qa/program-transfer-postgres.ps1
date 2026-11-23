param(
    [string]$RuntimeRoot = '',
    [string]$ReuseRunRoot = '',
    [string]$SourceRoot = '',
    [switch]$ResetDatabases,
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = $repoRoot }
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
if (($SourceRoot -ne $repoRoot -and -not $SourceRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) -or -not (Test-Path -LiteralPath (Join-Path $SourceRoot 'backend/go.mod'))) {
    throw 'The test source must be the repository or an isolated checkout beneath it.'
}
$qaRoot = Join-Path $repoRoot '.qa/program-transfer-postgres'
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $RuntimeRoot = Join-Path $qaRoot 'runtime'
}
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
if (-not $RuntimeRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The disposable PostgreSQL runtime must be inside the repository.'
}
$binaryRoot = Join-Path $RuntimeRoot 'node_modules/@embedded-postgres/windows-x64/native/bin'
if (-not (Test-Path -LiteralPath (Join-Path $binaryRoot 'initdb.exe'))) {
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
    & npm install --prefix $RuntimeRoot --ignore-scripts --no-audit --no-fund --save-exact '@embedded-postgres/windows-x64@16.11.0-beta.16'
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the pinned test-only PostgreSQL runtime.' }
}
foreach ($required in @('initdb.exe', 'pg_ctl.exe', 'postgres.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $binaryRoot $required))) {
        throw "The pinned PostgreSQL runtime is missing $required."
    }
}

$runRoot = Join-Path $qaRoot ('runs/' + [guid]::NewGuid().ToString('N'))
if (-not [string]::IsNullOrWhiteSpace($ReuseRunRoot)) {
    $runRoot = (Resolve-Path -LiteralPath $ReuseRunRoot).Path
    $allowedRoot = [IO.Path]::GetFullPath((Join-Path $qaRoot 'runs')) + [IO.Path]::DirectorySeparatorChar
    if (-not $runRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($runRoot) -notmatch '^[0-9a-f]{32}$') {
        throw 'Only a task-owned Program transfer QA run directory may be reused.'
    }
    if ((Get-Content -LiteralPath (Join-Path $runRoot 'data/PG_VERSION') -Raw).Trim() -ne '16' -or (Test-Path -LiteralPath (Join-Path $runRoot 'data/postmaster.pid'))) {
        throw 'The disposable PostgreSQL16 cluster must be stopped before reuse.'
    }
}
$dataRoot = Join-Path $runRoot 'data'
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$evidenceRoot = Join-Path $runRoot ('checks/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
if ($Port -eq 0) {
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $Port = $probe.LocalEndpoint.Port
    $probe.Stop()
}
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Use an unprivileged TCP port.' }
$testUser = 'clarin_transfer_qa'
$passwordBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes)
$password = [Convert]::ToHexString($passwordBytes).ToLowerInvariant()
$oldVariables = @{}
$variableNames = @('PGPASSWORD', 'INTEGRITY_TEST_DATABASE_URL', 'PROGRAM_TRANSFER_HTTP_TEST_DATABASE_URL', 'GOCACHE', 'TEMP', 'TMP')
foreach ($name in $variableNames) { $oldVariables[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$started = $false

function Invoke-TaskInitDb {
    param([string]$Binary, [string[]]$Arguments)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Binary
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Could not launch the task-owned initdb process.' }
        $output = $process.StandardOutput.ReadToEndAsync()
        $errorOutput = $process.StandardError.ReadToEndAsync()
        $deadline = [DateTime]::UtcNow.AddMinutes(10)
        while (-not $process.WaitForExit(1000)) {
            if ([DateTime]::UtcNow -ge $deadline) {
                $process.Kill($true)
                $process.WaitForExit()
                throw 'Disposable initdb exceeded its ten-minute initialization deadline.'
            }
        }
        Write-Output $output.GetAwaiter().GetResult()
        Write-Output $errorOutput.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Disposable PostgreSQL initialization failed.' }
    } finally {
        if ($process.Id -and -not $process.HasExited) { $process.Kill($true) }
        $process.Dispose()
    }
}

try {
    if ([string]::IsNullOrWhiteSpace($ReuseRunRoot)) {
    # Native Windows initdb prompts require a console. Keep its random test
    # password in a fresh ignored task directory only for initialization.
    $passwordFile = Join-Path $runRoot 'init-password.tmp'
    try {
        [IO.File]::WriteAllText($passwordFile, $password + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Invoke-TaskInitDb -Binary (Join-Path $binaryRoot 'initdb.exe') -Arguments @('-D', $dataRoot, '-U', $testUser, '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256', "--pwfile=$passwordFile", '--set=max_connections=20', '--set=shared_buffers=16MB', '--no-sync', '--no-instructions')
    } finally {
        if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile -Force }
    }
    # The embedded distribution intentionally contains only server tools.
    # Single-user mode provisions the empty databases before any TCP listener
    # starts; the regular Go fixtures perform the subsequent connection checks.
    "CREATE DATABASE program_survey_integrity_test;`nCREATE DATABASE program_transfer_http_test;" | & (Join-Path $binaryRoot 'postgres.exe') --single -D $dataRoot postgres
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the two empty disposable test databases.' }
    } else {
        # Reuse only this stopped synthetic cluster. Reset its test role to a
        # fresh random password, suppressing single-user SQL output entirely.
        "ALTER ROLE clarin_transfer_qa PASSWORD '$password';" | & (Join-Path $binaryRoot 'postgres.exe') --single -D $dataRoot -c log_min_error_statement=panic postgres 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not reset the disposable test role for reuse.' }
        if ($ResetDatabases) {
            # Only these two synthetic databases inside this stopped task-owned
            # cluster are reset. This proves startup from an empty schema for
            # an isolated release source without re-running native initdb.
            $resetSql = "DROP DATABASE IF EXISTS program_survey_integrity_test;`nCREATE DATABASE program_survey_integrity_test;`nDROP DATABASE IF EXISTS program_transfer_http_test;`nCREATE DATABASE program_transfer_http_test;"
            $resetOutput = $resetSql | & (Join-Path $binaryRoot 'postgres.exe') --single -D $dataRoot postgres 2>&1
            if ($LASTEXITCODE -ne 0 -or ($resetOutput -match '\b(ERROR|FATAL|PANIC):')) { throw 'Could not reset the two synthetic test databases.' }
        }
    }
    $serverOptions = "-h 127.0.0.1 -p $Port -c max_connections=20 -c shared_buffers=32MB"
    & (Join-Path $binaryRoot 'pg_ctl.exe') -D $dataRoot -l (Join-Path $runRoot 'postgres.log') -o $serverOptions -t 30 -w start
    if ($LASTEXITCODE -ne 0) { throw 'Disposable loopback PostgreSQL could not start.' }
    $started = $true
    $env:PGPASSWORD = $password
    & (Join-Path $binaryRoot 'postgres.exe') --version

    $env:INTEGRITY_TEST_DATABASE_URL = "postgresql://${testUser}:${password}@127.0.0.1:${Port}/program_survey_integrity_test?sslmode=disable"
    $env:PROGRAM_TRANSFER_HTTP_TEST_DATABASE_URL = "postgresql://${testUser}:${password}@127.0.0.1:${Port}/program_transfer_http_test?sslmode=disable"
    $env:GOCACHE = Join-Path $repoRoot '.tmp-go-build'
    $env:TEMP = $evidenceRoot
    $env:TMP = $evidenceRoot
    Write-Output "PROGRAM_TRANSFER_TEST_SOURCE=$SourceRoot"
    Push-Location (Join-Path $SourceRoot 'backend')
    try {
        & go test -p 2 ./internal/repository -run '^TestProgramTransfer' -count=1 -v 2>&1 | Tee-Object -FilePath (Join-Path $evidenceRoot 'repository.log')
        if ($LASTEXITCODE -ne 0) { throw 'Program transfer PostgreSQL repository tests failed.' }
        if (Select-String -LiteralPath (Join-Path $evidenceRoot 'repository.log') -Pattern '^--- SKIP: TestProgramTransfer' -Quiet) { throw 'A Program transfer PostgreSQL repository test was skipped.' }
        # A second process repeats all startup migrations against the same
        # synthetic database and proves their idempotency during a re-run.
        & go test -p 2 ./internal/repository -run '^TestProgramTransferReadAccountScopedCompleteSnapshot$' -count=1 -v 2>&1 | Tee-Object -FilePath (Join-Path $evidenceRoot 'migration-repeat.log')
        if ($LASTEXITCODE -ne 0) { throw 'Repeated Program transfer startup migrations failed.' }
        & go test -p 2 ./internal/api -run '^TestProgramTransferHTTPRoundTrip$' -count=1 -v 2>&1 | Tee-Object -FilePath (Join-Path $evidenceRoot 'http.log')
        if ($LASTEXITCODE -ne 0) { throw 'Program transfer PostgreSQL HTTP round trip failed.' }
        if (Select-String -LiteralPath (Join-Path $evidenceRoot 'http.log') -Pattern '^--- SKIP:' -Quiet) { throw 'The Program transfer PostgreSQL HTTP test was skipped.' }
        Write-Output "PROGRAM_TRANSFER_POSTGRES_OK port=$Port evidence=$evidenceRoot"
    } finally {
        Pop-Location
    }
} finally {
    if ($started) {
        & (Join-Path $binaryRoot 'pg_ctl.exe') -D $dataRoot -m fast -t 30 -w stop
        if ($LASTEXITCODE -ne 0) { Write-Warning 'The task-owned PostgreSQL cluster did not stop cleanly; inspect its task directory.' }
    }
    foreach ($name in $variableNames) { [Environment]::SetEnvironmentVariable($name, $oldVariables[$name], 'Process') }
    $password = $null
    [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
}
