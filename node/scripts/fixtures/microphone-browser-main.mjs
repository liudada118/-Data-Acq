import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startDesktopService } from '../../electron/service.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = process.argv.find(value => value.startsWith('--fixture-dir='))?.slice('--fixture-dir='.length);
if (!directory || !path.isAbsolute(directory)) throw new Error('An absolute fixture directory is required');
app.setPath('userData', path.join(directory, 'electron-profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function unzip(buffer) {
  let end = buffer.length - 22; while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0); let offset = buffer.readUInt32LE(end + 16); const result = new Map();
  for (let n = 0; n < buffer.readUInt16LE(end + 10); n++) {
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20), nameSize = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 46, offset + 46 + nameSize).toString(), local = buffer.readUInt32LE(offset + 42);
    const begin = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28), data = buffer.subarray(begin, begin + size);
    result.set(name, method === 8 ? inflateRawSync(data) : data);
    offset += 46 + nameSize + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return result;
}
async function run() {
let service, window, report;
try {
  const webDir = path.join(directory, 'web'); await mkdir(path.join(webDir, 'audio'), { recursive: true });
  const workletFile = path.join(root, 'ui/public/audio/pcm-capture.worklet.js');
  const workletBytes = await readFile(workletFile);
  await copyFile(workletFile, path.join(webDir, 'audio/pcm-capture.worklet.js'));
  await copyFile(new URL('./microphone-browser-renderer.js', import.meta.url), path.join(webDir, 'fixture.js'));
  await writeFile(path.join(webDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic microphone smoke</title></head><body><script type="module" src="/fixture.js"></script></body></html>');
  service = await startDesktopService({ executable: process.execPath, root, userData: path.join(directory, 'service'), webDir,
    port: 0, packaged: true, disableEnvFile: true, sdkPath: false });
  window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
    backgroundThrottling: false, preload: fileURLToPath(new URL('./microphone-browser-preload.cjs', import.meta.url)) } });
  let permissionRequests = 0;
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => { permissionRequests++; callback(false); });
  window.webContents.session.setPermissionCheckHandler(() => false);
  const completed = new Promise((resolve, reject) => {
    ipcMain.on('microphone-smoke-result', (event, message) => {
      if (event.sender !== window.webContents) return;
      message?.ok ? resolve(message.result) : reject(new Error(message?.error || 'Renderer smoke failed'));
    });
    window.webContents.once('render-process-gone', (_event, details) => reject(new Error(`Renderer exited: ${details.reason}`)));
    window.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`Fixture load failed: ${code} ${description}`)));
  });
  await window.loadURL(service.url);
  const result = await completed;
  assert.equal(permissionRequests, 0, 'Synthetic capture should not request microphone or camera permission');
  assert.ok(result.finalChunkFrames > 0 && result.finalChunkFrames < result.fullChunkFrames, 'Expected a flushed partial final audio block');
  const manifest = JSON.parse(await readFile(path.join(service.dataDir, result.sessionId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'complete'); assert.equal(manifest.media_streams[0].sample_count, result.sampleCount);
  const original = await readFile(path.join(service.dataDir, result.sessionId, result.mediaFile));
  assert.equal(sha256(original.subarray(44)), result.pcmSha256);
  const accepted = await fetch(service.url + '/api/export/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: result.sessionId, format: 'wav' }) });
  assert.equal(accepted.status, 202); const job = await accepted.json();
  let exported;
  for (let attempt = 0; attempt < 100; attempt++) {
    exported = await (await fetch(service.url + `/api/export/jobs/${job.id}`)).json();
    if (['complete', 'error'].includes(exported.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(exported.status, 'complete', exported.error);
  const archiveBytes = Buffer.from(await (await fetch(service.url + exported.download_url)).arrayBuffer());
  const archive = unzip(archiveBytes);
  const fileMapping = JSON.parse(archive.get('export_report.json')).file_mapping;
  const exportedMedia = fileMapping.find(item => item.original_file === result.mediaFile);
  assert.ok(exportedMedia, 'Export report maps the microphone file to its sensor name');
  assert.deepEqual(archive.get(exportedMedia.file), original);
  await writeFile(path.join(directory, 'microphone-export.zip'), archiveBytes);
  const dist = await readFile(path.join(root, 'ui/dist/audio/pcm-capture.worklet.js')).catch(() => null);
  report = { ok: true, evidence: 'real Electron Chromium AudioContext + production AudioWorklet + Node HTTP/storage/export',
    physicalMicrophoneUsed: false, permissionRequests, electron: process.versions.electron, chromium: process.versions.chrome,
    node: process.versions.node, workletSha256: sha256(workletBytes), distWorkletMatches: dist ? sha256(dist) === sha256(workletBytes) : null,
    ...result, wavExport: 'byte-identical', sessionStatus: manifest.status };
} catch (error) { report = { ok: false, error: error.stack || error.message }; }
finally {
  try { await service?.close(); } catch (error) { report = { ...report, ok: false, shutdownError: error.message }; }
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(report.ok ? 0 : 1);
}
}

// Electron finishes loading ESM before firing ready: a top-level await of ready
// deadlocks startup. Register the continuation and let module evaluation finish.
app.whenReady().then(run).catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
