'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { detectMedia } = require('./detectMedia');
const { prepareSource } = require('./isoZip');
const { classify } = require('./classify');
const { readStudyInfo } = require('./dicomInfo');
const { decode: decodePixels } = require('./dicomPixels');
const { stageFiles } = require('./copyStage');
const { sendStoreScu } = require('./sendStoreScu');
const { cleanup } = require('./cleanup');

const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');

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
  const opts = {
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
  };
  if (fs.existsSync(APP_ICON)) opts.icon = APP_ICON;
  splashWindow = new BrowserWindow(opts);
  splashWindow.loadURL(fileUrl('../renderer/splash.html'));

  splashWindow.on('closed', () => {
    splashWindow = null;
    // splash chiusa senza premere "Import": non c'è nulla da mostrare
    if (!mainRevealed) app.quit();
  });
}

// Chiude la splash e mostra la finestra principale in dissolvenza. Solo su "Import".
function revealMain() {
  if (mainRevealed) return;
  mainRevealed = true;

  if (mainWindow) {
    mainWindow.setOpacity(0);
    mainWindow.show();
    let o = 0;
    const timer = setInterval(() => {
      o = Math.min(1, o + 0.1);
      mainWindow.setOpacity(o);
      if (o >= 1) {
        clearInterval(timer);
        mainWindow.setOpacity(1);
      }
    }, 24);
  }

  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

function createMain() {
  const opts = {
    width: 1160,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4fbfa',
    title: 'DICOM Import Tool',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (fs.existsSync(APP_ICON)) opts.icon = APP_ICON;

  mainWindow = new BrowserWindow(opts);

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

ipcMain.handle('preview-image', (_e, absPath) => {
  if (!absPath || typeof absPath !== 'string') return { unsupported: 'no-path' };
  const r = decodePixels(absPath);
  // trasferisci i pixel come ArrayBuffer (niente copia JSON enorme)
  if (r.gray) r.gray = r.gray.buffer.slice(r.gray.byteOffset, r.gray.byteOffset + r.gray.byteLength);
  if (r.rgb) r.rgb = r.rgb.buffer.slice(r.rgb.byteOffset, r.rgb.byteOffset + r.rgb.byteLength);
  return r;
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
