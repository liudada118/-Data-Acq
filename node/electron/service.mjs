import path from 'node:path';
import { fork } from 'node:child_process';

const failure = (message, code) => Object.assign(new Error(message), { code });
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

/** Reuse only the expected development service; never adopt a different data directory. */
async function existingService(port, dataDir, packaged) {
  if (!port) return null;
  let response;
  try { response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' }); }
  catch (error) {
    const codes = [error.cause?.code, ...(error.cause?.errors ?? []).map(cause => cause.code)];
    if (codes.includes('ECONNREFUSED')) return null;
    throw failure(`本机端口 ${port} 已被占用或无法验证，请检查已启动的服务。`, 'DESKTOP_PORT_UNAVAILABLE');
  }
  if (packaged) throw failure(`桌面应用端口 ${port} 已被占用，请关闭占用该端口的程序后重试。`, 'DESKTOP_PORT_OCCUPIED');
  let health;
  try { health = await response.json(); } catch { /* Reject unrelated HTTP services. */ }
  if (!response.ok || health?.service !== 'synapse-node' || health.engine_alive !== true ||
      typeof health.data_dir !== 'string' || pathKey(health.data_dir) !== pathKey(dataDir))
    throw failure(`端口 ${port} 未运行使用当前开发数据目录的健康数采服务，未连接或关闭该服务。`, 'DESKTOP_SERVICE_MISMATCH');
  return { url: `http://127.0.0.1:${port}`, owned: false, dataDir, close: async () => {} };
}

/** Launch an owned Node-mode backend or attach to the explicitly expected development instance. */
export async function startDesktopService({ executable, root, userData, port, packaged = false,
  env = {}, disableEnvFile = false, startupTimeoutMs = 30000, sdkPath, webDir } = {}) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || typeof root !== 'string' || !path.isAbsolute(root) ||
      typeof userData !== 'string' || !path.isAbsolute(userData) || !Number.isInteger(port) || port < 0 || port > 65535 ||
      !Number.isFinite(startupTimeoutMs) || startupTimeoutMs < 1 ||
      (webDir !== undefined && (typeof webDir !== 'string' || !path.isAbsolute(webDir)))) throw failure('桌面服务启动参数无效。', 'DESKTOP_CONFIG_INVALID');
  root = path.resolve(root); userData = path.resolve(userData);
  const dataDir = packaged ? path.join(userData, 'data', 'sessions') : path.join(root, 'data', 'annotations', 'sessions');
  const outputDir = packaged ? path.join(userData, 'data', 'exports') : path.join(root, 'data', 'annotations', 'exports');
  const existing = await existingService(port, dataDir, packaged);
  if (existing) return existing;
  const envFile = path.join(packaged ? userData : root, '.env.local');
  const child = fork(path.join(root, 'electron', 'backend.mjs'), [], {
    execPath: executable, cwd: root, windowsHide: true,
    execArgv: disableEnvFile ? [] : [`--env-file-if-exists=${envFile}`],
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
    // Config/keys never appear in arguments or logs; lifecycle errors arrive through IPC.
    // This outer channel may cross host-Node/Electron V8 versions in tests or tooling.
    // Lifecycle payloads are JSON only; native capture keeps its own same-runtime IPC.
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
  });
  let didExit = false, closeAcknowledgement, closePromise;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { didExit = true; resolve({ code, signal }); }));
  child.on('message', message => { if (message?.type === 'closed') closeAcknowledgement = message; });

  /** Wait for drain and process exit without a normal-shutdown kill deadline. */
  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (!didExit && child.connected) child.send({ type: 'stop' }, () => {});
      const result = await exited;
      if (!closeAcknowledgement?.ok) throw failure(closeAcknowledgement?.error ||
        `采集服务未确认完成保存即退出 (${result.signal ?? result.code})。`, 'DESKTOP_CLOSE_FAILED');
    })();
    return closePromise;
  }

  try {
    const ready = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        child.removeListener('message', onMessage);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        error ? reject(error) : resolve(value);
      };
      const onError = error => finish(failure(`无法启动桌面采集服务 (${error.code ?? 'spawn failed'})。`, 'DESKTOP_START_FAILED'));
      const onExit = (code, signal) => finish(failure(`桌面采集服务在就绪前退出 (${signal ?? code})。`, 'DESKTOP_START_FAILED'));
      const onMessage = message => {
        if (message?.type === 'startup-error') return finish(failure(message.error || '桌面采集服务启动失败。', message.code || 'DESKTOP_START_FAILED'));
        if (message?.type !== 'ready') return;
        try {
          const url = new URL(message.url);
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
              (port && Number(url.port) !== port) || url.pathname !== '/' || url.search || url.hash ||
              typeof message.dataDir !== 'string' || pathKey(message.dataDir) !== pathKey(dataDir)) throw new Error();
          finish(null, { url: url.origin });
        } catch { finish(failure('桌面采集服务返回了无效的启动信息。', 'DESKTOP_START_FAILED')); }
      };
      const timer = setTimeout(() => finish(failure('桌面采集服务启动超时。', 'DESKTOP_START_TIMEOUT')), startupTimeoutMs);
      child.on('message', onMessage); child.once('error', onError); child.once('exit', onExit);
      child.send({ type: 'initialize', config: { port, dataDir, outputDir, webDir: webDir ?? path.join(root, 'ui', 'dist'), ...(sdkPath === false ? { sdkPath: false } : {}) } }, error => {
        if (error) onError(error);
      });
    });
    // Keep an error listener after readiness so late IPC/process errors do not crash Electron.
    child.on('error', () => {});
    return { ...ready, owned: true, dataDir, close, get exited() { return didExit; } };
  } catch (error) {
    child.on('error', () => {});
    // A failed startup has never been handed to a renderer or begun user recording.
    // Only this owned failed-start process is terminated; normal close always drains.
    if (!didExit && child.pid) { child.kill('SIGKILL'); await exited; }
    throw error;
  }
}
