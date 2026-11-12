import { parentPort, workerData } from 'node:worker_threads';
import { inspectRecoverySession } from './recovery.mjs';

try { parentPort.postMessage({ report: await inspectRecoverySession(workerData) }); }
catch (error) { parentPort.postMessage({ error: error.message, statusCode: error.statusCode ?? 400 }); }
