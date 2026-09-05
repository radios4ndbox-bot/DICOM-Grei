'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const url = require('url');

const { detectMedia } = require('./detectMedia');
const { prepareSource } = require('./isoZip');
const { classify } = require('./classify');
const { stageFiles } = require('./copyStage');
const { sendStoreScu } = require('./sendStoreScu');
const { cleanup } = require('./cleanup');

const SPLASH_MIN_MS = 4200;

let mainWindow = null;
let splashWindow = null;

function fileUrl(relFromMain) {
  return url.format({
    pathname: path.join(__dirname, relFromMain),
    protocol: 'file:',
    slashes: true,
  });
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 480,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadURL(fileUrl('../renderer/splash.html'));
}

function createMain() {
  const shownAt = Date.now();

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#f4fbfa',
    title: 'DICOM Import Tool',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadURL(fileUrl('../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - shownAt));
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
      splashWindow = null;
      mainWindow.show();
    }, wait);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('detect-media', () => detectMedia());

ipcMain.handle('prepare-source', (_e, drive) => prepareSource(drive));

ipcMain.handle('classify', (_e, sourcePath) => classify(sourcePath));

ipcMain.handle('run-import', async (_e, { plan, iso }) => {
  const emitProgress = (d) => mainWindow && mainWindow.webContents.send('progress', d);
  const emitLog = (line) => mainWindow && mainWindow.webContents.send('log', line);

  const copy = await stageFiles(plan, emitProgress);

  if (copy.copied === 0) {
    return { copy, send: null, iso: iso || null, error: 'Nessun file copiato in staging: invio annullato.' };
  }

  const send = await sendStoreScu(plan.pattern, copy.copied, (ev) => {
    if (ev.type === 'log') emitLog(ev.line);
    else if (ev.type === 'progress') emitProgress(ev.data);
  });

  return { copy, send, iso: iso || null };
});

ipcMain.handle('cleanup', (_e, opts) => cleanup(opts || {}));

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  createSplash();
  createMain();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplash();
      createMain();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
