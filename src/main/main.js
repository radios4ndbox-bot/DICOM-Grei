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
const { buildSeriesPreview } = require('./seriesPreview');
const { stageFiles } = require('./copyStage');
const { sendStoreScu } = require('./sendStoreScu');
const { cleanup, dailyPurge } = require('./cleanup');

const config = require('./config');
const settings = require('./settings');

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
const session = { drives: [], prepared: null, plan: null, send: null };

const TYPE_OVERRIDE = {
  A: { pattern: 'MP*', strategy: 'keep' },
  B: { pattern: '*.dcm', strategy: 'rename' },
  C: { pattern: '*.dcm', strategy: 'suffix' },
  D: { pattern: '*.dcm', strategy: 'rename' },
};

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

  // Turbo = più associazioni DICOM in parallelo. Di default se ne usano poche
  // per non caricare né il PC dell'operatore né il PACS.
  const turbo = !!(opts && opts.turbo);
  const workers = turbo ? config.WORKERS_TURBO : config.WORKERS_NORMAL;

  const copy = await stageFiles(plan, emitProgress, workers);

  if (copy.copied === 0) {
    return { copy, send: null, iso, error: 'Nessun file copiato in staging: invio annullato.' };
  }

  const pending = sendStoreScu(
    { pattern: plan.pattern, partDirs: copy.partDirs, totalFiles: copy.copied },
    (ev) => {
      if (ev.type === 'log') emitLog(ev.line);
      else if (ev.type === 'progress') emitProgress(ev.data);
    }
  );
  session.send = pending;

  let send;
  try {
    send = await pending;
  } finally {
    session.send = null;
  }

  // Invio interrotto (operatore o RIS): lo staging resta a metà, va azzerato.
  // L'ISO resta montata di proposito, così si può ripartire senza rileggere il
  // supporto; viene smontata dalla pulizia finale.
  if (send.cancelled) {
    const reset = await cleanup({});
    return { copy, send, iso, interrupted: true, reset };
  }

  return { copy, send, iso, workers, turbo };
});

// Interruzione dell'invio in corso. Il chiamante riceve comunque il risultato
// da 'run-import', con interrupted:true e lo staging già ripulito.
ipcMain.handle('stop-import', () => {
  if (!session.send) return { stopped: false };
  session.send.cancel();
  return { stopped: true };
});

ipcMain.handle('daily-purge', () => dailyPurge(false));

// ---- impostazioni

ipcMain.handle('get-settings', () => settings.describe());

ipcMain.handle('save-settings', (_e, values) => {
  // Cambiare parametri mentre storescu sta girando darebbe uno stato incoerente
  // fra quello che si vede e quello che l'invio in corso sta usando.
  if (session.send) {
    return { ok: false, errors: ['Trasferimento in corso: attendere la fine o interrompere.'] };
  }
  const r = settings.save(values);
  if (r.ok) refreshPacsBadge();
  return r;
});

ipcMain.handle('reset-settings', () => {
  if (session.send) {
    return { ok: false, errors: ['Trasferimento in corso: attendere la fine o interrompere.'] };
  }
  const r = settings.reset();
  refreshPacsBadge();
  return r;
});

function refreshPacsBadge() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pacs-changed', {
      aet: config.DEST_AET,
      host: config.PACS_IP,
      port: config.PACS_PORT,
    });
  }
}

ipcMain.handle('series-preview', () => {
  if (!session.plan) throw new Error('Nessuna classificazione disponibile.');
  const r = buildSeriesPreview(session.plan.dataRoot);
  session.seriesFiles = r.files;
  for (const s of r.series) {
    if (s.gray) s.gray = s.gray.buffer.slice(s.gray.byteOffset, s.gray.byteOffset + s.gray.byteLength);
    if (s.rgb) s.rgb = s.rgb.buffer.slice(s.rgb.byteOffset, s.rgb.byteOffset + s.rgb.byteLength);
  }
  return { series: r.series, scanned: r.scanned, truncated: r.truncated };
});

// Immagine a grandezza piena di una serie, indicata per indice: i percorsi
// restano nel main.
ipcMain.handle('preview-series', (_e, id) => {
  const files = session.seriesFiles || [];
  const f = files[Number(id)];
  if (!f) return { unsupported: 'no-path' };
  const r = decodePixels(f);
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
  // prima di tutto: i valori salvati sovrascrivono i default di config
  settings.load();

  // Conservazione giornaliera: all'avvio e poi a ogni cambio di data, le copie
  // della giornata precedente vengono eliminate. Mai durante un invio.
  const purgeIfIdle = () => {
    if (session.send) return;
    dailyPurge(false).catch(() => {});
  };
  purgeIfIdle();
  setInterval(purgeIfIdle, 10 * 60 * 1000).unref();

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
