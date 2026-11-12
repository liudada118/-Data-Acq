import { parentPort, workerData } from 'node:worker_threads';
import { exportSession } from './exporter.mjs';

try {
  await exportSession(workerData, progress => parentPort.postMessage({ progress }));
  parentPort.postMessage({ complete: true });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
