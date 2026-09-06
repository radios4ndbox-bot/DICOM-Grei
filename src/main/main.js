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

const config = require('./config');

const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');

let mainWindow = null;
let splashWindow = null;
let mainRevealed = false;

/**
 * Stato autorevole del flusso, tenuto nel main.
 *
 * Il renderer è sandboxed ma resta la superficie meno fidata (mostra nomi di
 * file e etichette di volume che arrivano da un CD/USB paziente). Perciò il
 * main non accetta più percorsi o piani costruiti dal renderer: li ricalcola
 * da qui e dal renderer prende solo scelte (quale unità, quale tipo forzato).
 */
const session = { drives: [], prepared: null, plan: null };

const TYPE_OVERRIDE = {
  A: { pattern: 'MP*', strategy: 'keep' },
  B: { pattern: '*.dcm', strategy: 'rename' },
  C: { pattern: '*.dcm', strategy: 'suffix' },
  D: { pattern: '*.dcm', strategy: 'rename' },
};

// true se `child` è dentro `parent` (o coincide), a prova di ".." e symlink-ish.
function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function fileUrl(relFromMain) {
  return url.format({
    pathname: path.join(__dirname, relFromMain),
    protocol: 'file:',
    slashes: true,
  });
}

function createSplash() {
  const opts = {
    width: 440,
    height: 320,
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
      sandbox: true,
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

ipcMain.handle('detect-media', async () => {
  session.drives = await detectMedia();
  session.prepared = null;
  session.plan = null;
  return session.drives;
});

ipcMain.handle('prepare-source', async (_e, drive) => {
  // Accetta solo un'unità presente nell'ultimo rilevamento: il renderer sceglie
  // fra quelle, non può proporre un percorso arbitrario.
  const caption = drive && typeof drive.caption === 'string' ? drive.caption : '';
  const known = session.drives.find((d) => d.caption === caption);
  if (!known) throw new Error('Unità non riconosciuta: rilancia il rilevamento supporti.');

  session.prepared = await prepareSource(known);
  session.plan = null;
  return session.prepared;
});

ipcMain.handle('classify', (_e) => {
  if (!session.prepared) throw new Error('Nessun supporto preparato.');

  const plan = classify(session.prepared.sourcePath);
  let study = null;
  try {
    study = readStudyInfo(plan.dataRoot, plan);
  } catch {
    study = null;
  }
  session.plan = plan;
  return { ...plan, study };
});

ipcMain.handle('run-import', async (_e, opts) => {
  if (!session.plan) throw new Error('Nessuna classificazione disponibile.');

  const emitProgress = (d) => mainWindow && mainWindow.webContents.send('progress', d);
  const emitLog = (line) => mainWindow && mainWindow.webContents.send('log', line);

  // Dal renderer prendiamo SOLO l'eventuale tipo forzato dalla tendina.
  // dataRoot/subfolders restano quelli calcolati qui: il renderer non può
  // far leggere a stageFiles una cartella qualsiasi del PC.
  const forced = opts && typeof opts.type === 'string' ? opts.type : '';
  const ov = TYPE_OVERRIDE[forced];
  const plan = ov ? { ...session.plan, type: forced, ...ov } : session.plan;

  const iso = (session.prepared && session.prepared.iso) || null;

  const copy = await stageFiles(plan, emitProgress);

  if (copy.copied === 0) {
    return { copy, send: null, iso, error: 'Nessun file copiato in staging: invio annullato.' };
  }

  const send = await sendStoreScu(plan.pattern, copy.copied, (ev) => {
    if (ev.type === 'log') emitLog(ev.line);
    else if (ev.type === 'progress') emitProgress(ev.data);
  });

  return { copy, send, iso };
});

ipcMain.handle('preview-image', (_e, absPath) => {
  if (!absPath || typeof absPath !== 'string') return { unsupported: 'no-path' };

  // L'anteprima può leggere solo dentro la sorgente preparata o lo staging:
  // altrimenti sarebbe una primitiva di lettura file arbitraria.
  const roots = [config.STAGING_DIR];
  if (session.plan) roots.push(session.plan.dataRoot);
  if (session.prepared) roots.push(session.prepared.sourcePath);
  if (!roots.some((r) => isInside(r, absPath))) return { unsupported: 'no-path' };

  const r = decodePixels(absPath);
  // trasferisci i pixel come ArrayBuffer (niente copia JSON enorme)
  if (r.gray) r.gray = r.gray.buffer.slice(r.gray.byteOffset, r.gray.byteOffset + r.gray.byteLength);
  if (r.rgb) r.rgb = r.rgb.buffer.slice(r.rgb.byteOffset, r.rgb.byteOffset + r.rgb.byteLength);
  return r;
});

ipcMain.handle('cleanup', async () => {
  const emitProgress = (d) => mainWindow && mainWindow.webContents.send('progress', d);
  // L'ISO da smontare è quella montata da noi in questa sessione, non una
  // qualsiasi indicata dal renderer.
  const iso = (session.prepared && session.prepared.iso) || null;
  emitProgress({ phase: 'cleanup', state: 'start' });
  const result = await cleanup({ iso });
  emitProgress({ phase: 'cleanup', state: 'done', result });
  return result;
});

// ---------------------------------------------------------------- lifecycle

// Due istanze condividerebbero C:\tmp\dicom_import: la seconda svuoterebbe lo
// staging mentre la prima sta ancora inviando al PACS.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = mainRevealed ? mainWindow : splashWindow;
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
}

/**
 * Nessuna finestra dell'app deve poter navigare fuori dai propri file locali,
 * né aprire finestre nuove. Vale anche se un giorno finisse un link cliccabile
 * in una schermata che mostra dati provenienti dal supporto.
 */
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

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
