import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOrigin, allowMedia, isDownloadUrl, validCaptureStatus } from '../electron/security.mjs';

test('desktop media permissions are confined to the workstation window and origin', () => {
  const allowed = { permission: 'media', requestingUrl: 'http://127.0.0.1:8788/', origin: 'http://127.0.0.1:8788', trustedContents: true, mediaTypes: ['video'] };
  assert.equal(allowMedia(allowed), true);
  for (const patch of [{ requestingUrl: 'https://example.com' }, { requestingUrl: 'http://127.0.0.1:8789' }, { trustedContents: false }, { isMainFrame: false }, { permission: 'display-capture' }, { mediaTypes: ['screen'] }])
    assert.equal(allowMedia({ ...allowed, ...patch }), false);
  assert.equal(sameOrigin('invalid', allowed.origin), false);
});

test('desktop downloads cannot navigate to foreign endpoints', () => {
  const origin = 'http://127.0.0.1:8788';
  assert.equal(isDownloadUrl(`${origin}/api/export/download/job-1`, origin), true);
  assert.equal(isDownloadUrl(`${origin}/api/files/session-1/manifest.json`, origin), true);
  for (const url of ['https://example.com/api/files/s/x', `${origin}/api/sessions/start`, 'file:///C:/secret']) assert.equal(isDownloadUrl(url, origin), false);
});

test('reload and exit cannot treat an API error or unknown state as idle', () => {
  assert.equal(validCaptureStatus({ state: 'idle', session_id: null }), true);
  assert.equal(validCaptureStatus({ state: 'recording', session_id: 'session-1' }), true);
  for (const status of [{ error: 'offline' }, {}, { state: 'idle' }, { state: 'unknown', session_id: null }])
    assert.equal(validCaptureStatus(status), false);
});
