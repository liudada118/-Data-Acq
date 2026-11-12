/** Match only the workstation's exact loopback origin. */
export function sameOrigin(value, origin) {
  try { return new URL(value).origin === origin; } catch { return false; }
}

/** Grant camera/audio only to the trusted top-level workstation window. */
export function allowMedia({ permission, requestingUrl, origin, trustedContents, isMainFrame = true, mediaTypes }) {
  return trustedContents && isMainFrame !== false && permission === 'media' && sameOrigin(requestingUrl, origin)
    && (!mediaTypes || mediaTypes.every(type => ['audio', 'video', 'unknown'].includes(type)));
}

/** Restrict new-window downloads to existing server download endpoints. */
export function isDownloadUrl(value, origin) {
  if (!sameOrigin(value, origin)) return false;
  return /^\/api\/(export\/download\/|files\/)/.test(new URL(value).pathname);
}

/** Unknown or error HTTP payloads must never be treated as an idle recorder. */
export function validCaptureStatus(value) {
  return value && ['idle', 'recording', 'stopping', 'error'].includes(value.state)
    && (value.session_id === null || typeof value.session_id === 'string');
}
