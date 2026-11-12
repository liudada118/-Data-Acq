import { parentPort, workerData } from 'node:worker_threads';
import { ReplayReader } from './reader.mjs';

const reader = new ReplayReader(workerData);
parentPort.postMessage({ ready: true });
let queue = Promise.resolve();
parentPort.on('message', message => {
  queue = queue.then(async () => {
    try { parentPort.postMessage({ id: message.id, result: await reader.frame(message.sessionId, message.timeSeconds) }); }
    catch (error) { parentPort.postMessage({ id: message.id, error: error.message, statusCode: error.statusCode ?? 400 }); }
  });
});
