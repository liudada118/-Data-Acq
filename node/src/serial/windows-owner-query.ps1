param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^COM[1-9][0-9]{0,4}$')]
    [string]$Port,
    [ValidateRange(100, 10000)]
    [int]$ScanTimeoutMs = 4000,
    [ValidatePattern('^(\d+(,\d+)*)?$')]
    [string]$PreferredPids = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-owner-query.cs')
    $preferred = @()
    if ($PreferredPids) { $preferred = @($PreferredPids.Split(',') | ForEach-Object { [int]$_ }) }
    [Synapse.Serial.WindowsPortOwners]::Query($Port, $ScanTimeoutMs, [int[]]$preferred) | ConvertTo-Json -Depth 5 -Compress
} catch {
    # The public result must not leak a compiler dump or process/environment data.
    @{ owners = @(); complete = $false; reason = 'helper_initialization_failed' } | ConvertTo-Json -Compress
}
# A native device query may still be blocked on a background thread. Exit this
# helper only; never interrupt the inspected process or close its source handle.
[Console]::Out.Flush()
[Environment]::Exit(0)
