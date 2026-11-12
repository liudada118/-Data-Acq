import { fileURLToPath } from 'node:url';
import { createApplication } from '../src/server.mjs';

// Keep the existing capture service and its data available during the upgrade.
// This entry point changes neither .env.local nor any running process.
const app = await createApplication({
  port: Number(process.env.ANNOTATION_PORT ?? 8788),
  dataDir: fileURLToPath(new URL('../data/annotations/sessions/', import.meta.url)),
  outputDir: fileURLToPath(new URL('../data/annotations/exports/', import.meta.url)),
});
console.log(`Synapse 标签与回放工作站：${app.url}`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try { await app.close(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
