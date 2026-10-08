# SPDX-License-Identifier: Apache-2.0
# Harmless owned fixture: close this process's original stdin HANDLE and wait.
# Node's Windows fs.closeSync(0) deliberately succeeds without closing fd 0.
param([string]$Log, [string]$PidFile)
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Owned fixture requires FullLanguage' }
$expectedHome = [IO.Path]::GetFullPath([IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0'))
if (-not [String]::Equals($PSHOME, $expectedHome, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected system PowerShell installation' }
$moduleDirectory = [IO.Path]::Combine($expectedHome, 'Modules')
$manifest = [IO.Path]::Combine($moduleDirectory, 'Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
if (-not [IO.File]::Exists($manifest) -or ([IO.File]::GetAttributes($manifest) -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint))) { throw 'Unexpected built-in Utility manifest' }
$ancestor = [IO.Path]::GetDirectoryName($manifest)
while (-not [String]::IsNullOrEmpty($ancestor)) {
  if ([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected built-in Utility ancestor' }
  $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
[Environment]::SetEnvironmentVariable('PSModulePath', $moduleDirectory)
Import-Module -Name $manifest -ErrorAction Stop
$source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class ViviOwnedClosedInputFixture {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr GetStdHandle(int identifier);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetHandleInformation(IntPtr handle, out uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetStdHandle(int identifier, IntPtr handle);

  public static void Run(string log) {
    IntPtr input = GetStdHandle(-10); // STD_INPUT_HANDLE
    if (input == IntPtr.Zero || input == new IntPtr(-1))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned fixture GetStdHandle");
    if (!CloseHandle(input))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned fixture CloseHandle");
    uint flags;
    if (GetHandleInformation(input, out flags))
      throw new InvalidOperationException("Owned fixture stdin handle remains valid");
    if (Marshal.GetLastWin32Error() != 6) // ERROR_INVALID_HANDLE
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned fixture invalid handle verification");
    if (!SetStdHandle(-10, IntPtr.Zero))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned fixture SetStdHandle");
    File.AppendAllText(log, "{\"event\":\"stdin-handle-closed\",\"originalHandleInvalid\":true}\n");
    Console.Error.Write("native-stdin-closed\n");
    Console.Error.Flush();
    Thread.Sleep(Timeout.Infinite);
  }
}
'@
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $source -ErrorAction Stop
[IO.File]::WriteAllText($PidFile, [string]$PID)
$event = @{ event = 'start'; env = @([Environment]::GetEnvironmentVariables().Keys) }
$json = Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $event -Compress
[IO.File]::AppendAllText($Log, $json + "`n")
[ViviOwnedClosedInputFixture]::Run($Log)
