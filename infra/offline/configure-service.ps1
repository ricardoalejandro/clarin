# Fixed-purpose installer helper. No user-provided commands, paths or secrets.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Prepare','Configure','Uninstall')][string]$Action)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$serviceName = 'ClarinOfflineV3'
$programFilesRoot = [Environment]::GetFolderPath('ProgramFiles')
$commonFilesRoot = [Environment]::GetFolderPath('CommonProgramFiles')
$programDataRoot = [Environment]::GetFolderPath('CommonApplicationData')
$installVendorRoot = Join-Path $programFilesRoot 'Clarin'
$installRoot = Join-Path $installVendorRoot 'OfflineV3'
$dataVendorRoot = Join-Path $programDataRoot 'Clarin'
$dataOfflineRoot = Join-Path $dataVendorRoot 'Offline'
$dataRoot = Join-Path $dataOfflineRoot 'v3'
$serviceExe = Join-Path $installRoot 'clarin-offline-service.exe'
$helperExe = Join-Path $installRoot 'clarin-offline-principal.exe'
$registryUri = 'HKLM:\Software\Classes\clarin-offline-v3'
$scExe = Join-Path ([Environment]::GetFolderPath('System')) 'sc.exe'
$fsutilExe = Join-Path ([Environment]::GetFolderPath('System')) 'fsutil.exe'
$trustedOwnerSids = @('S-1-5-18','S-1-5-32-544')

function Assert-NoReparsePath([string]$Target) {
    $cursor = [System.IO.Path]::GetFullPath($Target)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $entry = Get-Item -LiteralPath $cursor -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe_install_path' }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Invoke-ServiceControl([string[]]$Arguments) {
    & $scExe @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'service_configuration_failed' }
}

function New-PrivateDirectorySecurity([string]$ServiceSid, [bool]$AllowUsers) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $adminSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $acl.SetOwner($adminSid)
    foreach ($sidText in @('S-1-5-18','S-1-5-32-544',$ServiceSid)) {
        if (-not $sidText) { continue }
        $sid = New-Object System.Security.Principal.SecurityIdentifier($sidText)
        $rights = if ($AllowUsers -and $sidText -eq $ServiceSid) { 'ReadAndExecute' } else { 'FullControl' }
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid,$rights,'ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    if ($AllowUsers) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
    }
    return $acl
}

function New-PrivateFileSecurity([string]$ServiceSid, [bool]$AllowUsers) {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $adminSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $acl.SetOwner($adminSid)
    foreach ($sidText in @('S-1-5-18','S-1-5-32-544')) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($sidText)
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
    }
    if ($ServiceSid) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($ServiceSid)
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','Allow')))
    }
    if ($AllowUsers) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','Allow')))
    }
    return $acl
}

function Assert-TrustedAcl([string]$Target, [string]$ServiceSid) {
    $acl = Get-Acl -LiteralPath $Target
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $trustedOwnerSids) { throw 'unsafe_path_owner' }
    $writers = @($trustedOwnerSids)
    if ($ServiceSid) { $writers += $ServiceSid }
    $writeMask = [int64]([System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
    $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        $sid = $rule.IdentityReference.Value
        if (([int64]$rule.FileSystemRights -band $writeMask) -ne 0 -and $sid -notin $writers) {
            throw 'unsafe_path_permissions'
        }
    }
}

function Assert-TrustedDirectory([string]$Target, [string]$ServiceSid) {
    Assert-NoReparsePath $Target
    if (-not (Test-Path -LiteralPath $Target -PathType Container)) { throw 'missing_secure_directory' }
    Assert-TrustedAcl $Target $ServiceSid
}

function New-PrivateDirectoryAtomic([string]$Target, [System.Security.AccessControl.DirectorySecurity]$Acl) {
    $overload = [System.IO.Directory].GetMethod('CreateDirectory', [type[]]@(
        [string], [System.Security.AccessControl.DirectorySecurity]))
    if ($null -eq $overload) { throw 'secure_directory_api_unavailable' }
    $null = $overload.Invoke($null, [object[]]@($Target, $Acl))
}

function Ensure-SafeAncestor([string]$Target) {
    Assert-NoReparsePath $Target
    if (Test-Path -LiteralPath $Target) {
        Assert-TrustedDirectory $Target ''
        return
    }
    $acl = New-PrivateDirectorySecurity '' $true
    New-PrivateDirectoryAtomic $Target $acl
    Assert-TrustedDirectory $Target ''
}

function Set-PrivateDirectory([string]$Target, [string]$ServiceSid, [bool]$AllowUsers) {
    Assert-NoReparsePath $Target
    $acl = New-PrivateDirectorySecurity $ServiceSid $AllowUsers
    if (Test-Path -LiteralPath $Target) {
        Assert-TrustedDirectory $Target $ServiceSid
        Set-Acl -LiteralPath $Target -AclObject $acl
    } else {
        New-PrivateDirectoryAtomic $Target $acl
    }
    Assert-TrustedDirectory $Target $ServiceSid
}

function Get-HardLinkCount([string]$Target) {
    $links = @(& $fsutilExe hardlink list $Target 2>$null | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($LASTEXITCODE -ne 0 -or $links.Count -lt 1) { throw 'hardlink_check_failed' }
    return $links.Count
}

function Assert-SafePayloadFile([string]$Target, [string]$ServiceSid) {
    Assert-NoReparsePath $Target
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw 'missing_service_binary' }
    if ((Get-HardLinkCount $Target) -ne 1) { throw 'unsafe_payload_hardlink' }
    Assert-TrustedAcl $Target $ServiceSid
}

function Set-PrivateFile([string]$Target, [string]$ServiceSid, [bool]$AllowUsers) {
    Assert-SafePayloadFile $Target $ServiceSid
    Set-Acl -LiteralPath $Target -AclObject (New-PrivateFileSecurity $ServiceSid $AllowUsers)
    Assert-SafePayloadFile $Target $ServiceSid
}

function Assert-ScriptLocation {
    $scriptRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
    if ($Action -eq 'Prepare') {
        $parent = [System.IO.Directory]::GetParent($scriptRoot)
        $leaf = [System.IO.Path]::GetFileName($scriptRoot)
        if ($null -eq $parent -or -not [string]::Equals($parent.FullName.TrimEnd('\'), $commonFilesRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
            $leaf -notmatch '^ClarinOfflineV3-\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$') {
            throw 'unsafe_staging_location'
        }
        Assert-TrustedDirectory $scriptRoot ''
    } elseif (-not [string]::Equals($scriptRoot, $installRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'unexpected_script_location'
    }
    Assert-SafePayloadFile $PSCommandPath ''
}

function Stop-ExistingService {
    $installed = Get-CimInstance Win32_Service -Filter "Name='ClarinOfflineV3'"
    if ($null -eq $installed) { return }
    if ($installed.PathName -ne ('"' + $serviceExe + '"')) { throw 'unexpected_existing_service_path' }
    $service = Get-Service -Name $serviceName
    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name $serviceName -ErrorAction Stop
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
}

try {
    if (-not [Environment]::Is64BitProcess -or -not [Environment]::Is64BitOperatingSystem) { throw 'windows_x64_required' }
    $os = Get-CimInstance Win32_OperatingSystem
    if ([int]$os.BuildNumber -lt 22000 -or $os.ProductType -ne 1) { throw 'windows_11_required' }
    $processor = Get-CimInstance Win32_Processor | Select-Object -First 1
    if ($processor.Architecture -ne 9) { throw 'native_x64_required' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'administrator_install_required' }
    Assert-ScriptLocation
    Ensure-SafeAncestor $installVendorRoot
    Assert-NoReparsePath $installRoot
    Assert-NoReparsePath $dataRoot
    if ($Action -eq 'Prepare') {
        Stop-ExistingService
        # Users can execute the helper but cannot replace an installed binary.
        Set-PrivateDirectory $installRoot '' $true
        foreach ($file in @($serviceExe,$helperExe,(Join-Path $installRoot 'configure-service.ps1'),(Join-Path $installRoot 'Uninstall.exe'))) {
            if (Test-Path -LiteralPath $file) { Set-PrivateFile $file '' $true }
        }
        # No local data migration/deletion happens in the installer.
        exit 0
    }
    if ($Action -eq 'Uninstall') {
        Stop-ExistingService
        if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { Invoke-ServiceControl @('delete',$serviceName) }
        if (Test-Path -LiteralPath $registryUri) {
            $command = (Get-Item -LiteralPath "$registryUri\shell\open\command").GetValue('')
            if ($command -ne ('"' + $helperExe + '" "%1"')) { throw 'unexpected_helper_registration' }
            Remove-Item -LiteralPath $registryUri -Recurse
        }
        # Intentionally never delete ProgramData, encryption keys or outbox.
        exit 0
    }
    foreach ($file in @($serviceExe,$helperExe)) {
        Assert-NoReparsePath $file
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'missing_service_binary' }
    }
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
        Stop-ExistingService
        Invoke-ServiceControl @('config',$serviceName,'binPath=',('"' + $serviceExe + '"'),'start=','auto','obj=','NT AUTHORITY\LocalService')
    } else {
        Invoke-ServiceControl @('create',$serviceName,'binPath=',('"' + $serviceExe + '"'),'start=','auto','obj=','NT AUTHORITY\LocalService','DisplayName=','Clarin Offline Web')
    }
    # UNRESTRICTED here adds the per-service SID; it does not make LocalService
    # an administrator. File DACLs grant data access only to this service SID.
    Invoke-ServiceControl @('sidtype',$serviceName,'unrestricted')
    # Impersonation is confined to reading the authenticated helper identity;
    # the broker always reverts before touching the service-protected vault.
    Invoke-ServiceControl @('privs',$serviceName,'SeChangeNotifyPrivilege/SeImpersonatePrivilege')
    Invoke-ServiceControl @('sdset',$serviceName,'D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;AU)')
    Invoke-ServiceControl @('failure',$serviceName,'reset=','86400','actions=','restart/5000/restart/15000/restart/60000')
    $serviceSid = (New-Object Security.Principal.NTAccount("NT SERVICE\$serviceName")).Translate([Security.Principal.SecurityIdentifier]).Value
    Ensure-SafeAncestor $dataVendorRoot
    Ensure-SafeAncestor $dataOfflineRoot
    Set-PrivateDirectory $dataRoot $serviceSid $false
    Set-PrivateDirectory $installRoot $serviceSid $true
    foreach ($file in @($serviceExe,$helperExe,(Join-Path $installRoot 'configure-service.ps1'),(Join-Path $installRoot 'Uninstall.exe'))) {
        Set-PrivateFile $file $serviceSid $true
    }
    New-Item -Path "$registryUri\shell\open\command" -Force | Out-Null
    Set-Item -LiteralPath $registryUri -Value 'URL:Clarin Offline browser helper'
    New-ItemProperty -LiteralPath $registryUri -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    Set-Item -LiteralPath "$registryUri\shell\open\command" -Value ('"' + $helperExe + '" "%1"')
    $configured = Get-CimInstance Win32_Service -Filter "Name='ClarinOfflineV3'"
    if ($configured.PathName -ne ('"' + $serviceExe + '"') -or $configured.StartName -ne 'NT AUTHORITY\LocalService') { throw 'service_identity_verification_failed' }
    Start-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    & $serviceExe selftest | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'service_selftest_failed' }
    Start-Sleep -Milliseconds 1500
    if ((Get-Service -Name $serviceName).Status -ne 'Running') { throw 'service_not_stable' }
    & $serviceExe selftest | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'service_readiness_not_stable' }
    exit 0
} catch {
    # No credentials, paths, usernames, SIDs or private data in installer logs.
    Write-Error 'Clarin Offline: la comprobacion del servicio no termino correctamente.' -ErrorAction Continue
    exit 1
}
