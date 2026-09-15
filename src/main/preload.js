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
  runImport: (type, turbo) => ipcRenderer.invoke('run-import', { type: type || '', turbo: !!turbo }),
  stopImport: () => ipcRenderer.invoke('stop-import'),
  cleanup: () => ipcRenderer.invoke('cleanup'),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (values) => ipcRenderer.invoke('save-settings', values),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),

  onProgress: (cb) => subscribe('progress', cb),
  onLog: (cb) => subscribe('log', cb),
  onPacsChanged: (cb) => subscribe('pacs-changed', cb),
});
