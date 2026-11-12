import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { CaptureEngine } from './capture/engine.mjs';
import { ExportManager } from './exports/manager.mjs';
import { checkWave } from './exports/reader.mjs';
import { CameraManager } from './cameras.mjs';
import { CameraPreviewService } from './camera-preview.mjs';
import { AnnotationStore, validateExperiment, validateLabels } from './annotations.mjs';
import { ReplayManager } from './replay/manager.mjs';
import { ContinuityManager } from './continuity/manager.mjs';
import { startupStatus } from './startup-status.mjs';
import { PortOwnershipService } from './serial/port-ownership.mjs';
import { createIntegrationMaintenance } from './integration-maintenance.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.zip': 'application/zip',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.wav': 'audio/wav' };

function failure(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw failure('请使用 application/json 请求。', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw failure('请求内容超过 64 KiB。', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw failure('请求必须是有效 JSON 对象。'); }
}
async function sendFile(request, response, filename, downloadName, contentExtension = path.extname(filename)) {
  const info = await stat(filename);
  if (!info.isFile()) throw failure('文件不存在。', 404);
  const headers = { 'Content-Type': MIME[contentExtension] ?? 'application/octet-stream',
    'Content-Length': info.size, 'Cache-Control': 'no-store' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="download${contentExtension}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  // Native video elements need byte ranges for reliable timeline seeks. Other files keep their download semantics.
  if (['.webm', '.mp4', '.wav'].includes(contentExtension)) {
    headers['Accept-Ranges'] = 'bytes';
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = 0, end = info.size - 1;
      if (match && (match[1] || match[2])) {
        if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
        else { const suffix = Number(match[2]); start = Math.max(0, info.size - suffix); if (!suffix) start = info.size; }
      } else start = info.size;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= info.size || end < start) {
        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0 }); return response.end();
      }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
      if (request.method === 'HEAD') return response.end();
      return pipeline(createReadStream(filename, { start, end }), response);
    }
  }
  response.writeHead(200, headers);
  if (request.method === 'HEAD') return response.end();
  await pipeline(createReadStream(filename), response);
}

/** Stable HTTP boundary: the React client can later switch to a native engine. */
export async function createApplication(options = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 8785);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw failure('PORT 必须为有效端口。');
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? path.join(ROOT, 'data/sessions'));
  const outputDir = path.resolve(options.outputDir ?? process.env.EXPORT_DIR ?? path.join(ROOT, 'data/exports'));
  const webDir = path.resolve(options.webDir ?? path.join(ROOT, 'ui/dist'));
  const sdkPath = options.sdkPath ?? process.env.SHROOM_SDK_PATH;
  const pluginRoot = path.resolve(options.pluginRoot ?? path.join(path.dirname(dataDir), 'plugins'));
  const capture = new CaptureEngine({ dataDir, pluginRoot, sdkPath: sdkPath === false ? false : sdkPath ? path.resolve(sdkPath) : undefined });
  const cameraPreview = new CameraPreviewService({ capture });
  const integrationMaintenance = createIntegrationMaintenance();
  const portOwners = new PortOwnershipService({ ...options.portOwnership, capture });
  const exports = new ExportManager({ dataDir, outputDir });
  const annotations = new AnnotationStore({ dataDir, capture });
  const replay = new ReplayManager({ dataDir });
  const continuity = new ContinuityManager({ dataDir });
  const cameras = new CameraManager({ dataDir, leaseTimeoutMs: options.cameraLeaseTimeoutMs,
    onUpdate: media => capture.mediaUpdate(media), isEngineAlive: () => capture.status().engine_alive });
  const devices = () => [...capture.devices(), ...cameras.devices()];
  const status = () => ({ ...capture.status(), camera_stop_requires_owner: cameras.stopRequiresOwner(),
    camera_uploads_pending: [...(cameras.active?.entries.values() ?? [])].filter(entry => entry.pending).length });
  let transition = null;
  async function changeSession(action) {
    if (transition) throw failure('录制正在启动或停止。', 409);
    transition = Promise.resolve().then(action);
    try { return await transition; } finally { transition = null; }
  }
  async function stopSession() {
    const manifest = await capture.stop(await cameras.finish());
    await annotations.finalize(manifest);
    return manifest;
  }
  let ready = false; let closing = false; let actualPort;
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      const authority = request.headers.host;
      if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(authority)) throw failure('无效的本机 Host。', 403);
      const allowed = new Set([actualPort, 5180, 4180].flatMap(p => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]));
      const origin = request.headers.origin;
      if (origin && !allowed.has(origin)) throw failure('仅允许本机采集界面访问。', 403);
      if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Camera-Token' });
        return response.end();
      }
      if (!ready || closing) throw failure('采集服务正在启动或退出。', 503);
      const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
      const route = decodeURIComponent(url.pathname);
      const method = request.method;
      if (method === 'GET' && route === '/api/health') {
        const sdk = await capture.sdkInfo();
        const connectedSdk = (sdk.instances ?? [sdk]).filter(instance => instance.connected);
        const connectedCameras = cameras.devices().filter(device => device.connected);
        const connectedPlugins = capture.devices().filter(device => device.mode === 'sdk-plugin' && device.connected);
        const status = capture.status();
        return json(response, { service: 'synapse-node', runtime: process.version,
          engine_alive: status.engine_alive, capture_error: status.error ?? null,
          mode: !status.engine_alive ? 'error' : connectedPlugins.length ? (connectedCameras.length || connectedSdk.length ? 'mixed' : 'sdk-plugin') : connectedCameras.length ? (connectedSdk.length || new Set(connectedCameras.map(device => device.mode)).size > 1 ? 'mixed' : connectedCameras[0].mode) : connectedSdk.some(instance => instance.product !== 'mock') ? 'mixed' : connectedSdk.length ? 'sdk-mock' : 'simulation',
          hardware_connected: connectedPlugins.length > 0 || connectedCameras.length > 0 || connectedSdk.some(instance => instance.product !== 'mock'), data_dir: dataDir, sdk_loaded: sdk.loaded, sdk_integration_api: 1 });
      }
      if (method === 'GET' && route === '/api/devices') return json(response, { devices: devices() });
      if (method === 'GET' && route === '/api/plugins/catalog') return json(response, await capture.pluginCatalog());
      if (method === 'POST' && route === '/api/plugins/maintenance') {
        const input = await body(request);
        return json(response, await changeSession(async () => {
          if (input.action === 'release') return integrationMaintenance.release(input.token);
          if (input.action === 'renew') return integrationMaintenance.renew(input.token);
          if (input.action !== 'acquire') throw failure('无效的 SDK 维护操作。');
          return integrationMaintenance.acquire(capture.status(), await capture.pluginCatalog());
        }));
      }
      if (method === 'POST' && /^\/api\/plugins\/(connect|disconnect|reload)$/.test(route)) {
        const input = await body(request);
        return json(response, await changeSession(async () => {
          integrationMaintenance.assertAvailable(input.maintenance_token);
          if (route.endsWith('/connect')) return capture.pluginConnect(input);
          if (route.endsWith('/disconnect')) return capture.pluginDisconnect(input);
          return capture.pluginReload();
        }));
      }
      if (method === 'GET' && route === '/api/status') return json(response, status());
      const cameraPreviewMatch = /^\/api\/preview\/cameras\/([^/]+)$/.exec(route);
      if (method === 'GET' && cameraPreviewMatch) return cameraPreview.open(request, response, cameraPreviewMatch[1], url.searchParams.get('fps') ?? 30);
      if (method === 'GET' && route === '/api/preview') return json(response, { ...capture.preview(), status: status() });
      if (method === 'GET' && route === '/api/snapshot') return json(response, { ...capture.preview(), status: status(), devices: devices() });
      if (method === 'GET' && route === '/api/cameras') return json(response, { devices: cameras.devices() });
      if (method === 'POST' && route === '/api/cameras/register') return json(response, cameras.register(await body(request)), 201);
      const cameraMatch = /^\/api\/cameras\/([^/]+)\/(heartbeat|disconnect|chunks|finalize|error)$/.exec(route);
      if (method === 'POST' && cameraMatch) {
        const [, id, action] = cameraMatch;
        const token = request.headers['x-camera-token'];
        if (action === 'chunks') return json(response, await cameras.append(id, token, url.searchParams.get('session_id'), url.searchParams.get('index'), request));
        const input = await body(request);
        if (action === 'heartbeat') return json(response, cameras.heartbeat(id, token));
        if (action === 'disconnect') return json(response, cameras.disconnect(id, token));
        if (action === 'error') return json(response, cameras.error(id, token, input));
        return json(response, await cameras.finalize(id, token, input));
      }
      if (method === 'GET' && route === '/api/sdk/info') return json(response, await capture.sdkInfo());
      if (method === 'GET' && route === '/api/sdk/ports') return json(response, { ports: await capture.sdkPorts() });
      if (method === 'POST' && route === '/api/sdk/port/inspect') return json(response, await portOwners.inspect(await body(request)));
      if (method === 'POST' && route === '/api/sdk/port/release') {
        const input = await body(request);
        return json(response, await changeSession(() => portOwners.release(input)));
      }
      if (method === 'POST' && route === '/api/sdk/connect') {
        const input = await body(request); portOwners.invalidate();
        return json(response, await capture.sdkConnect(input));
      }
      if (method === 'POST' && route === '/api/sdk/disconnect') {
        const input = await body(request); portOwners.invalidate();
        return json(response, await capture.sdkDisconnect(input));
      }
      if (method === 'POST' && ['/api/sessions/start', '/api/recordings/start'].includes(route)) {
        const input = await body(request);
        input.experiment = validateExperiment(input.experiment);
        input.labels = validateLabels(input.labels);
        const session = await changeSession(async () => {
          integrationMaintenance.assertAvailable();
          // Prioritize acquisition over an optional historical-file scan.
          await continuity.cancelActive();
          const sources = cameras.sources(input);
          // Lease credentials never cross IPC or enter the persisted manifest.
          const { camera_sources, media_sources, ...payload } = input;
          const result = await capture.start({ ...payload,
            device_ids: payload.device_ids.filter(id => typeof id !== 'string' || !/^(camera|microphone)-/.test(id)), media_sources: sources });
          try { await annotations.initSession(result); await cameras.prepare(result, sources); }
          catch (error) { await stopSession().catch(() => {}); throw error; }
          return capture.getSession(result.id);
        });
        return json(response, { session_id: session.id, session, status: status() }, 201);
      }
      if (method === 'POST' && ['/api/sessions/stop', '/api/recordings/stop'].includes(route)) {
        const input = await body(request);
        const session = await changeSession(async () => {
          // Bind delayed/other-page stop requests before closing media handles. A
          // stale stop must never terminate the next recording and strand its encoder.
          if (input.session_id !== undefined && (typeof input.session_id !== 'string' || !SAFE_ID.test(input.session_id)))
            throw failure('录制会话标识无效。');
          if (cameras.active && input.session_id === undefined)
            throw failure('浏览器媒体录制需要指定会话，请刷新页面并在开始录制的页面停止保存。', 409);
          if (input.session_id !== undefined && input.session_id !== capture.status().session_id)
            throw failure('录制会话已变化，请刷新状态后再操作；当前录制未被停止。', 409);
          return stopSession();
        });
        return json(response, { session, status: status() });
      }
      if (method === 'GET' && route === '/api/sessions') return json(response, { sessions: await capture.listSessions() });
      const continuityMatch = /^\/api\/sessions\/([^/]+)\/continuity(\/cancel)?$/.exec(route);
      if (continuityMatch) {
        const [, id, cancel] = continuityMatch;
        if (!SAFE_ID.test(id)) throw failure('录制会话标识无效。');
        if (method === 'GET' && !cancel) return json(response, { job: await continuity.get(id) });
        if (method === 'POST' && cancel) {
          await body(request);
          return json(response, { job: await continuity.cancel(id) });
        }
        if (method === 'POST' && !cancel) {
          const input = await body(request);
          if (transition || capture.status().session_id) throw failure('请先停止当前采集，再检查历史录制的时间连续性。', 409);
          // Reserve the transition while preparing the scan, so capture cannot
          // start between the idle check and the worker being registered.
          const job = await changeSession(() => continuity.start(id, { threshold_ms: input.threshold_ms }));
          return json(response, { job }, 202);
        }
      }
      const recoveryMatch = /^\/api\/sessions\/([^/]+)\/recovery$/.exec(route);
      if (method === 'POST' && recoveryMatch) {
        const input = await body(request);
        if (input.allow_incomplete !== true) throw failure('请明确确认检查不完整录制。');
        if (transition || capture.status().session_id) throw failure('请先停止当前录制，再检查异常会话。', 409);
        return json(response, await exports.inspectRecovery(recoveryMatch[1]));
      }
      const annotationMatch = /^\/api\/sessions\/([^/]+)\/(annotations|context|replay)$/.exec(route);
      if (annotationMatch) {
        const [, id, action] = annotationMatch;
        if (method === 'GET' && action === 'annotations') return json(response, await annotations.read(id));
        if (method === 'GET' && action === 'replay') {
          const value = url.searchParams.get('time_s');
          if (value !== null && (!value.trim() || !Number.isFinite(Number(value)))) throw failure('回放时间无效。');
          return json(response, await replay.frame(id, value === null ? 0 : Number(value)));
        }
        if (method === 'POST' && ['annotations', 'context'].includes(action)) {
          if (transition) throw failure('录制正在启动或停止，请稍后重试。', 409);
          const input = await body(request);
          return json(response, await annotations[action === 'context' ? 'context' : 'mutate'](id, input));
        }
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(route);
      if (method === 'GET' && sessionMatch) return json(response, await capture.getSession(sessionMatch[1]));
      const fileMatch = /^\/api\/files\/([^/]+)\/([^/]+)$/.exec(route);
      if (['GET', 'HEAD'].includes(method) && fileMatch) {
        const [, id, filename] = fileMatch;
        if (!SAFE_ID.test(id) || /[\\:]/.test(filename)) throw failure('无效文件路径。');
        const session = await capture.getSession(id);
        if (!session.finalized) throw failure('请先停止并保存录制。', 409);
        const allowedFiles = ['manifest.json', ...(session.streams ?? []).map(stream => stream?.file),
          ...(session.assets ?? []).map(asset => typeof asset === 'string' ? asset : asset?.file),
          ...(session.media_streams ?? []).flatMap(stream => [stream?.file, ...(stream?.segments ?? []).map(segment => segment?.file)])];
        if (!allowedFiles.includes(filename)) throw failure('文件不在会话清单中。', 404);
        const folder = await realpath(path.join(dataDir, id));
        const actual = await realpath(path.join(folder, filename));
        if (path.dirname(actual) !== folder || path.dirname(folder) !== await realpath(dataDir)) throw failure('无效文件路径。', 403);
        let extension = path.extname(actual), downloadName = filename;
        // Interrupted WAVs may already have a complete, committed PCM header.
        // Serve only verified ones as seekable audio; leave the original file untouched.
        if (filename.endsWith('.wav.part')) {
          const audio = (session.media_streams ?? []).find(stream => stream?.kind === 'audio' && stream.mode === 'browser-microphone' &&
            (stream.file === filename || stream.segments?.some(segment => segment?.file === filename)));
          if (audio) {
            const segment = audio.segments?.find(item => item?.file === filename) ?? audio;
            try { await checkWave(folder, audio, segment); extension = '.wav'; downloadName = filename.slice(0, -5); }
            catch { /* Still allow original attachment download when PCM validation fails. */ }
          }
        }
        return await sendFile(request, response, actual, downloadName, extension);
      }
      if (method === 'GET' && route === '/api/export/formats') return json(response, { formats: exports.formats() });
      if (method === 'GET' && route === '/api/export/jobs') return json(response, { jobs: exports.listJobs() });
      if (method === 'POST' && route === '/api/export/jobs') {
        const input = await body(request);
        if (input.recovery === true && (transition || capture.status().session_id))
          throw failure('请先停止当前录制，再导出不完整数据包。', 409);
        return json(response, await exports.createJob(input), 202);
      }
      const jobMatch = /^\/api\/export\/jobs\/([^/]+)$/.exec(route);
      if (method === 'GET' && jobMatch) return json(response, exports.getJob(jobMatch[1]));
      const downloadMatch = /^\/api\/export\/download\/([^/]+)$/.exec(route);
      if (['GET', 'HEAD'].includes(method) && downloadMatch) {
        const file = await exports.download(downloadMatch[1]);
        return await sendFile(request, response, file.path, file.filename);
      }
      if (route.startsWith('/api/')) throw failure('API 不存在。', 404);
      if (!['GET', 'HEAD'].includes(method)) throw failure('不支持的请求方法。', 405);
      const webRoot = await realpath(webDir).catch(() => null);
      if (!webRoot) throw failure('界面尚未构建，请在 node 目录运行 npm run build。', 503);
      const relative = route === '/' ? 'index.html' : route.slice(1);
      if (relative.split(/[\\/]/).some(part => part === '..') || relative.includes(':')) throw failure('无效页面路径。', 403);
      let filename = await realpath(path.join(webRoot, relative)).catch(() => null);
      if (!filename && !path.extname(relative)) filename = path.join(webRoot, 'index.html');
      if (!filename) throw failure('静态文件不存在。', 404);
      const inside = path.relative(webRoot, filename);
      if (inside.startsWith('..') || path.isAbsolute(inside)) throw failure('无效页面路径。', 403);
      return await sendFile(request, response, filename);
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const code = error.statusCode ?? error.status ?? (error.code === 'ENOENT' ? 404 : 500);
      const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
      json(response, { error: error.message || '服务处理失败。', ...(error.code && typeof error.code === 'string' ? { code: error.code } : {}) }, status);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  // Reserve the port before any recovery mutates persistent session/job state.
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    actualPort = server.address().port;
    await capture.init(); await annotations.recover(await capture.listSessions()); await exports.init(); await replay.init(); ready = true;
  } catch (error) {
    closing = true;
    portOwners.close();
    cameraPreview.close();
    const httpClosed = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    server.closeIdleConnections();
    await cameras.close().catch(() => {}); await annotations.close().catch(() => {}); await replay.close().catch(() => {});
    await capture.close().catch(() => {}); await exports.close().catch(() => {}); await continuity.close().catch(() => {});
    server.closeAllConnections();
    await httpClosed;
    throw error;
  }
  let closePromise;
  return { server, capture, cameras, exports, annotations, replay, continuity, port: actualPort, url: `http://127.0.0.1:${actualPort}`,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      portOwners.close();
      cameraPreview.close();
      closePromise = (async () => {
        const httpClosed = new Promise(resolve => server.close(resolve));
        await transition?.catch(() => {});
        const media = await cameras.close();
        // A direct service stop also persists partial video and marks it incomplete.
        let finalizeError;
        if (capture.status().session_id && !capture.failure) {
          try {
            const manifest = await capture.stop(media);
            await annotations.finalize(manifest);
          } catch (error) { finalizeError = error; }
        }
        const results = await Promise.allSettled([capture.close(), exports.close(), annotations.close(), replay.close(), continuity.close()]);
        // All accepted media writes and queued exports have drained. Chromium may
        // leave TCP preconnections (no HTTP request yet), incomplete request bodies,
        // or paused downloads; closeIdleConnections() does not close those sockets.
        // They must not keep an already-saved desktop service alive indefinitely.
        server.closeAllConnections();
        await httpClosed;
        const failed = results.find(result => result.status === 'rejected');
        if (finalizeError) throw finalizeError;
        if (failed) throw failed.reason;
      })();
      return closePromise;
    } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { port: Number(process.env.PORT ?? 8785),
    dataDir: path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data/sessions')) };
  try {
    const app = await createApplication(options);
    console.log(`Synapse Node 采集工作站：${app.url}`);
    console.log('Ctrl+C 停止服务并保存录制。传感器选择与连接见“数据采集”。');
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      console.log('正在停止采集并等待写盘、导出完成…');
      app.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) {
    const status = await startupStatus(error, options);
    if (status.reused) console.log(status.message); else console.error(status.message);
    process.exitCode = status.exitCode;
  }
}
