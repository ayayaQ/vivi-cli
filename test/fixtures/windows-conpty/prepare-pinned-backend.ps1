# SPDX-License-Identifier: Apache-2.0
# CI-only extraction of two code files from one hash-pinned official Microsoft release.
param([Parameter(Mandatory = $true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Pinned backend preparation is CI-only' }
if (-not [System.IO.Path]::IsPathRooted($Destination)) { throw 'Use an absolute private CI destination' }
if (Test-Path -LiteralPath $Destination) { throw 'Pinned backend destination must be fresh' }
$release = 'v1.24.12741.0'
$package = 'Microsoft.Windows.Console.ConPTY.1.24.261001001.nupkg'
$expected = 'eceaafe3bdcc85e95d18666eb647e0b8e7e00af45dbcad7034cdc61c4a29fe74'
$url = "https://github.com/microsoft/terminal/releases/download/$release/$package"
$null = New-Item -ItemType Directory -Path $Destination
$archive = Join-Path $Destination 'archive.nupkg'
try {
  Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 90
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw 'Official ConPTY archive hash mismatch' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
  try {
    # Extract only exact reviewed x64 paths. No installer, package restore, global setting or wildcard extraction.
    $pairs = @{
      'runtimes/win-x64/native/conpty.dll' = 'conpty.dll'
      'build/native/runtimes/x64/OpenConsole.exe' = 'OpenConsole.exe'
    }
    foreach ($source in $pairs.Keys) {
      $entry = $zip.GetEntry($source)
      if ($null -eq $entry -or $entry.Length -le 0 -or $entry.Length -gt 33554432) {
        throw 'Expected bounded x64 ConPTY package entry missing'
      }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $Destination $pairs[$source]), $false)
    }
  } finally { $zip.Dispose() }
  $provenance = @{
    release = $release; package = $package; archiveSha256 = $actual; architecture = 'x64'
    dllSha256 = (Get-FileHash -LiteralPath (Join-Path $Destination 'conpty.dll') -Algorithm SHA256).Hash.ToLowerInvariant()
    serverSha256 = (Get-FileHash -LiteralPath (Join-Path $Destination 'OpenConsole.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  # Node reads BOM-less UTF-8; explicit encoding avoids Windows PowerShell defaults.
  [System.IO.File]::WriteAllText((Join-Path $Destination 'provenance.json'),
    ($provenance | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
  $provenance | ConvertTo-Json -Compress
} catch {
  Remove-Item -LiteralPath $Destination -Recurse -Force
  throw
}
