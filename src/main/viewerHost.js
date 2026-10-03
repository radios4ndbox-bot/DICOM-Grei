'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');
const { BrowserWindow, ipcMain, screen } = require('electron');
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

let win = null;            // il viewer con l'elenco degli esami: uno solo
const compares = new Set(); // finestre di confronto: quante se ne vuole
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

const VIEWER_URL = (hash) =>
  url.format({ pathname: path.join(__dirname, '../renderer/viewer.html'), protocol: 'file:', slashes: true, hash });

function createWindow(opts, hash, initial) {
  const w = new BrowserWindow({
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#0e1418',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'viewerPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...(fs.existsSync(APP_ICON) ? { icon: APP_ICON } : {}),
    ...opts,
  });
  w.removeMenu();
  w.loadURL(VIEWER_URL(hash));
  w.webContents.once('did-finish-load', () => {
    if (initial && !w.isDestroyed()) w.webContents.send('viewer-open-exam', initial);
  });
  w.on('closed', () => {
    if (w === win) win = null;
    compares.delete(w);
    // l'ultima finestra che si chiude spegne i worker: i moduli wasm e i
    // buffer dei codec non restano in memoria
    if (!win && compares.size === 0) stopWorkers();
  });
  return w;
}

function open(examId) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (examId) win.webContents.send('viewer-open-exam', examId);
    return win;
  }
  win = createWindow({ width: 1500, height: 920, minWidth: 1000, minHeight: 640, title: 'DICOM Grei — Archivio' }, '', examId || null);
  win.once('ready-to-show', () => win && win.show());
  return win;
}

/**
 * Dove mettere una finestra di confronto.
 *
 * Con più schermi: su uno schermo diverso da quello della finestra di
 * partenza, a tutto schermo, preferendo quelli senza un'altra finestra di
 * confronto e, fra questi, il più vicino. Con uno schermo solo: la metà
 * destra dell'area di lavoro, così le due finestre si affiancano.
 */
function placeCompare(from) {
  const displays = screen.getAllDisplays();
  const here = from && !from.isDestroyed() ? screen.getDisplayMatching(from.getBounds()) : screen.getPrimaryDisplay();
  const others = displays.filter((d) => d.id !== here.id);
  if (!others.length) {
    const a = here.workArea;
    const half = Math.floor(a.width / 2);
    return { bounds: { x: a.x + half, y: a.y, width: a.width - half, height: a.height }, maximize: false };
  }
  const taken = new Set(
    [...compares].filter((w) => !w.isDestroyed()).map((w) => screen.getDisplayMatching(w.getBounds()).id)
  );
  const dist = (d) => Math.abs(d.bounds.x + d.bounds.width / 2 - (here.bounds.x + here.bounds.width / 2));
  others.sort((p, q) => (taken.has(p.id) ? 1 : 0) - (taken.has(q.id) ? 1 : 0) || dist(p) - dist(q));
  return { bounds: others[0].workArea, maximize: true };
}

/**
 * Finestra di confronto: lo stesso viewer, senza l'elenco a lato, aperto
 * sull'immagine che si stava guardando. Ogni «Compara» ne apre una nuova.
 */
function openCompare(from, target) {
  const place = placeCompare(from);
  const w = createWindow({ ...place.bounds, title: 'DICOM Grei — Confronto' }, 'compare', target && target.id ? target : null);
  compares.add(w);
  w.once('ready-to-show', () => {
    if (w.isDestroyed()) return;
    w.show();
    if (place.maximize) w.maximize();
  });
  return w;
}

function close() {
  for (const w of [win, ...compares]) if (w && !w.isDestroyed()) w.close();
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

  // «Compara»: una seconda finestra con la stessa immagine, da mettere sullo
  // schermo accanto. Dal renderer arrivano solo identificativi, ricontrollati.
  ipcMain.handle('viewer-compare', (e, req) => {
    const r = req || {};
    const from = BrowserWindow.fromWebContents(e.sender);
    openCompare(from, {
      id: typeof r.id === 'string' && /^[0-9a-f-]{1,40}$/.test(r.id) ? r.id : null,
      key: typeof r.key === 'string' && /^s[0-9]{1,4}$/.test(r.key) ? r.key : null,
      idx: Number.isInteger(r.idx) && r.idx >= 0 ? r.idx : 0,
    });
    return { ok: true };
  });

  ipcMain.handle('viewer-fullscreen', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    w.setFullScreen(!w.isFullScreen());
    return w.isFullScreen();
  });
}

module.exports = { open, openCompare, placeCompare, close, register, window: () => win, compares: () => [...compares] };
