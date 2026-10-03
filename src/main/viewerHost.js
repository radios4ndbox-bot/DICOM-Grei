'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');
const { BrowserWindow, ipcMain } = require('electron');
const { Worker } = require('worker_threads');

const archive = require('./archive');

/**
 * Finestra del viewer e i suoi canali.
 *
 * Come per la finestra principale, il renderer non riceve né manda percorsi:
 * chiede "esame X, file 000012.dcm, fotogramma 0" e il main ricostruisce il
 * percorso dentro l'archivio (archive.filePath controlla la forma di entrambi).
 */

const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');
// Due decodifiche insieme: quella che il medico sta guardando non resta in
// coda dietro al precaricamento delle fette vicine.
const WORKERS = 2;

let win = null;
let workers = [];
let nextWorker = 0;
let seq = 0;
const pending = new Map(); // id richiesta -> { resolve, worker }

function startWorkers() {
  if (workers.length) return;
  for (let i = 0; i < WORKERS; i++) {
    const w = new Worker(path.join(__dirname, 'viewerWorker.js'));
    w.on('message', (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      p.resolve(m.result);
    });
    // un worker caduto non deve lasciare richieste appese per sempre
    const fail = (why) => {
      for (const [id, p] of pending) {
        if (p.worker === w) {
          pending.delete(id);
          p.resolve({ error: 'decodifica', message: why });
        }
      }
    };
    w.on('error', (err) => fail(String((err && err.message) || err)));
    w.on('exit', () => {
      fail('worker terminato');
      workers = workers.filter((x) => x !== w);
    });
    workers.push(w);
  }
}

function stopWorkers() {
  for (const w of workers) w.terminate().catch(() => {});
  workers = [];
  for (const p of pending.values()) p.resolve({ error: 'decodifica', message: 'viewer chiuso' });
  pending.clear();
}

function decode(file, frame) {
  startWorkers();
  return new Promise((resolve) => {
    const w = workers[nextWorker++ % workers.length];
    const id = ++seq;
    pending.set(id, { resolve, worker: w });
    w.postMessage({ id, file, frame });
  });
}

function open(examId) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (examId) win.webContents.send('viewer-open-exam', examId);
    return win;
  }

  const opts = {
    width: 1500,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0e1418',
    title: 'DICOM Grei — Archivio',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'viewerPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (fs.existsSync(APP_ICON)) opts.icon = APP_ICON;
  win = new BrowserWindow(opts);
  win.removeMenu();
  win.loadURL(
    url.format({ pathname: path.join(__dirname, '../renderer/viewer.html'), protocol: 'file:', slashes: true })
  );
  win.once('ready-to-show', () => win.show());
  win.webContents.once('did-finish-load', () => {
    if (examId && win && !win.isDestroyed()) win.webContents.send('viewer-open-exam', examId);
  });
  win.on('closed', () => {
    win = null;
    stopWorkers(); // i moduli wasm e i buffer dei codec non restano in memoria
  });
  return win;
}

function close() {
  if (win && !win.isDestroyed()) win.close();
}

function register() {
  ipcMain.handle('archive-list', () => archive.list());

  ipcMain.handle('archive-index', (_e, id) => archive.readIndex(String(id)));

  ipcMain.handle('archive-frame', async (_e, req) => {
    const r = req || {};
    const frame = Number.isInteger(r.fr) && r.fr >= 0 ? r.fr : 0;
    let file;
    try {
      file = archive.filePath(String(r.id), String(r.f));
    } catch (err) {
      return { error: 'richiesta', message: err.message };
    }
    return decode(file, frame);
  });

  ipcMain.handle('archive-delete', async (_e, id) => {
    await archive.remove(String(id));
    return { ok: true };
  });

  ipcMain.handle('viewer-open', (_e, id) => {
    open(typeof id === 'string' ? id : null);
    return { ok: true };
  });

  ipcMain.handle('viewer-fullscreen', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    w.setFullScreen(!w.isFullScreen());
    return w.isFullScreen();
  });
}

module.exports = { open, close, register, window: () => win };
