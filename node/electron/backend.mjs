import { createApplication } from '../src/server.mjs';

if (!process.send) throw new Error('Desktop backend requires its owning process IPC channel');

let application;
let initializing;
let closing;

/** Send lifecycle acknowledgements before releasing the owning IPC channel. */
function notify(message) {
  return new Promise(resolve => {
    if (!process.connected) return resolve();
    process.send(message, () => resolve());
  });
}

/** Drain media, capture, annotations and exports once, including parent loss. */
function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    let error;
    try {
      await initializing;
      await application?.close();
    } catch (cause) { error = cause; }
    await notify({ type: 'closed', ok: !error, ...(error ? { error: error.message } : {}) });
    process.exitCode = error ? 1 : process.exitCode ?? 0;
    if (process.connected) process.disconnect();
    // The application has finished its explicit drain, including exports and
    // capture child exit, and the IPC acknowledgement has been flushed. A library
    // timer/native handle left over after cleanup must not strand the desktop.
    process.exit(process.exitCode);
  })();
  return closing;
}

/** The parent supplies paths explicitly; working-directory defaults are never used. */
function initialize(config) {
  if (initializing || closing) return;
  initializing = (async () => {
    if (!config || !['dataDir', 'outputDir', 'webDir'].every(key => typeof config[key] === 'string') ||
        !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid desktop backend configuration');
    application = await createApplication({ port: config.port, dataDir: config.dataDir,
      outputDir: config.outputDir, webDir: config.webDir, ...(config.sdkPath === false ? { sdkPath: false } : {}) });
  })();
  initializing.then(async () => {
    if (!closing) await notify({ type: 'ready', url: application.url, dataDir: config.dataDir });
  }, async error => {
    process.exitCode = 1;
    await notify({ type: 'startup-error', error: error.message, code: error.code });
    void shutdown();
  });
}

process.on('message', message => {
  if (message?.type === 'initialize') initialize(message.config);
  else if (message?.type === 'stop') void shutdown();
});
process.on('disconnect', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
