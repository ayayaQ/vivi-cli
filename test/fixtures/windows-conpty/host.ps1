# SPDX-License-Identifier: Apache-2.0
param([Parameter(Mandatory = $true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$config = Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
# This compiles repository-owned test code, with only official Kernel32 P/Invokes.
$phase = 'Compile'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'host.cs')
  $phase = 'Run'
  $result = [ConPtyProbeHost]::Run($config.bun, $config.child, $config.repository, $config.prefix,
    $config.basic, $config.repeats, $config.paste, $config.finish, $config.restore, $config.expectReset)
  $result | ConvertTo-Json -Compress
} catch {
  # No child stdout, raw input, paths or full exceptions are emitted.
  $errorType = $_.Exception.GetType().Name
  try { $phase = [ConPtyProbeHost]::Phase } catch { }
  $progress = $null
  try { $progress = [ConPtyProbeHost]::Progress } catch { }
  @{ hostFailed = $true; phase = $phase; errorType = $errorType; progress = $progress } | ConvertTo-Json -Compress
  exit 1
}
