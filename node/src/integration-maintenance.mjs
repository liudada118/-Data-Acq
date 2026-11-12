import { randomUUID } from 'node:crypto';

/** Short lease keeps a package test/swap mutually exclusive with acquisition starts. */
export function createIntegrationMaintenance({ now = Date.now, ttlMs = 240000 } = {}) {
  let lease;
  const current = () => { if (lease && lease.expires <= now()) lease = undefined; return lease; };
  const fail = message => { throw Object.assign(new Error(message), { statusCode: 409 }); };
  return {
    assertAvailable(token) {
      if (current() && token !== lease.token) fail('SDK 正在测试或安装，请完成后再开始采集或连接设备。');
    },
    acquire(status, catalog) {
      if (current()) fail('已有 SDK 测试或安装正在进行。');
      if (!status.engine_alive || status.state !== 'idle' || status.session_id) fail('请先停止并保存录制，再测试或安装 SDK。');
      if ((catalog.instances ?? []).some(instance => instance.connected)) fail('请先断开已连接的扩展传感器，再测试或安装 SDK。');
      lease = { token: randomUUID(), expires: now() + ttlMs };
      return { token: lease.token };
    },
    release(token) {
      if (current() && token !== lease.token) fail('SDK 维护任务不匹配。');
      lease = undefined;
      return { released: true };
    },
    renew(token) {
      if (!current() || token !== lease.token) fail('SDK 维护任务已失效。');
      lease.expires = now() + ttlMs;
      return { renewed: true };
    },
  };
}
