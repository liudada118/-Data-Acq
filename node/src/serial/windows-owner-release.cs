using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Synapse.Serial
{
    public sealed class OwnerReleaseResult
    {
        public bool released;
        public uint pid;
        public string creationTime;
        public string reason;
        public int win32Error;
    }

    // A small native boundary permits deterministic refusal-path tests without
    // touching any real process. The PowerShell entry calls only Release().
    internal interface IWindowsReleaseApi
    {
        uint CurrentPid { get; }
        string CurrentSid { get; }
        IntPtr Open(uint pid, out int error);
        bool ReadCreation(IntPtr process, out ulong creation, out int error);
        bool ReadOwner(IntPtr process, out string sid, out uint session, out int error);
        bool ReadCritical(IntPtr process, out bool critical, out int error);
        bool Terminate(IntPtr process, out int error);
        uint Wait(IntPtr process, uint timeout, out int error);
        void Close(IntPtr process);
    }

    public static class WindowsOwnerRelease
    {
        public static OwnerReleaseResult Release(uint pid, string creationTime, uint[] protectedPids, int waitMs)
        {
            return ReleaseCore(pid, creationTime, protectedPids, waitMs, new WindowsReleaseApi());
        }

        internal static OwnerReleaseResult ReleaseCore(uint pid, string creationTime, uint[] protectedPids,
            int waitMs, IWindowsReleaseApi api)
        {
            OwnerReleaseResult result = new OwnerReleaseResult { pid = pid, creationTime = creationTime };
            ulong expected;
            if (pid == 0 || !UInt64.TryParse(creationTime, NumberStyles.None, CultureInfo.InvariantCulture, out expected) ||
                expected == 0 || waitMs < 100 || waitMs > 2000)
                return Refuse(result, "invalid_owner", 0);
            result.creationTime = expected.ToString(CultureInfo.InvariantCulture);
            if (pid == 4 || pid == api.CurrentPid || (protectedPids != null && Array.IndexOf(protectedPids, pid) >= 0))
                return Refuse(result, "protected_process", 0);

            int error;
            // Exactly one OpenProcess. This object identity remains held through
            // every verification, TerminateProcess, and the bounded exit wait.
            IntPtr process = api.Open(pid, out error);
            if (process == IntPtr.Zero)
                return Refuse(result, error == 5 ? "access_denied" : error == 87 ? "already_exited" : "owner_unverifiable", error);
            try
            {
                ulong actual;
                if (!api.ReadCreation(process, out actual, out error)) return Refuse(result, "owner_unverifiable", error);
                if (actual != expected) return Refuse(result, "owner_changed", 0);
                uint state = api.Wait(process, 0, out error);
                if (state == 0) return Refuse(result, "already_exited", 0);
                if (state != 258) return Refuse(result, "owner_unverifiable", error);

                string sid;
                uint session;
                if (!api.ReadOwner(process, out sid, out session, out error))
                    return Refuse(result, error == 5 ? "access_denied" : "owner_unverifiable", error);
                string currentSid = api.CurrentSid;
                if (String.IsNullOrEmpty(sid) || String.IsNullOrEmpty(currentSid)) return Refuse(result, "owner_unverifiable", 0);
                if (!String.Equals(sid, currentSid, StringComparison.Ordinal)) return Refuse(result, "different_user", 0);
                if (session == 0) return Refuse(result, "session_zero", 0);

                bool critical;
                if (!api.ReadCritical(process, out critical, out error)) return Refuse(result, "owner_unverifiable", error);
                if (critical) return Refuse(result, "critical_process", 0);
                if (!api.Terminate(process, out error))
                    return Refuse(result, error == 5 ? "access_denied" : "termination_failed", error);
                state = api.Wait(process, (uint)waitMs, out error);
                if (state != 0) return Refuse(result, state == 258 ? "wait_timeout" : "termination_failed", error);
                result.released = true;
                result.reason = "released";
                return result;
            }
            catch
            {
                return Refuse(result, "owner_unverifiable", 0);
            }
            finally { api.Close(process); }
        }

        private static OwnerReleaseResult Refuse(OwnerReleaseResult result, string reason, int error)
        {
            result.released = false; result.reason = reason; result.win32Error = error;
            return result;
        }
    }

    internal sealed class WindowsReleaseApi : IWindowsReleaseApi
    {
        private const uint ProcessTerminate = 0x0001;
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint Synchronize = 0x00100000;
        private const uint TokenQuery = 0x0008;

        [StructLayout(LayoutKind.Sequential)]
        private struct FileTime
        {
            public uint Low;
            public uint High;
            public ulong Value { get { return ((ulong)High << 32) | Low; } }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessCritical(IntPtr process, [MarshalAs(UnmanagedType.Bool)] out bool critical);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr process, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int size, out int needed);

        public uint CurrentPid { get { return GetCurrentProcessId(); } }
        public string CurrentSid
        {
            get { using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) { return identity.User == null ? null : identity.User.Value; } }
        }

        public IntPtr Open(uint pid, out int error)
        {
            IntPtr process = OpenProcess(ProcessTerminate | ProcessQueryLimitedInformation | Synchronize, false, pid);
            error = process == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            return process;
        }
        public bool ReadCreation(IntPtr process, out ulong creation, out int error)
        {
            FileTime created, exited, kernel, user;
            bool ok = GetProcessTimes(process, out created, out exited, out kernel, out user);
            error = ok ? 0 : Marshal.GetLastWin32Error(); creation = created.Value;
            return ok;
        }
        public bool ReadOwner(IntPtr process, out string sid, out uint session, out int error)
        {
            sid = null; session = 0; error = 0;
            IntPtr token;
            if (!OpenProcessToken(process, TokenQuery, out token)) { error = Marshal.GetLastWin32Error(); return false; }
            try
            {
                int needed;
                GetTokenInformation(token, 1, IntPtr.Zero, 0, out needed); // TokenUser
                if (needed <= 0 || needed > 65536) { error = Marshal.GetLastWin32Error(); return false; }
                IntPtr buffer = Marshal.AllocHGlobal(needed);
                try
                {
                    if (!GetTokenInformation(token, 1, buffer, needed, out needed)) { error = Marshal.GetLastWin32Error(); return false; }
                    sid = new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
                }
                finally { Marshal.FreeHGlobal(buffer); }
                buffer = Marshal.AllocHGlobal(4);
                try
                {
                    // Query the token on the held process, not a second PID lookup.
                    if (!GetTokenInformation(token, 12, buffer, 4, out needed) || needed != 4)
                    { error = Marshal.GetLastWin32Error(); return false; } // TokenSessionId
                    session = unchecked((uint)Marshal.ReadInt32(buffer));
                }
                finally { Marshal.FreeHGlobal(buffer); }
                return true;
            }
            finally { CloseHandle(token); }
        }
        public bool ReadCritical(IntPtr process, out bool critical, out int error)
        {
            bool ok = IsProcessCritical(process, out critical);
            error = ok ? 0 : Marshal.GetLastWin32Error(); return ok;
        }
        public bool Terminate(IntPtr process, out int error)
        {
            bool ok = TerminateProcess(process, 1);
            error = ok ? 0 : Marshal.GetLastWin32Error(); return ok;
        }
        public uint Wait(IntPtr process, uint timeout, out int error)
        {
            uint state = WaitForSingleObject(process, timeout);
            error = state == 0xffffffff ? Marshal.GetLastWin32Error() : 0; return state;
        }
        public void Close(IntPtr process) { CloseHandle(process); }
    }
}
