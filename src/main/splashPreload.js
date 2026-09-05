'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  confirm: () => ipcRenderer.send('splash-confirm'),
});
