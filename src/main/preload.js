'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  detectMedia: () => ipcRenderer.invoke('detect-media'),
  prepareSource: (drive) => ipcRenderer.invoke('prepare-source', drive),
  classify: (sourcePath) => ipcRenderer.invoke('classify', sourcePath),
  previewImage: (absPath) => ipcRenderer.invoke('preview-image', absPath),
  runImport: (payload) => ipcRenderer.invoke('run-import', payload),
  cleanup: (opts) => ipcRenderer.invoke('cleanup', opts),

  onProgress: (cb) => subscribe('progress', cb),
  onLog: (cb) => subscribe('log', cb),
});
