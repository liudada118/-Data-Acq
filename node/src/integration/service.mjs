import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, lstat, rename, rm } from 'node:fs/promises';
import { inspectPackage } from '../plugins/contract.mjs';
import { probePackage } from '../plugins/manager.mjs';
import { runtimeCapabilities } from './runtime-capabilities.mjs';
import { LIMITS, TEXT_EXTENSIONS, problem, safeRelative, secretPath, atomicJson, readJson, inspectTree, copyTree, treeRevision, hashFile, assertDiskSpace } from './storage.mjs';
import { normalizeModelSettings, requestModel } from './provider.mjs';
import { AGENT_TOOLS, AGENT_INSTRUCTIONS, parseToolArguments, readSdkText, sdkFileReadingInfo } from './agent-tools.mjs';

const WORKSPACE_ID = /^sdk-[a-f0-9-]{36}$/;
const now = () => new Date().toISOString();
const message = (role, content) => ({ id: randomUUID(), role, content, created_at: now() });
const summary = state => ({ id: state.id, name: state.name, created_at: state.created_at, updated_at: state.updated_at,
  status: state.status, file_count: state.files.length, bytes: state.bytes, ...(state.installed ? { installed: state.installed } : {}) });

/** Local service used only by the Electron Agent worker, never exposed as a public HTTP executor. */
export async function createIntegrationService({ root, pluginsRoot, fetchImpl = globalThis.fetch, getModelSettings, onInstalled,
  checkDiskSpace = assertDiskSpace, copySdkTree = copyTree, importLimits = LIMITS } = {}) {
  if (!root || !pluginsRoot) throw problem('SDK 工作目录尚未配置。');
  const base = path.resolve(root), packages = path.resolve(pluginsRoot);
  await mkdir(base, { recursive: true }); await mkdir(packages, { recursive: true });
  const running = new Map(); let installation = null, importing = null, closed = false;
  const folder = id => {
    if (!WORKSPACE_ID.test(id ?? '')) throw problem('SDK 工作区无效。');
    return path.join(base, id);
  };
  async function save(state) {
    state.updated_at = now();
    await atomicJson(path.join(folder(state.id), 'workspace.json'), state);
    return publicState(state);
  }
  function publicState(state) {
    const result = structuredClone(state);
    result.files = result.files.map(sdkFileReadingInfo);
    return result;
  }
  async function load(id) {
    const state = await readJson(path.join(folder(id), 'workspace.json'));
    if (state.id !== id || !Array.isArray(state.files) || !Array.isArray(state.messages)) throw problem('SDK 工作区记录损坏。');
    if (['adapting', 'testing'].includes(state.status) && !running.has(id)) {
      state.test = null;
      state.status = state.draft?.files?.length ? 'draft' : 'imported';
      state.error = '上次任务被中断；草稿已保留，请重新测试后安装。';
      if (state.task?.status === 'running') state.task.status = 'cancelled';
      await save(state);
    }
    return state;
  }
  function assertIdle(id) {
    if (closed) throw problem('Agent 正在关闭。', 409);
    if (running.has(id)) throw problem('此 SDK 正在适配或测试，请等待或取消当前任务。', 409);
  }
  function reserve(id, controller = null) {
    folder(id); assertIdle(id);
    const job = { controller, promise: null };
    running.set(id, job); return job;
  }
  async function refreshDraft(state, { verifySdk = true } = {}) {
    const draftRoot = path.join(folder(state.id), 'draft');
    let tree;
    if (verifySdk) tree = await inspectTree(draftRoot);
    else {
      // Editing a tiny adapter must not reread gigabytes of unchanged SDK data.
      // Probe (before AND after) and installation still hash the entire tree.
      const files = state.files.map(file => ({ ...file, path: `sdk/${file.path}` }));
      for (const name of ['plugin.json', 'adapter.mjs']) {
        const filename = path.join(draftRoot, name);
        let info;
        try { info = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!info.isFile() || info.isSymbolicLink() || info.size > LIMITS.sourceBytes) throw problem('草稿文件无效。');
        files.push({ path: name, size: info.size, text: true, sha256: await hashFile(filename) });
      }
      tree = { files, bytes: files.reduce((sum, file) => sum + file.size, 0), skipped: [] };
    }
    state.draft = { revision: treeRevision(tree.files), files: tree.files.filter(file => !file.path.startsWith('sdk/')).map(({ path: name, size }) => ({ path: name, size })) };
    return tree;
  }
  async function newWorkspace(name) {
    const id = `sdk-${randomUUID()}`;
    return { id, name: String(name || '新 SDK').trim().slice(0, 160) || '新 SDK', created_at: now(), updated_at: now(), status: 'imported',
      files: [], bytes: 0, skipped_files: [], messages: [], draft: { files: [], revision: '' } };
  }
  async function removeOwnedStage(parent, stage, prefix) {
    const absolute = path.resolve(stage), relative = path.relative(path.resolve(parent), absolute);
    if (!relative.startsWith(prefix) || relative.includes(path.sep) || path.isAbsolute(relative)) throw problem('临时目录清理范围无效。');
    await rm(absolute, { recursive: true, force: true });
  }
  async function runImport(operation) {
    if (closed) throw problem('Agent 正在关闭。', 409);
    if (importing) throw problem('已有 SDK 正在导入，请等待完成后重试。', 409);
    const job = { controller: new AbortController(), promise: null };
    importing = job;
    job.promise = Promise.resolve().then(() => operation(job.controller.signal));
    try { return await job.promise; }
    catch (error) {
      if (job.controller.signal.aborted) throw problem('SDK 导入已取消，未完成的副本已清理。');
      if (error.code === 'ENOSPC') throw problem('目标磁盘空间不足，SDK 导入未完成；已清理本次临时副本，请释放空间后重试。');
      throw error;
    } finally { if (importing === job) importing = null; }
  }
  async function publishImport(state, tree, signal, writeSdk) {
    signal.throwIfAborted();
    for (const file of tree.files) safeRelative(`sdk/${file.path}`);
    state.files = tree.files; state.bytes = tree.bytes;
    state.skipped_files = tree.skipped.slice(0, 100); state.skipped_count = tree.skipped.length;
    state.draft = { files: [], revision: treeRevision(tree.files.map(file => ({ ...file, path: `sdk/${file.path}` }))) };
    // The complete import is invisible until copying, hash checks and metadata succeed.
    await checkDiskSpace(base, tree.bytes + Buffer.byteLength(JSON.stringify(state)) * 2);
    signal.throwIfAborted();
    const stage = path.join(base, `.import-${state.id}-${randomUUID()}`);
    let published = false;
    try {
      const sdkRoot = path.join(stage, 'draft', 'sdk');
      await mkdir(sdkRoot, { recursive: true });
      await writeSdk(sdkRoot);
      signal.throwIfAborted();
      state.updated_at = now();
      await atomicJson(path.join(stage, 'workspace.json'), state);
      signal.throwIfAborted();
      await rename(stage, folder(state.id)); published = true;
      return publicState(state);
    } finally { if (!published) await removeOwnedStage(base, stage, '.import-'); }
  }
  async function importDirectory(args) { return runImport(async signal => {
    const source = typeof args === 'string' ? args : args?.path;
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw problem('请选择 SDK 的完整本地目录。');
    const absolute = path.resolve(source);
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const overlaps = parent => key(parent) === key(absolute) || key(parent).startsWith(key(absolute) + path.sep) || key(absolute).startsWith(key(parent) + path.sep);
    if (overlaps(base) || overlaps(packages)) throw problem('SDK 目录不能包含或位于应用的接入工作目录。');
    const tree = await inspectTree(absolute, { excludeSecrets: true, limits: importLimits, signal });
    if (!tree.files.length) throw problem('此目录没有可导入的 SDK 文件。');
    const state = await newWorkspace(args?.name || path.basename(absolute));
    return publishImport(state, tree, signal, destination => copySdkTree(absolute, destination, tree.files, { signal }));
  }); }
  async function importFiles(args) { return runImport(async signal => {
    if (!Array.isArray(args?.files) || !args.files.length || args.files.length > LIMITS.files) throw problem('请选择有效的 SDK 文件。');
    const checked = [], seen = new Set(); let bytes = 0;
    for (const file of args.files) {
      const relative = safeRelative(file.path);
      if (secretPath(relative)) throw problem('请移除密钥、环境配置和凭据文件后导入。');
      if (seen.has(relative.toLowerCase())) throw problem('导入文件名重复。');
      seen.add(relative.toLowerCase());
      if (typeof file.content_base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content_base64)) throw problem('导入文件编码无效。');
      bytes += Math.floor(file.content_base64.length * 3 / 4);
      if (bytes > LIMITS.uploadBytes) throw problem('页面上传最多 32 MiB，请使用桌面文件夹导入。');
      checked.push({ path: relative, data: Buffer.from(file.content_base64, 'base64') });
    }
    const tree = { files: checked.map(file => ({ path: file.path, size: file.data.length,
      text: TEXT_EXTENSIONS.has(path.extname(file.path).toLowerCase()), sha256: createHash('sha256').update(file.data).digest('hex') })),
      bytes: checked.reduce((sum, file) => sum + file.data.length, 0), skipped: [] };
    const state = await newWorkspace(args.name);
    return publishImport(state, tree, signal, async sdkRoot => {
      for (const file of checked) {
        signal.throwIfAborted();
        const destination = path.join(sdkRoot, file.path);
        await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, file.data, { signal });
      }
    });
  }); }
  async function readDraft(args) {
    await load(args?.workspace_id);
    if (!['plugin.json', 'adapter.mjs'].includes(args.path)) throw problem('只能查看适配器和插件清单。');
    const filename = path.join(folder(args.workspace_id), 'draft', args.path);
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > LIMITS.sourceBytes) throw problem('草稿文件无效。');
      return { path: args.path, content: await readFile(filename, 'utf8') };
    } catch (error) { if (error.code === 'ENOENT') return { path: args.path, content: '' }; throw error; }
  }
  async function writeDraftFile(state, name, content) {
    if (!['plugin.json', 'adapter.mjs'].includes(name) || typeof content !== 'string' || Buffer.byteLength(content) > LIMITS.sourceBytes) throw problem('草稿只允许 plugin.json 和 adapter.mjs，单文件最多 256 KiB。');
    if (name === 'plugin.json') {
      let manifest;
      try { manifest = JSON.parse(content); } catch { throw problem('plugin.json 必须是有效 JSON。'); }
      if (manifest.entry !== 'adapter.mjs') throw problem('当前接入器入口必须为 adapter.mjs。');
    }
    const destination = path.join(folder(state.id), 'draft', name), temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, 'utf8'); await rename(temporary, destination);
    state.test = null; state.error = null;
    await refreshDraft(state, { verifySdk: false }); await save(state);
    return { saved: name, revision: state.draft.revision, executed: false };
  }
  async function writeDraft(args) {
    const id = args?.workspace_id, job = reserve(id);
    job.promise = (async () => {
      const state = await load(id);
      await writeDraftFile(state, args.path, args.content); state.status = 'draft';
      state.generation = { source: 'manual', updated_at: now() };
      return save(state);
    })();
    try { return await job.promise; } finally { running.delete(id); }
  }
  async function executeTool(state, call, signal) {
    const args = parseToolArguments(call);
    if (call.name === 'list_sdk_files') {
      const all = state.files.filter(item => !args.filter || item.path.toLowerCase().includes(args.filter.toLowerCase())), offset = args.offset ?? 0;
      return { files: all.slice(offset, offset + 120).map(sdkFileReadingInfo), total: all.length,
        offset, next_offset: offset + 120 < all.length ? offset + 120 : null, skipped_files: state.skipped_files };
    }
    if (call.name === 'read_sdk_file') return readSdkText(folder(state.id), state, args.path, { ...args, signal });
    if (call.name === 'read_draft_file') return readDraft({ workspace_id: state.id, path: args.path });
    if (call.name === 'write_draft_file') return writeDraftFile(state, args.path, args.content);
    if (call.name === 'replace_draft_text') {
      if (!args.before || Buffer.byteLength(args.before) > LIMITS.sourceBytes || Buffer.byteLength(args.after) > LIMITS.sourceBytes) throw problem('替换文本无效或超过草稿上限。');
      const { content } = await readDraft({ workspace_id: state.id, path: args.path });
      const index = content.indexOf(args.before);
      if (index < 0 || content.indexOf(args.before, index + 1) >= 0) throw problem('原代码段必须唯一匹配，请重新读取草稿后缩小替换范围。');
      return writeDraftFile(state, args.path, content.slice(0, index) + args.after + content.slice(index + args.before.length));
    }
    if (call.name === 'read_test_report') return state.test ?? { message: '用户尚未执行测试。' };
    if (call.name === 'read_runtime_capabilities') return runtimeCapabilities();
    throw problem('工具不存在。');
  }
  async function chat(args, suppliedSettings) {
    if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 16000) throw problem('请输入 1–16000 字的适配需求。');
    const controller = new AbortController(), job = reserve(args?.workspace_id, controller), ready = Promise.withResolvers();
    job.promise = (async () => {
      let state, settings;
      try {
        settings = normalizeModelSettings(suppliedSettings ?? await getModelSettings?.());
        if (!settings.model) throw problem('请先配置模型服务和模型名称。');
        state = await load(args.workspace_id);
        if (controller.signal.aborted) throw problem('任务已取消。');
        state.messages.push(message('user', args.message.trim())); state.messages = state.messages.slice(-40);
        state.status = 'adapting'; state.error = null;
        state.task = { id: randomUUID(), status: 'running', events: [{ time: now(), message: '正在分析 SDK，可读取源码及 DOCX/PDF 提取正文，生成适配草稿。' }] };
        await save(state); ready.resolve(publicState(state));
      } catch (error) { running.delete(args.workspace_id); ready.reject(error); return; }
      const deadline = setTimeout(() => controller.abort('deadline'), 20 * 60_000);
      const input = state.messages.slice(-20).map(item => ({ role: item.role, content: item.content }));
      try {
        // Native SDKs spread their ABI across many headers and examples. Keep
        // the existing context/time bounds while allowing enough read rounds.
        for (let round = 0; round < 32; round++) {
          if (controller.signal.aborted) throw problem('任务已取消。');
          if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw problem('本轮上下文超过 1 MiB，请缩小 SDK 资料范围。');
          const response = await requestModel({ settings, input, instructions: AGENT_INSTRUCTIONS, tools: AGENT_TOOLS, signal: controller.signal, fetchImpl });
          if (controller.signal.aborted) throw problem('任务已取消。');
          input.push(...response.output);
          const calls = response.output.filter(item => item.type === 'function_call');
          const answer = response.output.flatMap(item => (item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text)).join('\n').slice(0, 24000);
          if (answer) state.messages.push(message('assistant', answer));
          for (const call of calls) {
            if (controller.signal.aborted) throw problem('任务已取消。');
            let result;
            try { result = await executeTool(state, call, controller.signal); }
            catch (error) { result = { error: error.message }; }
            input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
            if (['write_draft_file', 'replace_draft_text'].includes(call.name) && !result?.error) {
              state.generation = { source: 'agent', task_id: state.task.id, model: settings.model,
                revision: state.draft.revision, updated_at: now() };
            }
            const toolArgs = (() => { try { return JSON.parse(call.arguments); } catch { return {}; } })();
            const fileLabel = ['read_sdk_file', 'read_draft_file', 'write_draft_file', 'replace_draft_text'].includes(call.name) && typeof toolArgs.path === 'string'
              ? ` · ${toolArgs.path.slice(0, 300)}` : '';
            state.task.events.push({ time: now(), message: `${call.name}${fileLabel}${result?.error ? `：${result.error}` : '：完成'}` });
            state.task.events = state.task.events.slice(-80); await save(state);
          }
          if (!calls.length) { state.task.status = 'completed'; break; }
          if (round === 31) throw problem('已达到本轮 32 次模型调用限制，草稿已保留，可以继续对话。');
        }
        state.status = state.draft.files.length ? 'draft' : 'imported';
      } catch (error) {
        const timedOut = controller.signal.aborted && controller.signal.reason === 'deadline';
        state.task.status = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed';
        state.task.error = timedOut ? '适配任务超过 20 分钟，已写入的草稿保留，可继续对话局部修复。'
          : controller.signal.aborted ? '任务已取消，已有草稿保留。' : error.message;
        state.error = state.task.error; state.status = state.draft.files.length ? 'draft' : 'error';
      } finally {
        clearTimeout(deadline); state.messages = state.messages.slice(-40);
        await save(state); running.delete(state.id);
      }
    })();
    // Prevent a disk failure in a background task from becoming an unhandled process exception.
    job.promise.catch(() => { running.delete(args.workspace_id); });
    return ready.promise;
  }
  async function cancel(args) {
    const job = running.get(args?.workspace_id);
    if (job?.controller) job.controller.abort('user');
    if (job?.promise) await job.promise;
    return publicState(await load(args.workspace_id));
  }
  async function testAdapter(args) {
    const id = args?.workspace_id, job = reserve(id);
    job.promise = (async () => {
      const state = await load(id);
      state.status = 'testing'; state.error = null; state.test = null; await save(state);
      const checks = []; let revision = '';
      try {
        await refreshDraft(state); revision = state.draft.revision;
        await inspectPackage(path.join(folder(state.id), 'draft'));
        checks.push({ name: '插件清单', passed: true, message: '数据流和配置字段符合 v1 接口。' });
        const probe = await probePackage(path.join(folder(state.id), 'draft'), { config: args.config ?? {}, timeoutMs: 10_000 });
        if (probe.passed === false || probe.ok === false || probe.details?.ok === false) throw problem(probe.error || probe.message || probe.details?.message || 'SDK 接口探测失败。');
        checks.push({ name: '隔离进程接口测试', passed: true, message: probe.probe_ran ? '适配器已加载并执行 probe，未启动采集。' : '适配器接口可加载；未提供 probe，厂商依赖尚未验证。' });
        if (typeof probe.details?.message === 'string') checks.push({ name: 'SDK 自检说明', passed: true, message: probe.details.message.slice(0, 2000) });
        await refreshDraft(state);
        if (revision !== state.draft.revision) throw problem('测试期间 SDK 或草稿发生变化，请检查后重新测试。');
        state.test = { passed: true, revision, checks, tested_at: now(), hardware_verified: false };
        state.status = 'tested';
      } catch (error) {
        checks.push({ name: '适配器测试', passed: false, message: error.message });
        state.test = { passed: false, revision, checks, tested_at: now(), hardware_verified: false };
        state.status = 'draft'; state.error = error.message;
      }
      await save(state); return publicState(state);
    })();
    try { return await job.promise; } finally { running.delete(id); }
  }
  async function install(args) {
    if (installation) throw problem('另一个插件正在安装。', 409);
    const id = args?.workspace_id, job = reserve(id);
    const operation = (async () => {
      const state = await load(id);
      const tree = await refreshDraft(state);
      if (!state.test?.passed || state.test.revision !== state.draft.revision) throw problem('请先测试当前版本的草稿；修改后必须重新测试。', 409);
      const { manifest } = await inspectPackage(path.join(folder(state.id), 'draft'));
      const stage = path.join(packages, `.staging-${randomUUID()}`), destination = path.join(packages, manifest.id);
      await checkDiskSpace(packages, tree.bytes + 4096);
      try {
      await copySdkTree(path.join(folder(state.id), 'draft'), stage, tree.files);
      await inspectPackage(stage);
      await atomicJson(path.join(stage, '.installation.json'), { workspace_id: state.id, revision: state.draft.revision, installed_at: now(), hardware_verified: false, generation: state.generation ?? null });
      const historyRoot = path.join(packages, '.history', manifest.id);
      await mkdir(historyRoot, { recursive: true });
      const backup = path.join(historyRoot, `${Date.now()}-${randomUUID()}`); let hadPrevious = false;
      try { await lstat(destination); hadPrevious = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (hadPrevious) await rename(destination, backup);
      try { await rename(stage, destination); }
      catch (error) { if (hadPrevious) await rename(backup, destination); throw error; }
      try { await onInstalled?.({ plugin_id: manifest.id }); }
      catch (error) {
        // Preserve the failed candidate for inspection, and restore the previous working package.
        await rename(destination, `${stage}-rejected`);
        if (hadPrevious) await rename(backup, destination);
        throw error;
      }
      state.installed = { plugin_id: manifest.id, name: manifest.name, version: manifest.version, revision: state.draft.revision, installed_at: now(), hardware_verified: false };
      state.status = 'installed'; state.error = null; return save(state);
      } catch (error) {
        await removeOwnedStage(packages, stage, '.staging-');
        if (error.code === 'ENOSPC') throw problem('目标磁盘空间不足，插件未完整安装，请释放空间后重新安装。');
        throw error;
      }
    })();
    installation = operation; job.promise = operation;
    try { return await operation; } finally { installation = null; running.delete(id); }
  }
  async function list() {
    const values = [];
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !WORKSPACE_ID.test(entry.name)) continue;
      try { values.push(summary(await load(entry.name))); } catch { /* Isolate a damaged draft from other SDKs. */ }
    }
    return { workspaces: values.sort((a, b) => b.updated_at.localeCompare(a.updated_at)) };
  }
  async function close() {
    closed = true;
    const importJob = importing;
    importJob?.controller.abort('shutdown');
    for (const job of running.values()) job.controller?.abort('shutdown');
    await Promise.allSettled([...running.values()].map(job => job.promise).filter(Boolean));
    if (importJob) await importJob.promise.catch(() => {});
    if (installation) await installation.catch(() => {});
  }
  return { list, status: async args => publicState(await load(args?.workspace_id)), importDirectory, importFiles,
    readDraft, writeDraft, chat, cancel, test: testAdapter, install, close,
    waitForIdle: async id => { await running.get(id)?.promise; return publicState(await load(id)); } };
}
