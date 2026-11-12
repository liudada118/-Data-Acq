import { open, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DEVICE_ID = /^[a-f0-9]{64}$/;
const MAX_KEY_CHARACTERS = 16384;
const MAX_TEXT_FILE_BYTES = 64 * 1024;
const ACTIVATION_MESSAGES = {
  INVALID_CONFIG: 'SDK 授权参数无效，请检查授权模式、服务地址与安装标识。',
  LICENSE_REQUIRED: '尚未配置 SDK 授权，请设置 SHROOM_LICENSE_KEY 或 SHROOM_LICENSE_FILE。',
  LICENSE_INVALID: 'SDK 授权无效，请检查许可证内容及离线公钥。',
  LICENSE_EXPIRED: 'SDK 授权已过期，请续期后重新连接。',
  LICENSE_UNAVAILABLE: 'SDK 授权服务不可用，请检查网络和授权服务配置。',
  LICENSE_REJECTED: 'SDK 授权未通过，请检查许可证和设备名额。',
  LICENSE_PRODUCT_MISMATCH: '许可证不属于 Shroom SDK 产品。',
  LICENSE_SCOPE_DENIED: 'SDK 授权不包含所需范围。',
  LICENSE_FEATURE_DENIED: 'SDK 授权不包含所需设备采集功能。',
  LICENSE_DEVICE_REQUIRED: 'SDK 授权需要有效的稳定安装标识。',
};

function failure(code, message) {
  return Object.assign(new Error(message), { code, stage: 'license', statusCode: 422 });
}

function activationFailure(error) {
  const code = Object.hasOwn(ACTIVATION_MESSAGES, error?.code) ? error.code : 'LICENSE_REJECTED';
  // Do not forward SDK messages, causes, or details: any of them may contain a file-sourced key.
  return failure(code, ACTIVATION_MESSAGES[code]);
}

async function boundedText(filename, limit, description) {
  let handle;
  try {
    if (typeof filename !== 'string' || !filename.trim()) throw new Error('Missing filename');
    handle = await open(filename, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('File is not regular or is too large');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const read = await handle.read(bytes, length, limit + 1 - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > limit) throw new Error('File grew beyond limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).trim();
  } catch {
    throw failure('INVALID_CONFIG', `${description}无法读取、不是有效 UTF-8 文本或超过大小限制。`);
  } finally { await handle?.close().catch(() => {}); }
}

async function installationId(homeDir) {
  const directory = path.join(homeDir, '.shroom-sdk');
  const filename = path.join(directory, 'device-id');
  let handle;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      handle = await open(filename, 'wx', 0o600);
      await handle.writeFile(randomBytes(32).toString('hex'), 'utf8');
      await handle.close();
      handle = undefined;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // A competing process may have exclusively created the file but not finished its small write.
    for (let attempt = 0; attempt < 6; attempt++) {
      const value = await boundedText(filename, 256, 'SDK 安装标识文件');
      if (DEVICE_ID.test(value)) return value;
      if (value.length || attempt === 5) break;
      await delay(10);
    }
    throw failure('LICENSE_DEVICE_REQUIRED', '现有 SDK 安装标识无效；为避免产生新的设备激活记录，未覆盖该文件。');
  } catch (error) {
    if (error.stage === 'license') throw error;
    throw failure('LICENSE_DEVICE_REQUIRED', '无法读取或保存 SDK 稳定安装标识，请检查用户目录权限。');
  } finally { await handle?.close().catch(() => {}); }
}

/** Activate only through the SDK's public API; importing this module has no side effects. */
export async function activateSdkLicense(Shroom, { env = process.env, homeDir = homedir() } = {}) {
  if (typeof Shroom?.activateLicense !== 'function') throw failure('INVALID_CONFIG', '当前 SDK 未提供公开的 activateLicense 接口。');
  let key;
  if (env.SHROOM_LICENSE_KEY !== undefined) {
    if (typeof env.SHROOM_LICENSE_KEY !== 'string') throw failure('INVALID_CONFIG', 'SHROOM_LICENSE_KEY 必须是文本。');
    key = env.SHROOM_LICENSE_KEY.trim();
  } else if (env.SHROOM_LICENSE_FILE !== undefined) {
    key = await boundedText(env.SHROOM_LICENSE_FILE, MAX_TEXT_FILE_BYTES, 'SDK 授权文件');
  } else key = '';
  if (!key) throw failure('LICENSE_REQUIRED', ACTIVATION_MESSAGES.LICENSE_REQUIRED);
  if (key.length > MAX_KEY_CHARACTERS) throw failure('LICENSE_INVALID', 'SDK 许可证内容超过长度限制。');

  const mode = env.SHROOM_LICENSE_MODE ?? 'online';
  if (!['online', 'offline'].includes(mode)) throw failure('INVALID_CONFIG', 'SHROOM_LICENSE_MODE 必须是 online 或 offline。');
  const options = { mode };
  if (env.SHROOM_LICENSE_SERVER !== undefined) {
    if (typeof env.SHROOM_LICENSE_SERVER !== 'string' || !env.SHROOM_LICENSE_SERVER.trim()) throw failure('INVALID_CONFIG', 'SHROOM_LICENSE_SERVER 必须是有效服务地址。');
    options.serverUrl = env.SHROOM_LICENSE_SERVER.trim();
  }
  if (env.SHROOM_LICENSE_PUBLIC_KEY_FILE !== undefined) options.publicKey = await boundedText(env.SHROOM_LICENSE_PUBLIC_KEY_FILE, MAX_TEXT_FILE_BYTES, 'SDK 授权公钥文件');
  if (env.SHROOM_DEVICE_ID !== undefined) {
    if (typeof env.SHROOM_DEVICE_ID !== 'string' || !DEVICE_ID.test(env.SHROOM_DEVICE_ID)) throw failure('LICENSE_DEVICE_REQUIRED', 'SHROOM_DEVICE_ID 必须是 64 位小写十六进制稳定安装标识。');
    options.deviceId = env.SHROOM_DEVICE_ID;
  } else options.deviceId = await installationId(homeDir);

  let result;
  try { result = await Shroom.activateLicense(key, options); }
  catch (error) { throw activationFailure(error); }
  if (result?.valid !== true) throw activationFailure(result);
  return result;
}
