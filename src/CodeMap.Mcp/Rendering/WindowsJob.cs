using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

namespace CodeMap.Mcp.Rendering;

/// <summary>
/// A Windows job object that kills its processes when its last handle closes, so a browser started for rendering dies
/// with codemap even when codemap itself is killed (TerminateProcess cannot be caught, so no cleanup code would run).
/// </summary>
[SupportedOSPlatform("windows")]
internal static class WindowsJob
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;
    // A child that asks to leave the job may (else its start would fail): the browser process itself stays in the job,
    // and its helpers end when it does.
    private const uint JobObjectLimitBreakawayOk = 0x800;

    /// <summary>Puts the process (and what it starts from now on) in a new kill-on-close job; null when Windows refuses.</summary>
    public static SafeFileHandle? KillOnClose(Process process, TextWriter log)
    {
        var job = CreateJobObjectW(IntPtr.Zero, null);
        if (job.IsInvalid)
        {
            log.WriteLine($"render: no job object for the browser (error {Marshal.GetLastWin32Error()}); it is closed with the session only.");
            job.Dispose();
            return null;
        }

        var limits = new JobObjectExtendedLimit { BasicLimitInformation = new JobObjectBasicLimit { LimitFlags = JobObjectLimitKillOnJobClose | JobObjectLimitBreakawayOk } };
        var size = Marshal.SizeOf<JobObjectExtendedLimit>();
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)size) || !AssignProcessToJobObject(job, process.Handle))
        {
            log.WriteLine($"render: the browser could not be tied to codemap (error {Marshal.GetLastWin32Error()}); it is closed with the session only.");
            job.Dispose();
            return null;
        }

        return job;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimit
    {
        public JobObjectBasicLimit BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref JobObjectExtendedLimit info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
}
