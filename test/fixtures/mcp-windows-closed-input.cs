// SPDX-License-Identifier: Apache-2.0
// Harmless owned console fixture, without a PowerShell or Node target host.
// Verify stdin closure before file or console I/O can reuse the handle.
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
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
  [DllImport("kernel32.dll")]
  static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool WriteFile(IntPtr handle, byte[] bytes, uint count, out uint written, IntPtr overlapped);

  public static void Main(string[] args) {
    if (args.Length != 2) throw new ArgumentException("Owned fixture requires log and PID paths");
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
    File.WriteAllText(args[1], GetCurrentProcessId().ToString(CultureInfo.InvariantCulture));
    File.AppendAllText(args[0], "{\"event\":\"start\"}\n{\"event\":\"stdin-handle-closed\",\"originalHandleInvalid\":true}\n");
    IntPtr errorOutput = GetStdHandle(-12); // STD_ERROR_HANDLE
    if (errorOutput == IntPtr.Zero || errorOutput == new IntPtr(-1))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned fixture stderr handle");
    byte[] marker = Encoding.ASCII.GetBytes("native-stdin-closed\n");
    uint written;
    if (!WriteFile(errorOutput, marker, (uint)marker.Length, out written, IntPtr.Zero))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned fixture readiness write");
    if (written != (uint)marker.Length)
      throw new IOException("Owned fixture readiness write was incomplete");
    Thread.Sleep(Timeout.Infinite);
  }
}
