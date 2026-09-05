'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const url = require('url');

const { detectMedia } = require('./detectMedia');
const { prepareSource } = require('./isoZip');
const { classify } = require('./classify');
const { readStudyInfo } = require('./dicomInfo');
const { stageFiles } = require('./copyStage');
const { sendStoreScu } = require('./sendStoreScu');
const { cleanup } = require('./cleanup');

let mainWindow = null;
let splashWindow = null;
let mainRevealed = false;

function fileUrl(relFromMain) {
  return url.format({
    pathname: path.join(__dirname, relFromMain),
    protocol: 'file:',
    slashes: true,
  });
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 520,
    height: 560,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'splashPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadURL(fileUrl('../renderer/splash.html'));

  splashWindow.on('closed', () => {
    splashWindow = null;
    // splash chiusa senza premere "Import": non c'è nulla da mostrare
    if (!mainRevealed) app.quit();
  });
}

// Chiude la splash e mostra la finestra principale. Chiamata solo su "Import".
function revealMain() {
  if (mainRevealed) return;
  mainRevealed = true;
  if (mainWindow) mainWindow.show();
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

function createMain() {
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.on('splash-confirm', () => revealMain());

// ---------------------------------------------------------------- IPC

ipcMain.handle('detect-media', () => detectMedia());

ipcMain.handle('prepare-source', (_e, drive) => prepareSource(drive));

ipcMain.handle('classify', (_e, sourcePath) => {
  const plan = classify(sourcePath);
  let study = null;
  try {
    study = readStudyInfo(plan.dataRoot, plan);
  } catch {
    study = null;
  }
  return { ...plan, study };
});

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

ipcMain.handle('cleanup', async (_e, opts) => {
  const emitProgress = (d) => mainWindow && mainWindow.webContents.send('progress', d);
  emitProgress({ phase: 'cleanup', state: 'start' });
  const result = await cleanup(opts || {});
  emitProgress({ phase: 'cleanup', state: 'done', result });
  return result;
});

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
