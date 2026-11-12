import { net } from 'electron';
import { createIntegrationService } from '../src/integration/service.mjs';

const parent = process.parentPort;
if (!parent) throw new Error('SDK Agent requires its desktop owner');
let servicePromise;
const allowed = new Set(['list', 'status', 'importDirectory', 'importFiles', 'chat', 'cancel', 'test', 'install', 'readDraft', 'writeDraft']);
parent.on('message', async ({ data }) => {
  const { id, action, args, modelConfig } = data ?? {};
  try {
    if (action === 'initialize') {
      servicePromise ??= createIntegrationService({ ...args, fetchImpl: (...values) => net.fetch(...values) });
      await servicePromise;
      parent.postMessage({ id, result: { ready: true } });
      return;
    }
    const service = await servicePromise;
    if (!service) throw new Error('SDK Agent 尚未初始化。');
    if (action === 'close') {
      await service.close();
      parent.postMessage({ id, result: { closed: true } });
      process.exit(0);
    }
    if (!allowed.has(action)) throw new Error('不支持的 Agent 操作。');
    const result = await service[action](args, modelConfig);
    parent.postMessage({ id, result });
  } catch (error) {
    parent.postMessage({ id, error: { message: String(error.message).slice(0, 2000) } });
  }
});
