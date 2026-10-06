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
  // mode: 'single' (una sola associazione, come da cmd) | 'normal' | 'turbo'
  //       | 'archive' (niente PACS: l'esame resta solo nell'archivio locale)
  //       | 'archive' (niente PACS: l'esame resta solo nell'archivio locale)
  runImport: (type, mode) => ipcRenderer.invoke('run-import', { type: type || '', mode: mode || 'single' }),
  // riga di comando dell'ultimo invio, negli appunti: serve a rilanciarla identica da cmd
  copyCommand: () => ipcRenderer.invoke('copy-command'),
  stopImport: () => ipcRenderer.invoke('stop-import'),
  cleanup: () => ipcRenderer.invoke('cleanup'),

  // Archivio locale: «conserva» salva lo staging dell'ultima importazione (il
  // main sa qual è), «apri» mostra il viewer, eventualmente su un esame.
  archiveCurrent: () => ipcRenderer.invoke('archive-current'),
  archiveCount: () => ipcRenderer.invoke('archive-count'),
  openViewer: (id) => ipcRenderer.invoke('viewer-open', id || null),
  onArchiveChanged: (cb) => subscribe('archive-changed', cb),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (values) => ipcRenderer.invoke('save-settings', values),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),

  onProgress: (cb) => subscribe('progress', cb),
  onLog: (cb) => subscribe('log', cb),
  onPacsChanged: (cb) => subscribe('pacs-changed', cb),
  // riquadri dell'anteprima: arrivano dal main mentre la copia è in corso
  onPreview: (cb) => subscribe('preview', cb),
});
