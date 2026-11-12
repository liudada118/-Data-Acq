import { parentPort, workerData } from 'node:worker_threads';
import { scanContinuity } from './reader.mjs';

try {
  const report = await scanContinuity({ ...workerData, onProgress: progress => parentPort.postMessage({ progress }) });
  parentPort.postMessage({ report });
} catch (error) {
  parentPort.postMessage({ error: error.message, statusCode: error.statusCode ?? 500 });
}
