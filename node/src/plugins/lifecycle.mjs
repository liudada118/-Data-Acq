// Native cameras can take several seconds to stop USB streams and release the
// device. Keep cleanup bounded, with the supervisor deadline outside the host's
// own deadline so it can report and exit before a forced process-tree kill.
export const PLUGIN_STOP_TIMEOUT_MS = 10000;
export const PLUGIN_FORCE_STOP_TIMEOUT_MS = PLUGIN_STOP_TIMEOUT_MS + 1000;
