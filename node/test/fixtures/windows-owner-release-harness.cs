using System;
using System.Collections.Generic;

namespace Synapse.Serial
{
    // Compiled only by tests together with the native helper; no real process
    // handles or termination calls occur in these refusal-path unit tests.
    public static class WindowsOwnerReleaseHarness
    {
        private const uint TargetPid = 12345;
        private const ulong ExpectedTime = 123456789012345678UL;
        private const string ExpectedText = "123456789012345678";

        private sealed class FakeApi : IWindowsReleaseApi
        {
            internal readonly IntPtr Handle = new IntPtr(123456);
            internal int OpenCalls, CloseCalls, TerminateCalls, WaitCalls;
            internal int OpenError, CreationError, OwnerError, CriticalError, TerminateError;
            internal ulong Creation = ExpectedTime;
            internal uint Session = 1, InitialWait = 258, FinalWait = 0, SelfPid = 77777, LastWait;
            internal string OwnerSid = "S-1-5-21-current";
            internal bool Critical;
            public uint CurrentPid { get { return SelfPid; } }
            public string CurrentSid { get { return "S-1-5-21-current"; } }
            private void Same(IntPtr value) { Check(value == Handle, "every operation must use the original process handle"); }
            public IntPtr Open(uint pid, out int error) { Check(pid == TargetPid, "target pid"); OpenCalls++; error = OpenError; return error == 0 ? Handle : IntPtr.Zero; }
            public bool ReadCreation(IntPtr process, out ulong creation, out int error) { Same(process); creation = Creation; error = CreationError; return error == 0; }
            public bool ReadOwner(IntPtr process, out string sid, out uint session, out int error) { Same(process); sid = OwnerSid; session = Session; error = OwnerError; return error == 0; }
            public bool ReadCritical(IntPtr process, out bool critical, out int error) { Same(process); critical = Critical; error = CriticalError; return error == 0; }
            public bool Terminate(IntPtr process, out int error) { Same(process); TerminateCalls++; error = TerminateError; return error == 0; }
            public uint Wait(IntPtr process, uint timeout, out int error) { Same(process); WaitCalls++; LastWait = timeout; error = 0; return timeout == 0 ? InitialWait : FinalWait; }
            public void Close(IntPtr process) { Same(process); CloseCalls++; }
        }

        private static void Check(bool condition, string message)
        {
            if (!condition) throw new Exception("Release policy assertion failed: " + message);
        }
        private static void Refuses(FakeApi api, string reason, uint[] protectedPids)
        {
            OwnerReleaseResult result = WindowsOwnerRelease.ReleaseCore(TargetPid, ExpectedText, protectedPids, 2000, api);
            Check(!result.released && result.reason == reason, reason);
            Check(api.TerminateCalls == 0, reason + " must never terminate");
            Check(api.OpenCalls <= 1, "OpenProcess at most once");
            Check(api.CloseCalls == (api.OpenCalls == 1 && api.OpenError == 0 ? 1 : 0), "close held handle exactly once");
        }

        public static string[] Run()
        {
            List<string> passed = new List<string>();
            FakeApi api = new FakeApi { OpenError = 5 };
            Refuses(api, "access_denied", null); passed.Add("open_access_denied");
            api = new FakeApi { OwnerError = 5 };
            Refuses(api, "access_denied", null); passed.Add("token_access_denied");
            api = new FakeApi { Creation = ExpectedTime + 1 };
            Refuses(api, "owner_changed", null); passed.Add("creation_time_changed");
            api = new FakeApi { OwnerSid = "S-1-5-21-other" };
            Refuses(api, "different_user", null); passed.Add("owner_sid_changed");
            api = new FakeApi { Session = 0 };
            Refuses(api, "session_zero", null); passed.Add("session_zero");
            api = new FakeApi { Critical = true };
            Refuses(api, "critical_process", null); passed.Add("critical_process");
            api = new FakeApi { CriticalError = 5 };
            Refuses(api, "owner_unverifiable", null); passed.Add("critical_check_failed");
            api = new FakeApi { CreationError = 5 };
            Refuses(api, "owner_unverifiable", null); passed.Add("creation_check_failed");
            api = new FakeApi();
            Refuses(api, "protected_process", new uint[] { TargetPid });
            Check(api.OpenCalls == 0, "protected pid must never be opened"); passed.Add("protected_pid");
            api = new FakeApi { SelfPid = TargetPid };
            Refuses(api, "protected_process", null); Check(api.OpenCalls == 0, "helper pid protected"); passed.Add("helper_pid");
            api = new FakeApi { InitialWait = 0 };
            Refuses(api, "already_exited", null); passed.Add("already_exited");
            api = new FakeApi { TerminateError = 5 };
            OwnerReleaseResult result = WindowsOwnerRelease.ReleaseCore(TargetPid, ExpectedText, null, 2000, api);
            Check(!result.released && result.reason == "access_denied" && api.CloseCalls == 1, "terminate denied"); passed.Add("terminate_access_denied");
            api = new FakeApi { FinalWait = 258 };
            result = WindowsOwnerRelease.ReleaseCore(TargetPid, ExpectedText, null, 2000, api);
            Check(!result.released && result.reason == "wait_timeout" && api.TerminateCalls == 1 && api.LastWait == 2000, "bounded wait");
            passed.Add("bounded_wait_timeout");
            api = new FakeApi();
            result = WindowsOwnerRelease.ReleaseCore(TargetPid, ExpectedText, null, 2000, api);
            Check(result.released && result.reason == "released", "successful release");
            Check(api.OpenCalls == 1 && api.CloseCalls == 1 && api.TerminateCalls == 1 && api.WaitCalls == 2 && api.LastWait == 2000,
                "one handle for all queries, terminate and wait"); passed.Add("single_handle_success");
            return passed.ToArray();
        }
    }
}
