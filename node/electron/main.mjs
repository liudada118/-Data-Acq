import { app, BrowserWindow, Menu, dialog, ipcMain, shell, session, utilityProcess, safeStorage, net } from 'electron';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startDesktopService } from './service.mjs';
import { allowMedia, isDownloadUrl, sameOrigin, validCaptureStatus } from './security.mjs';
import { registerIntegration } from './integration.mjs';

app.setName('Shroom Capture');
app.setAppUserModelId('com.shroom.synapse-acquisition');
// Keep desktop storage independent from Chrome and other Electron applications.
app.setPath('userData', path.join(app.getPath('appData'), 'ShroomCapture'));
let win, service, closing, closeReply, integration;
let mayQuit = false, rendererReady = false;

function trustedSender(event) {
  return event.sender === win?.webContents && event.senderFrame === win?.webContents.mainFrame
    && sameOrigin(event.senderFrame?.url, service?.url);
}

ipcMain.on('desktop:renderer-ready', event => { if (trustedSender(event)) rendererReady = true; });
ipcMain.on('desktop:close-result', (event, result) => {
  if (trustedSender(event) && result?.id === closeReply?.id) closeReply.resolve(result);
});

async function readStatus() {
  const response = await fetch(`${service.url}/api/status`, { signal: AbortSignal.timeout(6000), redirect: 'error' });
  const status = await response.json();
  if (!response.ok || !validCaptureStatus(status)) throw new Error('无法读取有效的采集状态。');
  return status;
}

function finishQuit() {
  mayQuit = true;
  win?.destroy();
  app.quit();
}

async function acknowledgeExitedService() {
  if (!service?.owned || !service.exited) return false;
  const result = await dialog.showMessageBox(win, { type: 'warning', title: '采集服务已退出',
    message: '采集服务已异常退出，未完成的录制可能不完整。',
    detail: '已写入的文件会保留，下次启动时恢复。关闭窗口将结束当前桌面预览。',
    buttons: ['返回工作站', '关闭窗口'], defaultId: 0, cancelId: 0 });
  if (result.response === 1) finishQuit();
  return true;
}

/** Ask the mounted React app to flush video and persist the recording before exit. */
async function prepareRendererClose() {
  if (!win || win.isDestroyed() || !rendererReady) {
    if (!service) return { ok: true };
    const status = await readStatus();
    return status.session_id ? { ok: false, message: '仍有录制进行中。请等待采集页面就绪，停止并保存后再退出。' } : { ok: true };
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => finish({ ok: false, message: '尚未收到保存完成确认，窗口已保留。请检查录制状态后重试。' }), 90000);
    function finish(result) { clearTimeout(timer); closeReply = null; resolve(result); }
    closeReply = { id: randomUUID(), resolve: finish };
    win.webContents.send('desktop:prepare-close', { id: closeReply.id });
  });
}

/** Close only the service this window started; reused browser services stay running. */
function requestClose() {
  if (closing || mayQuit) return;
  closing = (async () => {
    try {
      const result = await prepareRendererClose();
      if (!result.ok) {
        if (await acknowledgeExitedService()) return;
        await dialog.showMessageBox(win, { type: 'warning', title: '暂未退出', message: result.message || '请先停止并保存录制。', buttons: ['返回工作站'] });
        return;
      }
      win?.setTitle('Shroom 数采工作站 · 正在退出');
      await integration?.close();
      await service?.close();
      finishQuit();
    } catch (error) {
      if (await acknowledgeExitedService()) return;
      await dialog.showMessageBox(win, { type: 'error', title: '退出未完成', message: '无法确认采集服务已完成保存，窗口已保留。', detail: error.message, buttons: ['返回工作站'] });
    } finally { closing = null; }
  })();
}

/** Prevent a reload from discarding an active MediaRecorder. */
async function reloadWindow() {
  if (!win || !service || closing) return;
  try {
    const status = await readStatus();
    if (status.session_id) {
      await dialog.showMessageBox(win, { type: 'info', message: '请先停止并保存录制，再刷新页面。' });
      return;
    }
    rendererReady = false;
    win.reload();
  } catch { await dialog.showMessageBox(win, { type: 'warning', message: '采集服务暂不可用，请稍后重试。' }); }
}

async function openDirectory(folder) {
  await mkdir(folder, { recursive: true });
  const error = await shell.openPath(folder);
  if (error) await dialog.showMessageBox(win, { type: 'error', message: '无法打开目录', detail: error });
}

async function createWindow() {
  const desktopSession = session.fromPartition('persist:workstation');
  desktopSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => allowMedia({
    permission, requestingUrl: requestingOrigin, origin: service.url, trustedContents: contents === win?.webContents,
    isMainFrame: details.isMainFrame, mediaTypes: details.mediaType ? [details.mediaType] : undefined,
  }));
  desktopSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowMedia({
    permission, requestingUrl: details.requestingUrl || contents.getURL(), origin: service.url,
    trustedContents: contents === win?.webContents, isMainFrame: details.isMainFrame, mediaTypes: details.mediaTypes,
  })));
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 960, minHeight: 640, show: false,
    title: 'Shroom 数采工作站', backgroundColor: '#f4f6f1', icon: path.join(app.getAppPath(), 'electron/assets/icon.ico'),
    webPreferences: { preload: path.join(app.getAppPath(), 'electron/preload.cjs'), session: desktopSession,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
  });
  win.on('close', event => { if (!mayQuit) { event.preventDefault(); requestClose(); } });
  win.on('page-title-updated', event => { event.preventDefault(); });
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) rendererReady = false; });
  win.webContents.on('will-navigate', (event, url) => { if (!sameOrigin(url, service.url)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (!sameOrigin(url, service.url)) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isDownloadUrl(url, service.url)) win.webContents.downloadURL(url);
    else if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  desktopSession.on('will-download', (event, item) => {
    if (!isDownloadUrl(item.getURL(), service.url)) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: '保存采集数据', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r'))) {
      event.preventDefault(); void reloadWindow();
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '打开采集数据目录', click: () => void openDirectory(service.dataDir) },
      { label: '打开桌面配置目录', click: () => void openDirectory(app.getPath('userData')) },
      { type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: requestClose },
    ] },
    { label: '查看', submenu: [
      { label: '刷新页面', accelerator: 'F5', click: () => void reloadWindow() },
      { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { role: 'togglefullscreen', label: '全屏' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: '开发者工具' }] : []),
    ] },
    { label: '帮助', submenu: [{ label: '关于数采工作站', click: () => void dialog.showMessageBox(win, {
      type: 'info', title: 'Shroom 数采工作站', message: `Shroom Capture ${app.getVersion()}`,
      detail: `多模态数据采集工作站\n${service.owned ? '桌面管理采集服务' : '复用已运行的本地采集服务'}\n${service.url}`,
    }) }] },
  ]));
  await win.loadURL(service.url);
  win.setTitle('Shroom 数采工作站');
  win.maximize();
  win.show();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.on('before-quit', event => { if (!mayQuit) { event.preventDefault(); requestClose(); } });
  app.on('window-all-closed', () => { if (mayQuit) app.quit(); });
  app.whenReady().then(async () => {
    const root = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath();
    const port = Number(process.env.SYNAPSE_DESKTOP_PORT ?? (app.isPackaged ? 8789 : 8788));
    service = await startDesktopService({ executable: process.execPath, root, userData: app.getPath('userData'), port,
      packaged: app.isPackaged, webDir: path.join(app.getAppPath(), 'ui/dist') });
    integration = registerIntegration({ ipcMain, utilityProcess, safeStorage, dialog, trustedSender,
      getWindow: () => win, service, root, userData: app.getPath('userData'), modelCatalogFetch: (url, options) => net.fetch(url, options) });
    await createWindow();
  }).catch(async error => {
    dialog.showErrorBox('数采工作站启动失败', `${error.message}\n请检查端口和本地配置。`);
    await integration?.close().catch(() => {});
    await service?.close().catch(() => {});
    mayQuit = true; app.quit();
  });
}
