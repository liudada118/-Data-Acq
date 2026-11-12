param(
    [ValidateSet('policy', 'creation')]
    [string]$Action = 'policy',
    [string]$SourcePath,
    [uint32]$TargetPid
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($Action -eq 'creation') {
    # Used only for the disposable child created by this test run.
    $process = [System.Diagnostics.Process]::GetProcessById([int]$TargetPid)
    try { @{ creationTime = $process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) } | ConvertTo-Json -Compress }
    finally { $process.Dispose() }
} else {
    Add-Type -Path @($SourcePath, (Join-Path $PSScriptRoot 'windows-owner-release-harness.cs'))
    @{ passed = [Synapse.Serial.WindowsOwnerReleaseHarness]::Run() } | ConvertTo-Json -Compress
}
