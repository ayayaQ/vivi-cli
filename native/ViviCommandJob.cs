
using System;
using System.Text;
using System.IO;
using System.Threading;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ViviCommandJob {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint WAIT_OBJECT_0 = 0;
  static readonly IntPtr HANDLE_LIST = new IntPtr(0x00020002);
  static readonly IntPtr JOB_LIST = new IntPtr(0x0002000D);
  static readonly object outputLock = new object();
  static readonly object jobLock = new object();
  static IntPtr activeJob = IntPtr.Zero;
  static bool cancelled = false;
  static Exception pumpError;
  public static bool Diagnostics = false;

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
    public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public uint cb; public IntPtr reserved; public IntPtr desktop; public IntPtr title;
    public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
    public ushort show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
    public STARTUPINFO startup; public IntPtr attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr process, thread; public uint processId, threadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minWorkingSet, maxWorkingSet; public uint activeProcessLimit;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
    public BASIC_LIMITS basic; public IO_COUNTERS io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
    public long user, kernel, periodUser, periodKernel;
    public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMITS limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ACCOUNTING info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
    ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static void Close(ref IntPtr handle) {
    if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
  }
  static void Emit(string type, byte[] bytes, int count) {
    lock (outputLock) {
      Console.Out.WriteLine("{\"type\":\"" + type + "\",\"data\":\"" + Convert.ToBase64String(bytes, 0, count) + "\"}");
      Console.Out.Flush();
    }
  }
  static void Phase(string phase) {
    if (!Diagnostics) return;
    try {
      lock (outputLock) {
        Console.Out.WriteLine("{\"type\":\"phase\",\"phase\":\"" + phase + "\"}");
        Console.Out.Flush();
      }
    } catch (Exception) { /* Diagnostic failure must never skip job cleanup. */ }
  }
  static void EmitError(Exception error) {
    byte[] bytes = Encoding.UTF8.GetBytes(error.Message); Emit("error", bytes, bytes.Length);
  }
  static Thread Pump(IntPtr read, string type) {
    Thread thread = new Thread(delegate() {
      try {
        Phase(type == "stdout" ? "stdout-pump-start" : "stderr-pump-start");
        using (FileStream stream = new FileStream(new SafeFileHandle(read, true), FileAccess.Read, 4096, false)) {
          byte[] bytes = new byte[4096]; int count;
          while ((count = stream.Read(bytes, 0, bytes.Length)) > 0) Emit(type, bytes, count);
        }
        Phase(type == "stdout" ? "stdout-pump-eof" : "stderr-pump-eof");
      } catch (Exception error) { lock (outputLock) { if (pumpError == null) pumpError = error; } }
    });
    thread.IsBackground = true; thread.Start(); return thread;
  }
  // Windows argv serialization for the standard C runtime parser. This is data
  // encoding, never shell syntax. Empty arguments and trailing slashes survive.
  static string Quote(string value) {
    StringBuilder result = new StringBuilder("\""); int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
      else { result.Append('\\', slashes); result.Append(character); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  static void StopOnInputEnd() {
    Phase("control-read-start");
    try { while (Console.In.ReadLine() != null) {} Phase("control-eof"); }
    catch (IOException) { Phase("control-read-error"); }
    lock (jobLock) {
      cancelled = true;
      if (activeJob != IntPtr.Zero) TerminateJobObject(activeJob, 1);
    }
  }
  static void WaitForEmptyJob(IntPtr job) {
    while (true) {
      ACCOUNTING accounting;
      Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero), "QueryInformationJobObject");
      if (accounting.activeProcesses == 0) return;
      Thread.Sleep(10);
    }
  }

  public static void Run(string executable, string[] args, string cwd, Dictionary<string,string> env) {
    IntPtr job = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
    IntPtr errRead = IntPtr.Zero, errWrite = IntPtr.Zero, inRead = IntPtr.Zero, inWrite = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, handleMemory = IntPtr.Zero, jobMemory = IntPtr.Zero, environment = IntPtr.Zero;
    bool attributesReady = false, prelaunchCancelled = false, cleanupVerified = false;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    Thread outPump = null, errPump = null; uint exitCode = 1; Exception failure = null;
    Phase("native-run-start");
    try {
      job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW");
      Phase("job-created");
      EXTENDED_LIMITS limits = new EXTENDED_LIMITS(); limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMITS))), "SetInformationJobObject");
      lock (jobLock) { activeJob = job; }
      Phase("job-ready");
      Thread control = new Thread(StopOnInputEnd); control.IsBackground = true; control.Start();

      SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES(); security.length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); security.inherit = true;
      Check(CreatePipe(out outRead, out outWrite, ref security, 0), "CreatePipe stdout");
      Check(CreatePipe(out errRead, out errWrite, ref security, 0), "CreatePipe stderr");
      Check(CreatePipe(out inRead, out inWrite, ref security, 0), "CreatePipe stdin");
      Check(SetHandleInformation(outRead, 1, 0), "SetHandleInformation stdout");
      Check(SetHandleInformation(errRead, 1, 0), "SetHandleInformation stderr");
      Check(SetHandleInformation(inWrite, 1, 0), "SetHandleInformation stdin");
      // Closing the sole writer gives the approved command stdin EOF.
      Close(ref inWrite);
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Attribute list size");
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "InitializeProcThreadAttributeList");
      attributesReady = true;
      handleMemory = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handleMemory, 0, inRead); Marshal.WriteIntPtr(handleMemory, IntPtr.Size, outWrite); Marshal.WriteIntPtr(handleMemory, IntPtr.Size * 2, errWrite);
      Check(UpdateProcThreadAttribute(attributes, 0, HANDLE_LIST, handleMemory, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "Handle allowlist");
      jobMemory = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobMemory, job);
      // Atomic job assignment prevents stranding even a suspended child if this
      // helper is terminated between CreateProcessW and ResumeThread.
      Check(UpdateProcThreadAttribute(attributes, 0, JOB_LIST, jobMemory, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Atomic job assignment (Windows 10+ required)");
      List<string> keys = new List<string>(env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
      StringBuilder block = new StringBuilder();
      foreach (string key in keys) { block.Append(key); block.Append('='); block.Append(env[key]); block.Append('\0'); }
      block.Append('\0'); if (keys.Count == 0) block.Append('\0');
      environment = Marshal.StringToHGlobalUni(block.ToString());
      StringBuilder command = new StringBuilder(Quote(executable));
      foreach (string argument in args) { command.Append(' '); command.Append(Quote(argument)); }
      if (command.Length >= 32767) throw new ArgumentException("Windows command line exceeds 32766 UTF-16 code units");
      STARTUPINFOEX startup = new STARTUPINFOEX(); startup.startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.startup.flags = STARTF_USESTDHANDLES; startup.startup.stdin = inRead; startup.startup.stdout = outWrite; startup.startup.stderr = errWrite; startup.attributes = attributes;
      lock (jobLock) {
        if (cancelled) throw new OperationCanceledException("Command cancelled before execution");
        Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
          environment, cwd, ref startup, out process), "CreateProcessW");
        Phase("process-created");
        if (ResumeThread(process.thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
        Phase("process-resumed");
      }
      Close(ref inRead); Close(ref outWrite); Close(ref errWrite); Close(ref process.thread);
      outPump = Pump(outRead, "stdout"); outRead = IntPtr.Zero;
      errPump = Pump(errRead, "stderr"); errRead = IntPtr.Zero;
      if (WaitForSingleObject(process.process, UInt32.MaxValue) != WAIT_OBJECT_0)
        throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
      Phase("root-exit");
      Check(GetExitCodeProcess(process.process, out exitCode), "GetExitCodeProcess");
    } catch (Exception error) {
      prelaunchCancelled = error is OperationCanceledException && process.process == IntPtr.Zero && cancelled;
      failure = error;
    }
    finally {
      // Root exit does not imply tree exit. Always terminate the job, verify no
      // remaining members, then drain the now-closed pipes before reporting done.
      if (job != IntPtr.Zero) {
        try { Phase("job-terminate-start"); Check(TerminateJobObject(job, 1), "TerminateJobObject"); WaitForEmptyJob(job); cleanupVerified = true; Phase("job-empty"); }
        catch (Exception error) { failure = error; }
      }
      Close(ref inRead); Close(ref inWrite); Close(ref outWrite); Close(ref errWrite);
      Phase("pumps-join-start");
      if (outPump != null) outPump.Join(); if (errPump != null) errPump.Join();
      Phase("pumps-finished");
      if (failure == null && pumpError != null) failure = pumpError;
      Close(ref outRead); Close(ref errRead); Close(ref process.thread); Close(ref process.process);
      lock (jobLock) { activeJob = IntPtr.Zero; Close(ref job); }
      if (attributesReady) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (handleMemory != IntPtr.Zero) Marshal.FreeHGlobal(handleMemory);
      if (jobMemory != IntPtr.Zero) Marshal.FreeHGlobal(jobMemory);
      if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
    }
    Phase("native-cleanup-finished");
    // Cancellation before creation is a stopped command only after verifying
    // the job is empty. Never hide a cleanup or output-pump error as cancellation.
    if (prelaunchCancelled && cleanupVerified && failure is OperationCanceledException && pumpError == null) failure = null;
    if (failure != null) { EmitError(failure); return; }
    string reportedExitCode = prelaunchCancelled ? "null" : exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture);
    lock (outputLock) {
      Console.Out.WriteLine("{\"type\":\"exit\",\"exitCode\":" + reportedExitCode + ",\"stopped\":" + (cancelled ? "true" : "false") + "}");
      Console.Out.Flush();
    }
  }
}
