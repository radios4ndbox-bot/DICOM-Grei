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
  // Il main tiene lo stato autorevole (sorgente preparata, piano di
  // classificazione). Qui passano solo scelte dell'utente, mai percorsi.
  classify: () => ipcRenderer.invoke('classify'),
  previewImage: (absPath) => ipcRenderer.invoke('preview-image', absPath),
  runImport: (type) => ipcRenderer.invoke('run-import', { type: type || '' }),
  cleanup: () => ipcRenderer.invoke('cleanup'),

  onProgress: (cb) => subscribe('progress', cb),
  onLog: (cb) => subscribe('log', cb),
});
