# SPDX-License-Identifier: Apache-2.0
# Test-only direct Windows startup control. JSON is data, never executable source.
# Only the adjacent owned native-probe fixture is accepted; it spawns no children.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$process = $null
$result = [ordered]@{ exitCode = $null; pid = $null; timedOut = $false; outputLimitExceeded = $false; cleanupVerified = $false; stdout = ''; stderr = ''; error = $null }
try {
  $moduleDirectory = [IO.Path]::Combine($PSHOME, 'Modules')
  $manifest = [IO.Path]::Combine($moduleDirectory, 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')
  if (-not [IO.File]::Exists($manifest) -or ([IO.File]::GetAttributes($manifest) -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint))) { throw 'Installed PowerShell 7 Utility manifest is unavailable or unexpected' }
  $ancestor = [IO.Path]::GetDirectoryName($manifest)
  while (-not [String]::IsNullOrEmpty($ancestor)) {
    if ([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected installed PowerShell 7 Utility ancestor' }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
  [Environment]::SetEnvironmentVariable('PSModulePath', $moduleDirectory)
  # Node/libuv may add standard host variables to its Windows child even with
  # an explicit env option. Remove them before the first Utility lookup.
  foreach ($name in @([Environment]::GetEnvironmentVariables().Keys)) {
    if ($name -notin @('SystemRoot', 'TEMP', 'TMP', 'PSModulePath')) { [Environment]::SetEnvironmentVariable([string]$name, $null) }
  }
  Import-Module -Name $manifest -ErrorAction Stop
  $line = [Console]::ReadLine()
  if ($null -eq $line -or $line.Length -gt 24000) { throw 'Invalid owned probe request length' }
  $request = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $line -AsHashtable -ErrorAction Stop
  if ($request.Count -ne 4 -or -not $request.ContainsKey('executable') -or -not $request.ContainsKey('args') -or -not $request.ContainsKey('cwd') -or -not $request.ContainsKey('env')) { throw 'Invalid owned probe request fields' }
  if (-not [IO.Path]::IsPathFullyQualified($request.executable) -or [IO.Path]::GetFileName($request.executable) -ine 'node.exe' -or -not [IO.Path]::IsPathFullyQualified($request.cwd)) { throw 'Owned probe requires absolute Node executable and cwd' }
  $fixture = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, 'mcp-discovery-server.mjs'))
  if ($request.args.Count -lt 4 -or -not [String]::Equals([IO.Path]::GetFullPath($request.args[0]), $fixture, [StringComparison]::OrdinalIgnoreCase) -or $request.args[1] -cne 'native-probe') { throw 'Only the owned native-probe fixture is permitted' }
  foreach ($path in @($request.args[2], $request.args[3])) {
    if (-not [IO.Path]::IsPathFullyQualified($path) -or -not [String]::Equals([IO.Path]::GetDirectoryName($path), $request.cwd, [StringComparison]::OrdinalIgnoreCase)) { throw 'Owned probe output files must belong to its cwd' }
  }
  if ($request.env.Count -gt 1 -or ($request.env.Count -eq 1 -and (-not $request.env.ContainsKey('SYSTEMROOT') -or -not [IO.Path]::IsPathFullyQualified($request.env['SYSTEMROOT'])))) { throw 'Only exact empty or explicit SYSTEMROOT probe environments are permitted' }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $request.executable
  $start.WorkingDirectory = $request.cwd
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment.Clear()
  foreach ($entry in $request.env.GetEnumerator()) { $start.Environment.Add([string]$entry.Key, [string]$entry.Value) }
  foreach ($argument in $request.args) { $start.ArgumentList.Add([string]$argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Owned direct probe did not start' }
  $result.pid = $process.Id
  [IO.File]::WriteAllText([IO.Path]::Combine($request.cwd, 'direct-target.pid'), [string]$process.Id, [Text.UTF8Encoding]::new($false))
  # Announce the owned PID before waiting, so the outer test can clean up even
  # if this diagnostic wrapper itself fails before its terminal result.
  [Console]::Out.WriteLine('{"type":"start","pid":' + $process.Id + '}')
  [Console]::Out.Flush()
  # Keep target stdin open through completion and cleanup, matching the helper.
  # Fixed buffers cap each stream at 64 KiB, with one byte to detect overflow.
  $streams = @(
    [pscustomobject]@{ name = 'stdout'; stream = $process.StandardOutput.BaseStream; buffer = [byte[]]::new(65537); count = 0; task = $null; ended = $false },
    [pscustomobject]@{ name = 'stderr'; stream = $process.StandardError.BaseStream; buffer = [byte[]]::new(65537); count = 0; task = $null; ended = $false }
  )
  foreach ($state in $streams) { $state.task = $state.stream.ReadAsync($state.buffer, 0, $state.buffer.Length) }
  $deadline = [Environment]::TickCount64 + 15000
  while ($true) {
    foreach ($state in $streams) {
      if (-not $state.ended -and $state.task.IsCompleted) {
        $read = $state.task.GetAwaiter().GetResult()
        $state.count += $read
        if ($state.count -gt 65536) { $result.outputLimitExceeded = $true; break }
        if ($read -eq 0) { $state.ended = $true }
        else { $state.task = $state.stream.ReadAsync($state.buffer, $state.count, $state.buffer.Length - $state.count) }
      }
    }
    if ($result.outputLimitExceeded -or ($process.HasExited -and $streams[0].ended -and $streams[1].ended)) { break }
    if ([Environment]::TickCount64 -ge $deadline) { $result.timedOut = $true; break }
    [Threading.Thread]::Sleep(10)
  }
  if (-not $process.HasExited) { $process.Kill() }
  if (-not $process.WaitForExit(5000)) { throw 'Owned direct probe did not terminate after kill' }
  $result.exitCode = $process.ExitCode
  $result.cleanupVerified = $true
  foreach ($state in $streams) { $result[$state.name] = [Convert]::ToBase64String($state.buffer, 0, [Math]::Min($state.count, 65536)) }
} catch {
  $result.error = $_.Exception.Message.Substring(0, [Math]::Min($_.Exception.Message.Length, 4096))
} finally {
  if ($null -ne $process) {
    try {
      if (-not $process.HasExited) { $process.Kill() }
      if ($process.WaitForExit(5000)) { $result.cleanupVerified = $true; $result.exitCode = $process.ExitCode }
    } catch { $result.cleanupVerified = $false }
    $process.Dispose()
  }
}
[Console]::Out.WriteLine((Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $result -Depth 4 -Compress))
if ($null -ne $result.error -or -not $result.cleanupVerified) { exit 1 }
