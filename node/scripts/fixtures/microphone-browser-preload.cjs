const { contextBridge, ipcRenderer } = require('electron');

// This fixture bridge reports results only; it never exposes device or filesystem access.
contextBridge.exposeInMainWorld('microphoneSmoke', {
  complete: result => ipcRenderer.send('microphone-smoke-result', { ok: true, result }),
  fail: error => ipcRenderer.send('microphone-smoke-result', { ok: false, error: String(error) }),
});
