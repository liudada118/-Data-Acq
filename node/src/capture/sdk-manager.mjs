import { SdkController } from './sdk.mjs';
import { activateSdkLicense } from './license.mjs';

const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const SAFE_INSTANCE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const MAX_INSTANCES = 8;

function portIdentity(port) {
  const com = /^(?:\\\\\.\\)?com(\d+)$/i.exec(port ?? '');
  return com ? `com:${com[1].replace(/^0+(?=\d)/, '')}` : port;
}

function instanceId(options) {
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw failure('SDK 请求必须是对象。');
  const id = options?.instance_id === undefined ? 'default' : options.instance_id;
  if (typeof id !== 'string' || !SAFE_INSTANCE.test(id)) throw failure('instance_id 必须为 1–48 位小写字母、数字、下划线或连字符，并以字母或数字开头。');
  return id;
}

/** Independent card connections, sharing only the SDK module's process-wide license. */
export class SdkManager {
  constructor({ sdkPath, origin, onBatch, onError }) {
    this.options = { sdkPath, origin, onBatch };
    this.onError = onError;
    this.controllers = new Map();
    this.connecting = new Set();
    this.portsInUse = new Map();
    this.activating = null;
    this.create('default');
  }
  create(id) {
    const controller = new SdkController({
      ...this.options, instanceId: id,
      ensureLicense: Shroom => this.ensureLicense(Shroom),
      onError: error => this.onError(error, { instance_id: id, stream_ids: [controller.pressureId, controller.imuId] }),
    });
    this.controllers.set(id, controller);
    return controller;
  }
  async init() { await this.controllers.get('default').init(); }
  async ensureLicense(Shroom) {
    // Re-activation replaces global SDK authorization and closes existing devices.
    // Reuse only an explicitly valid public status; expired/invalid licenses still activate normally.
    if (typeof Shroom.getLicenseStatus === 'function' && Shroom.getLicenseStatus()?.valid === true) return;
    if (!this.activating) this.activating = activateSdkLicense(Shroom).finally(() => { this.activating = null; });
    await this.activating;
  }
  info() {
    return { ...this.controllers.get('default').info(), instances: [...this.controllers.values()].map(controller => controller.info()), instance_limit: MAX_INSTANCES };
  }
  descriptors() { return [...this.controllers.values()].flatMap(controller => controller.descriptors()); }
  get previews() { return Object.assign({}, ...[...this.controllers.values()].map(controller => controller.previews)); }
  get connected() { return [...this.controllers.values()].some(controller => controller.state.connected); }
  ports() { return this.controllers.get('default').ports(); }
  async connect(options) {
    const id = instanceId(options);
    const existing = this.controllers.get(id);
    if (existing?.device || this.connecting.has(id)) throw failure('该采集卡片已连接，请先断开。', 409);
    const count = [...this.controllers.entries()].filter(([key, controller]) => controller.device || this.connecting.has(key)).length;
    if (count >= MAX_INSTANCES) throw failure('最多同时连接 8 个 SDK 实例，请先断开其他卡片。', 409);
    const simulated = options?.mode === 'mock' || options?.product === 'mock';
    const port = !simulated && typeof options?.path === 'string' ? options.path.trim() : null;
    const portKey = portIdentity(port);
    if (portKey && this.portsInUse.has(portKey)) throw failure('此串口已被其他采集卡片占用，请选择另一个串口。', 409);
    const controller = existing ?? this.create(id);
    this.connecting.add(id);
    if (portKey) this.portsInUse.set(portKey, id);
    try {
      if (!existing) await controller.init();
      return await controller.connect({ ...options, ...(port ? { path: port } : {}) });
    } catch (error) {
      if (!controller.device) {
        if (portKey) this.portsInUse.delete(portKey);
        if (id !== 'default') this.controllers.delete(id);
      }
      throw error;
    } finally { this.connecting.delete(id); }
  }
  async disconnect(options) {
    const id = instanceId(options);
    const controller = this.controllers.get(id);
    if (!controller) throw failure('SDK 实例不存在。', 404);
    const result = await controller.disconnect();
    for (const [port, owner] of this.portsInUse) if (owner === id) this.portsInUse.delete(port);
    if (id !== 'default') this.controllers.delete(id);
    return result;
  }
  async close() {
    const controllers = [...this.controllers.values()];
    const results = await Promise.allSettled(controllers.map(controller => this.disconnect({ instance_id: controller.instanceId })));
    const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ controller: controllers[index], error: result.reason }] : []);
    if (failures.length) throw Object.assign(new Error(failures[0].error.message), {
      stream_ids: failures.flatMap(({ controller }) => [controller.pressureId, controller.imuId]),
    });
  }
}
