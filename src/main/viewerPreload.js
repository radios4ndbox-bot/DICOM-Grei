'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Il viewer chiede esami e fotogrammi per identificativo: nessun percorso
// attraversa questo ponte, in nessuna direzione.
contextBridge.exposeInMainWorld('archive', {
  list: () => ipcRenderer.invoke('archive-list'),
  index: (id) => ipcRenderer.invoke('archive-index', id),
  frame: (id, f, fr) => ipcRenderer.invoke('archive-frame', { id, f, fr }),
  remove: (id) => ipcRenderer.invoke('archive-delete', id),
  fullscreen: () => ipcRenderer.invoke('viewer-fullscreen'),
  onChanged: (cb) => subscribe('archive-changed', cb),
  onOpenExam: (cb) => subscribe('viewer-open-exam', cb),
});
