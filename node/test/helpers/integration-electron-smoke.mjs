import { app, BrowserWindow, ipcMain, utilityProcess, safeStorage } from 'electron';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerIntegration } from '../../electron/integration.mjs';
import { extractSdkDocument } from '../../src/integration/document-reader.mjs';
import { docx, pdf } from './sdk-document-fixtures.mjs';

// Launched only by integration-electron.test.mjs, in a new temp userData directory.
const { temporary, serviceUrl, nodeRoot } = JSON.parse(readFileSync(process.env.SDK_AGENT_SMOKE_CONFIG, 'utf8'));
mkdirSync(path.join(temporary, 'electron-profile'), { recursive: true });
app.setPath('userData', path.join(temporary, 'electron-profile'));
app.whenReady().then(async () => {
const calls = new Map();
let window;
const bridge = registerIntegration({ ipcMain: { handle: (name, handler) => { calls.set(name, handler); ipcMain.handle(name, handler); }, removeHandler: name => { calls.delete(name); ipcMain.removeHandler(name); } },
  utilityProcess, safeStorage, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(temporary, 'vendor-sdk')] }) },
  trustedSender: event => event.trusted === true || (!!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame), getWindow: () => window,
  modelCatalogFetch: async (_url, options) => {
    if (options.credentials !== 'omit' || options.headers.Authorization) throw new Error('Catalog received credentials');
    return new Response(readFileSync(path.join(nodeRoot, 'src/integration/model-catalog-defaults.json'), 'utf8'), { headers: { 'content-type': 'application/json' } });
  },
  service: { url: serviceUrl, dataDir: path.join(temporary, 'sessions') }, root: nodeRoot, userData: app.getPath('userData') });
const invoke = (action, args) => calls.get('integration:invoke')({ trusted: true }, action, args);
try {
  // Exercise the shipped document parsers and their bounded worker_threads in
  // Electron's runtime, not only the developer's standalone Node process.
  const word = await extractSdkDocument(docx('Electron DOCX 左目协议 fixture'), '.docx');
  const document = await extractSdkDocument(pdf(['Electron PDF rtsp://camera:1254']), '.pdf');
  if (!word.content.includes('左目协议') || !document.content.includes('rtsp://camera:1254') || document.page_count !== 1) throw new Error('Electron document parser bridge failed');
  let denied = false;
  try { await calls.get('integration:invoke')({ trusted: false }, 'list'); } catch { denied = true; }
  if (!denied) throw new Error('Untrusted bridge call was accepted');
  await calls.get('integration:settings:save')({ trusted: true }, { baseUrl: 'http://127.0.0.1:9999/v1', model: 'local-fixture', apiKey: 'test-fixture-only' });
  const settings = await calls.get('integration:settings:get')({ trusted: true });
  if (!settings.hasKey || settings.apiKey) throw new Error('Settings credential boundary failed');
  const catalog = await calls.get('integration:settings:catalog')({ trusted: true }, { refresh: true });
  if (catalog.source !== 'remote' || !catalog.providers.some(provider => provider.id === 'custom')) throw new Error('Model catalog bridge failed');
  const workspace = await calls.get('integration:choose-sdk')({ trusted: true });
  const workspace_id = workspace.id;
  const manifest = { api_version: 1, id: 'electron-fixture', name: 'Electron test fixture', version: '1.0.0', entry: 'adapter.mjs',
    streams: [{ id: 'pressure', name: 'Fixture pressure', kind: 'pressure', dtype: 'float32', shape: [1, 1], sample_rate: 20, unit: 'ADC' }] };
  await invoke('writeDraft', { workspace_id, path: 'plugin.json', content: JSON.stringify(manifest) });
  await invoke('writeDraft', { workspace_id, path: 'adapter.mjs', content: `export function createAdapter(){ return {start(){},stop(){},probe(){return {runtime:process.versions.electron?'electron-node':'node'};}};}` });
  const tested = await invoke('test', { workspace_id });
  if (!tested.test?.passed) throw new Error(JSON.stringify(tested.test));
  const installed = await invoke('install', { workspace_id });
  if (installed.installed?.plugin_id !== manifest.id) throw new Error('Plugin was not installed');
  const listed = await invoke('list');
  if (listed.workspaces.length !== 1) throw new Error('Workspace was not persisted');
  // Exercise the built React UI and the actual sandboxed preload in a hidden window.
  window = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { preload: path.join(nodeRoot, 'electron', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(serviceUrl);
  let ready = false;
  for (let attempt = 0; attempt < 80 && !ready; attempt++) {
    ready = await window.webContents.executeJavaScript(`(() => { const nav = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'SDK 接入 Agent'); if(nav) nav.click(); return !!document.querySelector('section[aria-label="SDK 接入 Agent"]') && document.body.textContent.includes('已安装版本'); })()`);
    if (!ready) await delay(50);
  }
  if (!ready) throw new Error('Built Agent workbench did not load its installed workspace through preload');
  const state = await window.webContents.executeJavaScript(`({ hasBridge: !!window.synapseDesktop?.integration, hasFixture: document.body.textContent.includes('Electron test fixture'), hasInstallButton: [...document.querySelectorAll('button')].some(button => button.textContent.includes('安装传感器')) })`);
  if (!state.hasBridge || !state.hasFixture || !state.hasInstallButton) throw new Error('Built UI is missing the SDK installation workflow');
  await window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim().startsWith('模型连接')); if (!button) throw new Error('Model settings button missing'); button.click(); })()`);
  let modelPanelReady = false;
  for (let attempt = 0; attempt < 80 && !modelPanelReady; attempt++) {
    modelPanelReady = await window.webContents.executeJavaScript(`!!document.querySelector('select[aria-label="服务商"]') && document.body.textContent.includes('已从 Shroom 接口更新模型列表')`);
    if (!modelPanelReady) await delay(50);
  }
  if (!modelPanelReady) throw new Error('Built model settings did not read Shroom catalog through preload');
  const modelUi = await window.webContents.executeJavaScript(`({ choices: [...document.querySelector('select[aria-label="服务商"]').options].map(item => item.value), key: document.querySelector('input[aria-label="API Key"]').value })`);
  if (!['deepseek', 'openai', 'custom'].every(id => modelUi.choices.includes(id)) || modelUi.key !== '') throw new Error('Model catalog or credential display mismatch');
  process.stdout.write('INTEGRATION_SMOKE_OK\n');
} catch (error) {
  process.stderr.write(`INTEGRATION_SMOKE_FAILED: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  window?.destroy();
  await bridge.close();
  app.exit(process.exitCode ?? 0);
}
}).catch(error => { process.stderr.write(error.message); app.exit(1); });
