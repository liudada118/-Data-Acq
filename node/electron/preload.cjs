const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('synapseDesktop', {
  integration: {
    invoke: (action, args) => ipcRenderer.invoke('integration:invoke', action, args),
    chooseSdkDirectory: () => ipcRenderer.invoke('integration:choose-sdk'),
    modelSettings: {
      get: () => ipcRenderer.invoke('integration:settings:get'),
      catalog: options => ipcRenderer.invoke('integration:settings:catalog', options),
      save: input => ipcRenderer.invoke('integration:settings:save', input),
    },
  },
  onBeforeClose(handler) {
    const listener = async (_event, request) => {
      if (typeof request?.id !== 'string') return;
      try {
        const result = await handler();
        ipcRenderer.send('desktop:close-result', { id: request.id, ok: result?.ok === true,
          message: typeof result?.message === 'string' ? result.message.slice(0, 1000) : '' });
      } catch {
        ipcRenderer.send('desktop:close-result', { id: request.id, ok: false, message: '保存录制时发生异常，请在页面停止并保存后再退出。' });
      }
    };
    ipcRenderer.on('desktop:prepare-close', listener);
    ipcRenderer.send('desktop:renderer-ready');
    return () => ipcRenderer.removeListener('desktop:prepare-close', listener);
  },
});
