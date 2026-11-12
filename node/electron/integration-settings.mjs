import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function validateModelSettings(value) {
  if (!value || typeof value !== 'object') throw new Error('模型配置无效。');
  let url;
  try { url = new URL(value.baseUrl); } catch { throw new Error('请输入有效的模型服务地址。'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash)
    throw new Error('模型服务需要 HTTPS，本机服务可使用 HTTP；地址不能包含密钥或查询参数。');
  if (url.href.length > 1000) throw new Error('模型服务地址过长。');
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 120 || /[\x00-\x1f]/.test(value.model)) throw new Error('请输入模型名称。');
  if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 4096 || /[\x00-\x1f]/.test(value.apiKey))) throw new Error('密钥格式无效。');
  return { baseUrl: url.href.replace(/\/+$/, ''), model: value.model.trim(), apiKey: value.apiKey?.trim() };
}

/** Credentials belong to this application; never import another product's settings. */
export function createModelSettingsStore({ filename, safeStorage }) {
  async function read() {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('无法读取模型配置，请重新保存。'); }
  }
  const publicValue = value => ({ baseUrl: value.baseUrl ?? '', model: value.model ?? '', hasKey: !!value.encryptedKey });
  return {
    async get() { return publicValue(await read()); },
    async privateValue() {
      const value = await read();
      if (!value.baseUrl || !value.model) throw new Error('请先配置模型服务地址和模型。');
      return { ...validateModelSettings(value), apiKey: value.encryptedKey ? safeStorage.decryptString(Buffer.from(value.encryptedKey, 'base64')) : '' };
    },
    async save(input) {
      const clean = validateModelSettings(input), old = await read();
      if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new Error('清除密钥选项无效。');
      if (!clean.apiKey && old.encryptedKey && old.baseUrl !== clean.baseUrl && input.clearApiKey !== true)
        throw new Error('更换模型服务地址时请重新输入密钥，避免把旧密钥发送到新服务。');
      let encryptedKey = input.clearApiKey === true ? undefined : old.encryptedKey;
      if (clean.apiKey) {
        if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text')
          throw new Error('系统安全存储不可用，未保存密钥。');
        encryptedKey = safeStorage.encryptString(clean.apiKey).toString('base64');
      }
      const next = { baseUrl: clean.baseUrl, model: clean.model, encryptedKey };
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(`${filename}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(`${filename}.tmp`, filename);
      return publicValue(next);
    },
  };
}
