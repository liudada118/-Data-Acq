param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 4294967295)]
    [uint32]$OwnerPid,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9]{1,20}$')]
    [string]$CreationTime,
    [ValidatePattern('^[0-9]+(,[0-9]+)*$')]
    [string]$ProtectedPids,
    [ValidateRange(100, 2000)]
    [int]$WaitMs = 2000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-owner-release.cs')
    [uint32[]]$blocked = if ($ProtectedPids) { @($ProtectedPids.Split(',') | ForEach-Object { [uint32]$_ }) } else { @() }
    [Synapse.Serial.WindowsOwnerRelease]::Release($OwnerPid, $CreationTime, $blocked, $WaitMs) | ConvertTo-Json -Compress
} catch {
    @{ released = $false; pid = $OwnerPid; creationTime = $CreationTime; reason = 'helper_failed' } | ConvertTo-Json -Compress
}
