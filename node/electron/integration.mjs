import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModelSettingsStore } from './integration-settings.mjs';
import { createModelCatalog } from './integration-model-catalog.mjs';

const allowed = new Set(['list', 'status', 'importFiles', 'chat', 'cancel', 'test', 'install', 'readDraft', 'writeDraft']);

/** Privileged SDK operations are exposed only to the trusted desktop main frame. */
export function registerIntegration({ ipcMain, utilityProcess, safeStorage, dialog, trustedSender, getWindow, service, root, userData,
  modelCatalogFetch = globalThis.fetch, modelCatalogUrl }) {
  const store = createModelSettingsStore({ filename: path.join(userData, 'sdk-agent-model.json'), safeStorage });
  const catalog = createModelCatalog({ cacheDir: userData, fetchImpl: modelCatalogFetch, ...(modelCatalogUrl ? { url: modelCatalogUrl } : {}) });
  let child, starting, disposed = false, mutation = false, configuring = false, importing = false;
  const pending = new Map();
  function request(action, args, modelConfig) {
    if (!child) return Promise.reject(new Error('SDK Agent 进程未运行。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      // Mutations complete in the worker before their UI locks/maintenance leases
      // are released; a large SDK copy must not report failure while still writing.
      const timer = ['importDirectory', 'test', 'install', 'close'].includes(action) ? null : setTimeout(() => { pending.delete(id); reject(new Error('SDK Agent 操作超时，请检查任务状态。')); }, 180000);
      pending.set(id, { resolve, reject, timer });
      child.postMessage({ id, action, args, modelConfig });
    });
  }
  function rejectPending() {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('SDK Agent 进程已退出，采集服务仍独立运行。')); }
    pending.clear(); child = null; starting = null;
  }
  async function ensure() {
    if (disposed) throw new Error('应用正在退出。');
    if (!starting) {
      const env = {};
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      child = utilityProcess.fork(path.join(root, 'electron', 'integration-worker.mjs'), [], {
        serviceName: 'SDK Integration Agent', stdio: 'ignore', cwd: root, env,
      });
      child.on('message', message => {
        const item = pending.get(message?.id); if (!item) return;
        clearTimeout(item.timer); pending.delete(message.id);
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
      });
      child.once('exit', rejectPending);
      const dataRoot = path.dirname(service.dataDir);
      starting = request('initialize', { root: path.join(dataRoot, 'sdk-integration'), pluginsRoot: path.join(dataRoot, 'plugins') });
    }
    await starting;
  }
  async function api(route, args) {
    const response = await fetch(`${service.url}${route}`, { method: args === undefined ? 'GET' : 'POST',
      headers: args === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: args === undefined ? undefined : JSON.stringify(args), signal: AbortSignal.timeout(15000), redirect: 'error' });
    const value = await response.json();
    if (!response.ok) throw new Error(response.status === 404 ? '采集服务版本较旧，请停止采集后重新启动桌面软件和旧的 Node 服务。' : value.error ?? '采集服务操作失败。');
    return value;
  }
  const check = event => { if (!trustedSender(event)) throw new Error('仅允许数采主窗口使用 SDK Agent。'); };
  const handlers = {
    'integration:settings:get': async event => { check(event); return store.get(); },
    'integration:settings:catalog': async (event, input) => { check(event); return catalog.load(input); },
    'integration:settings:save': async (event, input) => {
      check(event);
      if (configuring) throw new Error('模型连接正在处理，请稍后重试。');
      configuring = true;
      try {
        if (child) {
          await ensure();
          const state = await request('list');
          if (state.workspaces.some(workspace => workspace.status === 'adapting')) throw new Error('请先停止当前 Agent 任务，再修改模型连接。');
        }
        return await store.save(input);
      } finally { configuring = false; }
    },
    'integration:choose-sdk': async event => {
      check(event);
      if (importing) throw new Error('已有 SDK 正在选择或导入，请等待完成后重试。');
      importing = true;
      try {
        const result = await dialog.showOpenDialog(getWindow(), { title: '选择厂商 SDK 文件夹', properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths[0]) return null;
        await ensure();
        return await request('importDirectory', { path: result.filePaths[0] });
      } finally { importing = false; }
    },
    'integration:invoke': async (event, action, args) => {
      check(event);
      if (!allowed.has(action)) throw new Error('不支持的 Agent 操作。');
      if (action === 'chat') {
        if (configuring) throw new Error('模型连接正在处理，请稍后重试。');
        configuring = true;
        try { await ensure(); return await request(action, args, await store.privateValue()); }
        finally { configuring = false; }
      }
      await ensure();
      if (!['test', 'install'].includes(action)) return request(action, args);
      if (mutation) throw new Error('已有测试或安装正在进行。');
      mutation = true;
      let lease, renewal;
      try {
        // The service holds starts/connects until this explicit test/install finishes.
        lease = await api('/api/plugins/maintenance', { action: 'acquire' });
        renewal = setInterval(() => { void api('/api/plugins/maintenance', { action: 'renew', token: lease.token }).catch(() => {}); }, 30000);
        const result = await request(action, args);
        if (action === 'install') await api('/api/plugins/reload', { maintenance_token: lease.token });
        return result;
      } finally {
        clearInterval(renewal);
        if (lease) await api('/api/plugins/maintenance', { action: 'release', token: lease.token }).catch(() => {});
        mutation = false;
      }
    },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler);
  return {
    async close() {
      disposed = true;
      catalog.dispose();
      for (const name of Object.keys(handlers)) ipcMain.removeHandler(name);
      if (child) {
        const owned = child;
        const exited = new Promise(resolve => owned.once('exit', resolve));
        // Agent work cannot hold up saved acquisition shutdown indefinitely.
        await Promise.race([request('close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
        if (child === owned) { owned.kill(); await exited; }
      }
    },
  };
}
