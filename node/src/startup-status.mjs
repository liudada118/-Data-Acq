import path from 'node:path';
import { realpath } from 'node:fs/promises';

async function directoryKey(value) {
  const resolved = await realpath(value).catch(() => path.resolve(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Explain a CLI bind failure without adopting or changing an existing service. */
export async function startupStatus(error, { port, dataDir, timeoutMs = 1500 } = {}) {
  if (error?.code !== 'EADDRINUSE') {
    return { exitCode: 1, reused: false, message: `启动失败：${error?.message || '服务无法启动。'}` };
  }
  const url = `http://127.0.0.1:${port}`;
  const conflict = message => ({ exitCode: 1, reused: false, url,
    message: `启动失败：端口 ${port} 已被占用，${message}\n现有服务未被停止；请检查占用程序或为新实例设置其他 PORT。` });
  let health;
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return conflict('健康接口未正常响应。');
    health = await response.json();
  } catch {
    return conflict('无法确认现有服务的身份和状态。');
  }
  if (health?.service !== 'synapse-node' || typeof health.data_dir !== 'string' || !path.isAbsolute(health.data_dir)) {
    return conflict('该端口未返回可识别的 Synapse 采集服务。');
  }
  if (await directoryKey(health.data_dir) !== await directoryKey(dataDir)) {
    return conflict(`现有采集服务使用其他数据目录。\n当前目录：${dataDir}\n现有目录：${health.data_dir}`);
  }
  if (health.engine_alive !== true) {
    return conflict('同目录采集服务的引擎当前不可用，请检查现有服务日志。');
  }
  return { exitCode: 0, reused: true, url,
    message: `Synapse Node 采集工作站已在运行：${url}\n数据目录：${dataDir}\n本次启动已退出，现有服务和录制继续运行。` };
}
