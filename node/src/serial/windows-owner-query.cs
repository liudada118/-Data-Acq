using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace Synapse.Serial
{
    public sealed class PortOwner
    {
        public int pid;
        public string name;
        public string executable;
        public string startTime;
        public string creationTime;
        public uint? sessionId;
        public bool? isCritical;
        public bool? currentUserOwned;
    }

    public sealed class PortOwnersResult
    {
        public PortOwner[] owners = new PortOwner[0];
        public bool complete;
        public string reason;
        public string devicePath;
    }

    // This helper is read-only. It must run in a separate, time-limited process:
    // native object-name queries are not cancellable inside the calling thread.
    public static class WindowsPortOwners
    {
        private const int SystemExtendedHandleInformation = 64;
        private const int ObjectNameInformation = 1;
        private const uint ProcessDuplicateHandle = 0x0040;
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint DuplicateSameAccess = 2;
        private const uint FileTypeChar = 2;
        private const uint StatusInfoLengthMismatch = 0xC0000004;
        private const uint StatusBufferOverflow = 0x80000005;
        private const uint StatusBufferTooSmall = 0xC0000023;
        private const int MaxSnapshotBytes = 64 * 1024 * 1024;

        [StructLayout(LayoutKind.Sequential)]
        private struct HandleEntry
        {
            public IntPtr Object;
            public UIntPtr UniqueProcessId;
            public UIntPtr HandleValue;
            public uint GrantedAccess;
            public ushort CreatorBackTraceIndex;
            public ushort ObjectTypeIndex;
            public uint HandleAttributes;
            public uint Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FileTime
        {
            public uint Low;
            public uint High;
            public ulong Value { get { return ((ulong)High << 32) | Low; } }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint QueryDosDevice(string name, char[] target, int size);
        [DllImport("ntdll.dll")]
        private static extern uint NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int needed);
        [DllImport("ntdll.dll")]
        private static extern uint NtQueryObject(IntPtr handle, int infoClass, IntPtr buffer, int length, out int needed);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr attributes, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetFileType(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetConsoleMode(IntPtr handle, out uint mode);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ProcessIdToSessionId(uint pid, out uint session);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessCritical(IntPtr process, out bool critical);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int size, out int needed);

        private static IntPtr HandlePointer(UIntPtr handle)
        {
            return IntPtr.Size == 8 ? new IntPtr(unchecked((long)handle.ToUInt64())) : new IntPtr(unchecked((int)handle.ToUInt32()));
        }

        private static string MapPort(string port)
        {
            for (int size = 1024; size <= 32768; size *= 2)
            {
                char[] buffer = new char[size];
                if (QueryDosDevice(port, buffer, buffer.Length) != 0)
                {
                    int end = Array.IndexOf(buffer, '\0');
                    // QueryDosDevice's first string is the current mapping. Later
                    // strings can be obsolete mappings and must not be matched.
                    return end > 0 ? new string(buffer, 0, end) : null;
                }
                if (Marshal.GetLastWin32Error() != 122) return null;
            }
            return null;
        }

        private static IntPtr Snapshot(out int byteLength, out ulong handleCount)
        {
            byteLength = 1024 * 1024;
            handleCount = 0;
            while (byteLength <= MaxSnapshotBytes)
            {
                IntPtr buffer = Marshal.AllocHGlobal(byteLength);
                int needed;
                uint status = NtQuerySystemInformation(SystemExtendedHandleInformation, buffer, byteLength, out needed);
                if (status == 0)
                {
                    handleCount = IntPtr.Size == 8 ? unchecked((ulong)Marshal.ReadInt64(buffer)) : unchecked((uint)Marshal.ReadInt32(buffer));
                    int entrySize = Marshal.SizeOf(typeof(HandleEntry));
                    int headerSize = IntPtr.Size * 2;
                    if (handleCount > (ulong)((byteLength - headerSize) / entrySize))
                    {
                        Marshal.FreeHGlobal(buffer);
                        throw new InvalidOperationException("Unexpected native handle snapshot layout.");
                    }
                    return buffer;
                }
                Marshal.FreeHGlobal(buffer);
                if (status != StatusInfoLengthMismatch && status != StatusBufferTooSmall)
                    throw new InvalidOperationException("Native handle enumeration failed (0x" + status.ToString("X8") + ").");
                long next = Math.Max((long)byteLength * 2, (long)needed + 65536);
                if (next > MaxSnapshotBytes) break;
                byteLength = (int)next;
            }
            throw new InvalidOperationException("Native handle snapshot exceeded the size limit.");
        }

        private static bool ReadObjectName(IntPtr handle, out string name)
        {
            name = null;
            int size = 2048;
            while (size <= 65536)
            {
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    int needed;
                    uint status = NtQueryObject(handle, ObjectNameInformation, buffer, size, out needed);
                    if (status == 0)
                    {
                        int length = unchecked((ushort)Marshal.ReadInt16(buffer));
                        if (length == 0) { name = ""; return true; }
                        IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size == 8 ? 8 : 4);
                        long offset = text.ToInt64() - buffer.ToInt64();
                        if ((length & 1) != 0 || offset < 0 || offset + length > size) return false;
                        name = Marshal.PtrToStringUni(text, length / 2);
                        return true;
                    }
                    if (status != StatusInfoLengthMismatch && status != StatusBufferOverflow && status != StatusBufferTooSmall) return false;
                    long next = Math.Max((long)size * 2, (long)needed);
                    if (next > 65536) return false;
                    size = (int)next;
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            return false;
        }

        private static bool? IsCurrentUser(IntPtr process, string currentSid)
        {
            if (currentSid == null) return null;
            IntPtr token;
            if (!OpenProcessToken(process, 0x0008, out token)) return null; // TOKEN_QUERY only
            try
            {
                int needed;
                GetTokenInformation(token, 1, IntPtr.Zero, 0, out needed); // TokenUser
                if (needed <= 0 || needed > 65536) return null;
                IntPtr buffer = Marshal.AllocHGlobal(needed);
                try
                {
                    if (!GetTokenInformation(token, 1, buffer, needed, out needed)) return null;
                    SecurityIdentifier sid = new SecurityIdentifier(Marshal.ReadIntPtr(buffer));
                    return String.Equals(sid.Value, currentSid, StringComparison.Ordinal);
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            finally { CloseHandle(token); }
        }

        private static PortOwner DescribeOwner(IntPtr process, int pid, string currentSid)
        {
            PortOwner owner = new PortOwner();
            owner.pid = pid;
            StringBuilder path = new StringBuilder(32768);
            int length = path.Capacity;
            if (QueryFullProcessImageName(process, 0, path, ref length))
            {
                owner.executable = path.ToString();
                owner.name = Path.GetFileName(owner.executable);
            }
            FileTime created, exited, kernel, user;
            if (GetProcessTimes(process, out created, out exited, out kernel, out user))
            {
                owner.creationTime = created.Value.ToString(CultureInfo.InvariantCulture);
                owner.startTime = DateTime.FromFileTimeUtc(unchecked((long)created.Value)).ToString("O", CultureInfo.InvariantCulture);
            }
            uint session;
            if (ProcessIdToSessionId((uint)pid, out session)) owner.sessionId = session;
            bool critical;
            if (IsProcessCritical(process, out critical)) owner.isCritical = critical;
            owner.currentUserOwned = IsCurrentUser(process, currentSid);
            return owner;
        }

        private sealed class ProcessScan
        {
            public int Pid;
            public List<UIntPtr> Handles;
            public string DevicePath;
            public string CurrentSid;
            public Stopwatch Elapsed;
            public int TimeoutMs;
            public PortOwner Owner;
            public HashSet<string> Limitations = new HashSet<string>();

            public void Run()
            {
                IntPtr process = IntPtr.Zero;
                try
                {
                    process = OpenProcess(ProcessDuplicateHandle | ProcessQueryLimitedInformation, false, Pid);
                    if (process == IntPtr.Zero)
                    {
                        Limitations.Add(Marshal.GetLastWin32Error() == 5 ? "process_access_denied" : "process_changed_or_unavailable");
                        return;
                    }
                    foreach (UIntPtr original in Handles)
                    {
                        if (Elapsed.ElapsedMilliseconds > TimeoutMs) { Limitations.Add("scan_time_limit"); break; }
                        IntPtr duplicate;
                        if (!DuplicateHandle(process, HandlePointer(original), GetCurrentProcess(), out duplicate, 0, false, DuplicateSameAccess))
                        {
                            Limitations.Add("handle_changed_or_unavailable");
                            continue;
                        }
                        try
                        {
                            // Never query object names on pipes, sockets or disk
                            // files. Even character-device drivers may block, so
                            // this entire per-process probe is time-limited.
                            uint kind = GetFileType(duplicate);
                            if (kind == 0) { Limitations.Add("file_type_unavailable"); continue; }
                            if (kind != FileTypeChar) continue;
                            uint consoleMode;
                            if (GetConsoleMode(duplicate, out consoleMode)) continue;
                            string objectName;
                            if (!ReadObjectName(duplicate, out objectName)) { Limitations.Add("object_name_unavailable"); continue; }
                            if (!String.Equals(objectName, DevicePath, StringComparison.OrdinalIgnoreCase)) continue;
                            Owner = DescribeOwner(process, Pid, CurrentSid);
                            if (Owner.creationTime == null || Owner.executable == null) Limitations.Add("owner_identity_incomplete");
                            break;
                        }
                        finally { CloseHandle(duplicate); }
                    }
                }
                catch (Exception) { Limitations.Add("process_query_failed"); }
                finally { if (process != IntPtr.Zero) CloseHandle(process); }
            }
        }

        public static PortOwnersResult Query(string port, int scanTimeoutMs, int[] preferredPids)
        {
            PortOwnersResult result = new PortOwnersResult();
            List<PortOwner> owners = new List<PortOwner>();
            HashSet<string> limitations = new HashSet<string>();
            IntPtr nullHandle = IntPtr.Zero;
            IntPtr snapshot = IntPtr.Zero;
            Stopwatch elapsed = Stopwatch.StartNew();
            try
            {
                if (!System.Text.RegularExpressions.Regex.IsMatch(port ?? "", "^COM[1-9][0-9]{0,4}$"))
                    throw new ArgumentException("Invalid serial port name.");
                scanTimeoutMs = Math.Max(100, Math.Min(scanTimeoutMs, 10000));
                result.devicePath = MapPort(port);
                if (result.devicePath == null)
                {
                    result.reason = "port_not_mapped";
                    return result;
                }

                // Discover the File object-type index with our own NUL handle;
                // object type indices are not stable between Windows versions.
                nullHandle = CreateFile("NUL", 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
                if (nullHandle == new IntPtr(-1)) throw new InvalidOperationException("Cannot create the handle-type probe.");
                int byteLength;
                ulong count;
                snapshot = Snapshot(out byteLength, out count);
                int entrySize = Marshal.SizeOf(typeof(HandleEntry));
                int headerSize = IntPtr.Size * 2;
                ushort fileTypeIndex = 0;
                uint currentPid = GetCurrentProcessId();
                for (ulong i = 0; i < count; i++)
                {
                    IntPtr position = IntPtr.Add(snapshot, headerSize + checked((int)i * entrySize));
                    HandleEntry entry = (HandleEntry)Marshal.PtrToStructure(position, typeof(HandleEntry));
                    if (entry.UniqueProcessId.ToUInt64() == currentPid && HandlePointer(entry.HandleValue) == nullHandle)
                    {
                        fileTypeIndex = entry.ObjectTypeIndex;
                        break;
                    }
                }
                if (fileTypeIndex == 0) throw new InvalidOperationException("Cannot identify the native File object type.");

                Dictionary<int, List<UIntPtr>> candidates = new Dictionary<int, List<UIntPtr>>();
                for (ulong i = 0; i < count; i++)
                {
                    IntPtr position = IntPtr.Add(snapshot, headerSize + checked((int)i * entrySize));
                    HandleEntry entry = (HandleEntry)Marshal.PtrToStructure(position, typeof(HandleEntry));
                    if (entry.ObjectTypeIndex != fileTypeIndex) continue;
                    ulong processId = entry.UniqueProcessId.ToUInt64();
                    if (processId > Int32.MaxValue || processId == currentPid) continue;
                    int pid = (int)processId;
                    List<UIntPtr> handles;
                    if (!candidates.TryGetValue(pid, out handles)) candidates.Add(pid, handles = new List<UIntPtr>());
                    handles.Add(entry.HandleValue);
                }

                string currentSid = null;
                using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
                    if (identity.User != null) currentSid = identity.User.Value;

                List<int> orderedPids = new List<int>();
                HashSet<int> preferred = new HashSet<int>(preferredPids ?? new int[0]);
                foreach (int pid in preferred)
                    if (candidates.ContainsKey(pid)) orderedPids.Add(pid);
                uint currentSession;
                bool hasSession = ProcessIdToSessionId(currentPid, out currentSession);
                List<int> sessionPids = new List<int>();
                List<int> otherPids = new List<int>();
                foreach (int pid in candidates.Keys)
                {
                    if (preferred.Contains(pid)) continue;
                    uint session;
                    if (hasSession && ProcessIdToSessionId((uint)pid, out session) && session == currentSession) sessionPids.Add(pid);
                    else otherPids.Add(pid);
                }
                sessionPids.Sort();
                sessionPids.Reverse();
                orderedPids.AddRange(sessionPids);
                orderedPids.AddRange(otherPids);

                int stalledWorkers = 0;
                foreach (int pid in orderedPids)
                {
                    int remaining = scanTimeoutMs - (int)elapsed.ElapsedMilliseconds;
                    if (remaining <= 0) { limitations.Add("scan_time_limit"); break; }
                    if (stalledWorkers >= 24) { limitations.Add("stalled_query_limit"); break; }
                    ProcessScan scan = new ProcessScan {
                        Pid = pid, Handles = candidates[pid], DevicePath = result.devicePath,
                        CurrentSid = currentSid, Elapsed = elapsed, TimeoutMs = scanTimeoutMs
                    };
                    Thread worker = new Thread(scan.Run);
                    worker.IsBackground = true;
                    worker.Start();
                    if (!worker.Join(Math.Min(remaining, preferred.Contains(pid) ? 750 : 100)))
                    {
                        // The worker owns its handles and memory. Do not close
                        // them under a blocked native call. The isolated helper
                        // exits immediately after returning the result, allowing
                        // Windows to clean up only our duplicated references.
                        limitations.Add("process_query_timeout");
                        stalledWorkers++;
                        continue;
                    }
                    foreach (string reason in scan.Limitations) limitations.Add(reason);
                    if (scan.Owner != null) owners.Add(scan.Owner);
                }
                result.complete = limitations.Count == 0;
            }
            catch (Exception)
            {
                // No environment details, process command lines or exception
                // dumps leave this helper. The caller can report a clear unknown.
                limitations.Add("native_query_failed");
                result.complete = false;
            }
            finally
            {
                if (snapshot != IntPtr.Zero) Marshal.FreeHGlobal(snapshot);
                if (nullHandle != IntPtr.Zero && nullHandle != new IntPtr(-1)) CloseHandle(nullHandle);
            }
            result.owners = owners.ToArray();
            if (limitations.Count > 0) result.reason = String.Join(",", new List<string>(limitations).ToArray());
            return result;
        }
    }
}
