// SPDX-License-Identifier: Apache-2.0
// Private, headless OS ConPTY host. No console attachment, hooks, SendInput, or desktop APIs.
// HANDLE/HPCON/pointers use IntPtr throughout; DWORD/BOOL are 32-bit.
using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class ConPtyProbeResult
{
    public int ExitCode;
    public int Queries;
    public int QueryReplies;
    public int OuterEnablesAtReady;
    public int OuterEnablesBeforeTeardown;
    public int OuterDisablesBeforeTeardown;
    public int OuterRestorationReassertions;
    public bool OuterModeAtRestore;
    public bool OutputDrained;
    public bool TeardownCompleted;
    public string OsVersion;
    public string ConhostVersion;
}

public sealed class ConPtyProbeHost : IDisposable
{
    public static string Phase = "Setup";
    public static ConPtyProbeResult Progress = new ConPtyProbeResult();
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO
    {
        public uint cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct JOB_BASIC_LIMITS
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS
    { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct JOB_EXTENDED_LIMITS
    {
        public JOB_BASIC_LIMITS BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOB_EXTENDED_LIMITS info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, uint size);
    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr pseudoConsole);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr pseudoConsole);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr handle, byte[] buffer, uint length, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr handle, byte[] buffer, uint length, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint size, IntPtr read, out uint available, IntPtr remaining);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, uint threadId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CancelSynchronousIo(IntPtr thread);

    IntPtr inputRead, inputWrite, outputRead, outputWrite, pseudoConsole, attributes, job;
    PROCESS_INFORMATION process;
    bool attributesInitialized;
    Thread reader, writer;
    readonly BlockingCollection<byte[]> pendingWrites = new BlockingCollection<byte[]>(64);
    readonly ManualResetEventSlim writerStarted = new ManualResetEventSlim(false);
    uint writerId;
    volatile bool stopReader, disposing;
    volatile Exception workerFailure;
    readonly object stateLock = new object();
    int queries, replies, enables, disables, reassertions;
    bool awaitingReassertion;
    bool outerMode = true; // Model an outer terminal already in mode 9001, as Windows Terminal normally is.
    bool outputDrained, teardownCompleted;
    int outputBytes;
    string csi = ""; // At most 64 bytes, control sequences only; ordinary output is discarded.

    static void Check(bool succeeded, string operation)
    {
        if (!succeeded) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static void Close(ref IntPtr handle)
    {
        IntPtr value = handle; handle = IntPtr.Zero;
        if (value != IntPtr.Zero && value != new IntPtr(-1)) CloseHandle(value);
    }
    static string Quote(string value)
    {
        // CommandLineToArgvW quoting, including embedded quotes and trailing backslashes.
        StringBuilder quoted = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') quoted.Append('\\', slashes * 2 + 1);
            else quoted.Append('\\', slashes);
            slashes = 0; quoted.Append(ch);
        }
        quoted.Append('\\', slashes * 2); quoted.Append('"'); return quoted.ToString();
    }
    static string CharacterRecords(string text)
    {
        StringBuilder records = new StringBuilder();
        foreach (char ch in text) records.Append("\x1b[0;0;").Append((int)ch).Append(";1;0;1_");
        return records.ToString();
    }
    void Queue(string text)
    {
        if (disposing || !pendingWrites.TryAdd(Encoding.UTF8.GetBytes(text), 500))
            throw new InvalidOperationException("Private ConPTY input queue unavailable");
    }
    void CheckWorker()
    {
        Exception failure = workerFailure;
        if (failure != null) throw new InvalidOperationException("Private ConPTY I/O failed", failure);
    }
    void Control(string sequence)
    {
        if (sequence == "\x1b[?9001h") { lock (stateLock) { enables++; outerMode = true;
            if (awaitingReassertion) { reassertions++; awaitingReassertion = false; } } }
        else if (sequence == "\x1b[?9001l") { lock (stateLock) { disables++; outerMode = false; awaitingReassertion = true; } }
        else if (sequence == "\x1b[?9001$p")
        {
            lock (stateLock) queries++;
            // Deliberately use Win32 Unicode-character records for the forwarded DECRQM reply.
            // ConPTY must consume these outer records and generate input for the real Bun child.
            Queue(CharacterRecords("\x1b[?9001;1$y"));
            lock (stateLock) replies++;
        }
        else if (sequence == "\x1b[c" || sequence == "\x1b[0c") Queue("\x1b[?61;4c");
        else if (sequence == "\x1b[6n") Queue("\x1b[1;1R");
        lock (stateLock)
        {
            Progress.Queries = queries; Progress.QueryReplies = replies;
            Progress.OuterEnablesBeforeTeardown = enables; Progress.OuterDisablesBeforeTeardown = disables;
            Progress.OuterRestorationReassertions = reassertions; Progress.OuterModeAtRestore = outerMode;
        }
    }
    void ParseOutput(byte[] buffer, int length)
    {
        for (int i = 0; i < length; i++)
        {
            byte ch = buffer[i];
            if (ch == 27) { csi = "\x1b"; continue; }
            if (csi.Length == 0) continue;
            if (csi.Length == 1)
            {
                csi = ch == (byte)'[' ? "\x1b[" : "";
                continue;
            }
            if (ch < 32 || ch > 126 || csi.Length >= 64) { csi = ""; continue; }
            csi += (char)ch;
            if (ch >= 64 && ch <= 126) { string complete = csi; csi = ""; Control(complete); }
        }
    }
    void ReadOutput()
    {
        try
        {
            byte[] buffer = new byte[4096];
            while (!stopReader)
            {
                uint available;
                if (!PeekNamedPipe(outputRead, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 109 || error == 232) { outputDrained = true; return; }
                    if (disposing) return;
                    throw new Win32Exception(error, "PeekNamedPipe");
                }
                if (available == 0) { Thread.Sleep(2); continue; }
                uint count;
                Check(ReadFile(outputRead, buffer, Math.Min(available, (uint)buffer.Length), out count, IntPtr.Zero), "ReadFile");
                outputBytes += (int)count;
                if (outputBytes > 1024 * 1024) throw new InvalidOperationException("Private probe exceeded output budget");
                ParseOutput(buffer, (int)count);
            }
        }
        catch (Exception error) { if (!disposing) workerFailure = error; }
    }
    void WriteInput()
    {
        writerId = GetCurrentThreadId(); writerStarted.Set();
        try
        {
            foreach (byte[] bytes in pendingWrites.GetConsumingEnumerable())
            {
                uint written;
                Check(WriteFile(inputWrite, bytes, (uint)bytes.Length, out written, IntPtr.Zero), "WriteFile");
                if (written != bytes.Length) throw new InvalidOperationException("Short private ConPTY write");
            }
        }
        catch (Exception error) { if (!disposing) workerFailure = error; }
    }
    void Start(string bun, string child, string repository, string prefix)
    {
        // An unnamed, private kill-on-close job contains only this synthetic Bun child and its descendants.
        // If the supervisor is killed at its outer deadline, the OS closes the job handle and kills the child.
        job = CreateJobObjectW(IntPtr.Zero, null);
        Check(job != IntPtr.Zero, "CreateJobObjectW");
        JOB_EXTENDED_LIMITS limits = new JOB_EXTENDED_LIMITS();
        limits.BasicLimitInformation.LimitFlags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JOB_EXTENDED_LIMITS))), "SetInformationJobObject");
        Check(CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 4096), "CreatePipe(input)");
        Check(CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 4096), "CreatePipe(output)");
        Phase = "CreatePseudoConsole";
        int result = CreatePseudoConsole(new COORD { X = 100, Y = 30 }, inputRead, outputWrite, 0, out pseudoConsole);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        // Drain on another thread even during creation and ClosePseudoConsole.
        writer = new Thread(WriteInput); writer.IsBackground = true; writer.Start();
        if (!writerStarted.Wait(2000)) throw new TimeoutException("Private writer did not start");
        reader = new Thread(ReadOutput); reader.IsBackground = true; reader.Start();
        UIntPtr size = UIntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        if (size == UIntPtr.Zero || size.ToUInt64() > 1024 * 1024) throw new InvalidOperationException("Invalid attribute-list size");
        attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
        Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "InitializeProcThreadAttributeList");
        attributesInitialized = true;
        // PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016. lpValue is the HPCON itself, not &HPCON.
        Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020016), pseudoConsole,
            new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(PSEUDOCONSOLE)");
        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.lpAttributeList = attributes;
        StringBuilder command = new StringBuilder(Quote(bun) + " --no-env-file --no-install " + Quote(child) + " " + Quote(repository) + " " + Quote(prefix));
        Phase = "AttachBun";
        Check(CreateProcessW(bun, command, IntPtr.Zero, IntPtr.Zero, false, 0x00080004, IntPtr.Zero,
            repository, ref startup, out process), "CreateProcessW(Bun)");
        // Start suspended so no Bun code runs before private job containment is established.
        Check(AssignProcessToJobObject(job, process.hProcess), "AssignProcessToJobObject(Bun)");
        Check(ResumeThread(process.hThread) != 0xffffffff, "ResumeThread(Bun)");
        Close(ref process.hThread);
        // Drop host references to the ends owned by ConPTY after the process is attached.
        Close(ref inputRead); Close(ref outputWrite);
        DeleteProcThreadAttributeList(attributes); attributesInitialized = false;
        Marshal.FreeHGlobal(attributes); attributes = IntPtr.Zero;
    }
    void WaitMarker(string path, int milliseconds)
    {
        Stopwatch deadline = Stopwatch.StartNew();
        while (!File.Exists(path))
        {
            CheckWorker();
            if (WaitForSingleObject(process.hProcess, 0) == 0)
            {
                uint exited; if (GetExitCodeProcess(process.hProcess, out exited)) Progress.ExitCode = unchecked((int)exited);
                throw new InvalidOperationException("Private Bun child exited before marker");
            }
            if (deadline.ElapsedMilliseconds >= milliseconds)
            {
                uint state; if (GetExitCodeProcess(process.hProcess, out state)) Progress.ExitCode = unchecked((int)state);
                throw new TimeoutException("Private Bun child marker timeout");
            }
            Thread.Sleep(5);
        }
        CheckWorker();
    }
    void WaitInputDrained(int milliseconds)
    {
        // Queue emptiness does not imply WriteFile completed. Probe markers are the acknowledgement.
        CheckWorker(); Thread.Sleep(milliseconds); CheckWorker();
    }
    void WaitRestorationPair(int milliseconds)
    {
        Stopwatch deadline = Stopwatch.StartNew();
        while (true)
        {
            CheckWorker();
            lock (stateLock) { if (disables > 0 && reassertions > 0 && outerMode) return; }
            if (deadline.ElapsedMilliseconds >= milliseconds) throw new TimeoutException("Outer reset/reassertion acknowledgement timeout");
            Thread.Sleep(5);
        }
    }
    public static ConPtyProbeResult Run(string bun, string child, string repository, string prefix,
        string basic, string repeats, string paste, string finish, string restore, bool expectReset)
    {
        ConPtyProbeResult result = new ConPtyProbeResult();
        // Live failure diagnostics must never alias the frozen success result:
        // conhost shutdown may emit additional resets after consumer restoration.
        Progress = new ConPtyProbeResult { ExitCode = -1 };
        result.OsVersion = Environment.OSVersion.Version.ToString();
        string conhost = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "conhost.exe");
        result.ConhostVersion = FileVersionInfo.GetVersionInfo(conhost).FileVersion;
        Progress.OsVersion = result.OsVersion; Progress.ConhostVersion = result.ConhostVersion;
        using (ConPtyProbeHost host = new ConPtyProbeHost())
        {
            host.Start(bun, child, repository, prefix);
            Phase = "Negotiate";
            host.WaitMarker(prefix + ".ready", 12000);
            lock (host.stateLock) result.OuterEnablesAtReady = host.enables;
            // Split complete frames as well as one frame mid-parameter. Only known synthetic probes are sent.
            Phase = "Probe";
            int split = Math.Min(7, basic.Length);
            host.Queue(basic.Substring(0, split)); host.WaitInputDrained(10); host.Queue(basic.Substring(split));
            host.Queue(repeats);
            // Paste is normal terminal text, not encoded key records. The host never reads a clipboard.
            host.Queue(paste);
            host.Queue(finish);
            Phase = "Restore";
            host.WaitMarker(prefix + ".restore-ready", 8000);
            if (expectReset) host.WaitRestorationPair(3000);
            lock (host.stateLock)
            {
                result.OuterEnablesBeforeTeardown = host.enables;
                result.OuterDisablesBeforeTeardown = host.disables;
                result.OuterRestorationReassertions = host.reassertions;
                result.OuterModeAtRestore = host.outerMode;
            }
            host.Queue(restore);
            Phase = "Exit";
            uint waited = WaitForSingleObject(host.process.hProcess, 7000);
            if (waited != 0) throw new TimeoutException("Private Bun child did not exit");
            uint exitCode; Check(GetExitCodeProcess(host.process.hProcess, out exitCode), "GetExitCodeProcess");
            result.ExitCode = checked((int)exitCode);
            lock (host.stateLock) { result.Queries = host.queries; result.QueryReplies = host.replies; }
            host.CheckWorker();
            Phase = "Teardown";
            host.Dispose();
            result.OutputDrained = host.outputDrained;
            result.TeardownCompleted = host.teardownCompleted;
            if (!result.TeardownCompleted) throw new TimeoutException("Private ConPTY teardown did not complete");
        }
        return result;
    }
    void CancelWriter()
    {
        IntPtr thread = OpenThread(0x0001, false, writerId); // THREAD_TERMINATE is required by CancelSynchronousIo.
        if (thread != IntPtr.Zero) { CancelSynchronousIo(thread); CloseHandle(thread); }
    }
    public void Dispose()
    {
        if (disposing) return;
        disposing = true;
        if (process.hProcess != IntPtr.Zero && WaitForSingleObject(process.hProcess, 0) != 0)
        { TerminateProcess(process.hProcess, 1); WaitForSingleObject(process.hProcess, 2000); }
        Close(ref job); // Kill any private descendants even when the direct child already exited.
        bool processStopped = process.hProcess == IntPtr.Zero || WaitForSingleObject(process.hProcess, 2000) == 0;
        pendingWrites.CompleteAdding();
        bool writerStopped = writer == null || writer.Join(1500);
        if (!writerStopped) { CancelWriter(); writerStopped = writer.Join(1500); }
        Close(ref inputWrite); Close(ref inputRead); Close(ref outputWrite);
        if (pseudoConsole != IntPtr.Zero)
        {
            IntPtr value = pseudoConsole; pseudoConsole = IntPtr.Zero;
            Thread closer = new Thread(delegate() { ClosePseudoConsole(value); }); closer.IsBackground = true; closer.Start();
            // Keep output drainage alive until close completes, as Microsoft requires.
            teardownCompleted = closer.Join(4000);
            if (!teardownCompleted)
            {
                stopReader = true;
                if (reader != null) reader.Join(1000);
                Close(ref outputRead); // Break a blocked conhost write before one bounded teardown retry.
                teardownCompleted = closer.Join(4000);
            }
        }
        else teardownCompleted = true;
        // Wait for the output pipe to report broken after ConPTY closes its writer.
        // Only that observation establishes successful complete drainage.
        bool readerStopped = reader == null || reader.Join(1000);
        stopReader = true;
        if (!readerStopped) readerStopped = reader.Join(1000);
        teardownCompleted = teardownCompleted && processStopped && writerStopped && readerStopped;
        Progress.OutputDrained = outputDrained; Progress.TeardownCompleted = teardownCompleted;
        Close(ref outputRead); Close(ref process.hProcess); Close(ref process.hThread);
        if (attributes != IntPtr.Zero)
        {
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes); attributes = IntPtr.Zero;
        }
        if (writerStopped) { pendingWrites.Dispose(); writerStarted.Dispose(); }
    }
}
