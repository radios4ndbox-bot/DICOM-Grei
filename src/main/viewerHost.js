'use strict';

const fs = require('fs');
const os = require('os');
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
// Decodifiche in parallelo. Il viewer ne chiede al massimo quattro alla volta
// (la fetta guardata, le vicine, il resto della serie): tanti worker quanti i
// processori lo permettono, lasciandone due al resto dell'app e a Windows.
const WORKERS = Math.max(2, Math.min(4, os.cpus().length - 2));

let win = null;            // il viewer con l'elenco degli esami: uno solo
const compares = new Set(); // finestre di confronto: quante se ne vuole
let workers = [];
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
    // al worker con meno lavoro in coda, non a turno: una decodifica lenta
    // (JPEG 2000) non deve tenere ferma dietro di sé la fetta che si guarda
    const load = new Map(workers.map((x) => [x, 0]));
    for (const p of pending.values()) load.set(p.worker, (load.get(p.worker) || 0) + 1);
    let w = workers[0];
    for (const x of workers) if (load.get(x) < load.get(w)) w = x;
    const id = ++seq;
    pending.set(id, { resolve, worker: w });
    w.postMessage({ id, file, frame });
  });
}

/*
 * In primo piano. Il viewer del PACS si apre su tutti gli schermi della
 * postazione: un clic sul PACS, sull'altro schermo, portava la sua finestra
 * davanti anche su quello di DICOM Grei, che spariva mentre si scorreva.
 * Viewer e finestre di confronto restano quindi sopra le finestre normali
 * (PACS compreso), sullo schermo in cui sono. Si spegne con «In primo piano»
 * nella barra; la scelta vale per tutte le finestre del viewer.
 */
let onTop = true;

function applyOnTop(w) {
  if (!w || w.isDestroyed()) return;
  // 'floating': sopra le finestre normali, sotto i menu e gli avvisi di sistema
  w.setAlwaysOnTop(onTop, 'floating');
}

function setOnTop(value) {
  onTop = !!value;
  for (const w of [win, ...compares]) {
    if (!w || w.isDestroyed()) continue;
    applyOnTop(w);
    w.webContents.send('viewer-on-top', onTop);
  }
  return onTop;
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
  applyOnTop(w);
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
 * Dove mettere una finestra di confronto. ◧/◨ dicono la direzione.
 *
 * Con più schermi (la postazione di refertazione): a tutto schermo su uno
 * schermo a lato, quello più vicino nella direzione scelta; se da quel lato
 * non ce ne sono, il più vicino dall'altro. Fra due candidati si preferisce
 * quello senza un'altra finestra di confronto. Così era nelle prime versioni,
 * e così deve restare: la meta' di uno schermo a lato è spazio sprecato.
 *
 * Con uno schermo solo: la metà sinistra o destra, accanto al resto.
 *
 * @param {'sinistra'|'destra'} side
 */
function placeCompare(from, side = 'destra') {
  const displays = screen.getAllDisplays();
  const here = from && !from.isDestroyed() ? screen.getDisplayMatching(from.getBounds()) : screen.getPrimaryDisplay();
  const others = displays.filter((d) => d.id !== here.id);
  if (others.length) {
    const cx = (d) => d.bounds.x + d.bounds.width / 2;
    const onSide = others.filter((d) => (side === 'sinistra' ? cx(d) < cx(here) : cx(d) > cx(here)));
    const pool = onSide.length ? onSide : others;
    const taken = new Set(
      [...compares].filter((w) => !w.isDestroyed()).map((w) => screen.getDisplayMatching(w.getBounds()).id)
    );
    const dist = (d) => Math.abs(cx(d) - cx(here));
    pool.sort((p, q) => (taken.has(p.id) ? 1 : 0) - (taken.has(q.id) ? 1 : 0) || dist(p) - dist(q));
    return { bounds: pool[0].workArea, maximize: true };
  }
  const a = here.workArea;
  const half = Math.floor(a.width / 2);
  const bounds =
    side === 'sinistra'
      ? { x: a.x, y: a.y, width: half, height: a.height }
      : { x: a.x + half, y: a.y, width: a.width - half, height: a.height };
  return { bounds, maximize: false };
}

/**
 * Finestra di confronto: lo stesso viewer, senza l'elenco a lato, aperto
 * sull'immagine che si stava guardando. Ogni «Compara» ne apre una nuova.
 */
function openCompare(from, target) {
  const place = placeCompare(from, target && target.side);
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
      side: r.side === 'sinistra' ? 'sinistra' : 'destra',
    });
    return { ok: true };
  });

  // «In primo piano»: vale per tutte le finestre del viewer
  ipcMain.handle('viewer-on-top', (_e, value) => setOnTop(value === true));
  ipcMain.handle('viewer-on-top-get', () => onTop);

  ipcMain.handle('viewer-fullscreen', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    w.setFullScreen(!w.isFullScreen());
    return w.isFullScreen();
  });
}

module.exports = { open, openCompare, placeCompare, close, register, WORKERS, window: () => win, compares: () => [...compares] };
