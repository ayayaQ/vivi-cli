# SPDX-License-Identifier: Apache-2.0
param([Parameter(Mandatory = $true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$config = Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
# This compiles repository-owned test code, with only official Kernel32 and pinned Microsoft ConPTY APIs.
$phase = 'Compile'
try {
  # Independently bind the DLL/server bytes to entries inside the hash-pinned
  # official archive. The mutable provenance file is not authority to load code.
  $phase = 'VerifyPinnedArchive'
  $archive = Join-Path $config.backendDirectory 'archive.nupkg'
  $expected = 'eceaafe3bdcc85e95d18666eb647e0b8e7e00af45dbcad7034cdc61c4a29fe74'
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Official pinned archive mismatch'
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
  $verifiedHashes = @{}
  try {
    $pairs = @{
      'runtimes/win-x64/native/conpty.dll' = 'conpty.dll'
      'build/native/runtimes/x64/OpenConsole.exe' = 'OpenConsole.exe'
    }
    foreach ($source in $pairs.Keys) {
      $entry = $zip.GetEntry($source)
      if ($null -eq $entry -or $entry.Length -le 0 -or $entry.Length -gt 33554432) {
        throw 'Pinned package peer missing or outside its byte budget'
      }
      $stream = $entry.Open()
      $sha = [System.Security.Cryptography.SHA256]::Create()
      try {
        $entryHash = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
      } finally { $stream.Dispose(); $sha.Dispose() }
      $actual = (Get-FileHash -LiteralPath (Join-Path $config.backendDirectory $pairs[$source]) -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($entryHash -ne $actual) { throw 'Selected backend peer differs from its official archive entry' }
      $verifiedHashes[$pairs[$source]] = $entryHash
    }
  } finally { $zip.Dispose() }
  $phase = 'Compile'
  Add-Type -Path (Join-Path $PSScriptRoot 'host.cs')
  $phase = 'Run'
  $result = [ConPtyProbeHost]::Run($config.bun, $config.child, $config.repository, $config.prefix,
    $config.basic, $config.repeats, $config.paste, $config.finish, $config.restore, $config.expectReset,
    $config.backendDirectory, $verifiedHashes['conpty.dll'], $verifiedHashes['OpenConsole.exe'])
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
