'use strict';

/**
 * Apre il viewer dell'app vera su un archivio di prova ed esegue una scena.
 *
 *   node_modules/electron/dist/electron.exe test/viewer-run.js <scena>
 *     es. test/viewer-run.js strumenti
 *
 * L'archivio di prova (archivio-viewer, nella cartella dei dati di prova) si ricostruisce ogni volta
 * da studio e studio2 (node test/fantoccio.js, o rigenerati se mancano). Variabili:
 *   SLOW=60 SLOTS=2   decodifica rallentata di 60 ms, due alla volta (postazione lenta)
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const { DATI, genera, comprimi } = require('./fantoccio');
const config = require(REPO + '/src/main/config.js');
config.ARCHIVE_DIR = path.join(DATI, process.env.ARCH || 'archivio-viewer');
const archive = require(REPO + '/src/main/archive.js');

const nome = process.argv[process.argv.length - 1];
const scene = require(path.join(__dirname, 'scene', nome.replace(/\.js$/, '') + '.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esito = { ok: 0, fail: 0 };
const check = (name, ok, extra) => {
  console.log(ok ? 'OK  ' : 'FAIL', name, extra == null ? '' : '· ' + extra);
  esito[ok ? 'ok' : 'fail']++;
};

async function preparaArchivio() {
  if (process.env.ARCH) return; // archivio già pronto (prove di fluidità)
  // i dati del fantoccio si rigenerano se mancano
  if (!fs.existsSync(path.join(DATI, 'studio'))) {
    genera(path.join(DATI, 'studio'));
    comprimi(path.join(DATI, 'studio'), path.join(DATI, 'studio2'));
  }
  fs.rmSync(config.ARCHIVE_DIR, { recursive: true, force: true });
  for (const [dir, reason] of [['studio2', 'non-indicizzato'], ['studio', 'invio-fallito']]) {
    const src = path.join(DATI, dir);
    if (!fs.existsSync(src)) continue;
    await archive.archiveStaging({ partDirs: [src], reason });
    await wait(1100); // id diversi: contengono l'ora al secondo
  }
}

require(REPO + '/src/main/main.js');
const viewerHost = require(REPO + '/src/main/viewerHost.js');

// Postazione lenta simulata: ogni decodifica tiene occupato uno dei posti per SLOW ms in più.
function rallenta() {
  if (!process.env.SLOW) return;
  const real = ipcMain._invokeHandlers.get('archive-frame');
  const slots = Number(process.env.SLOTS || viewerHost.WORKERS || 2);
  let busy = 0;
  const queue = [];
  const take = () => new Promise((r) => { if (busy < slots) { busy++; r(); } else queue.push(r); });
  const give = () => { const n = queue.shift(); if (n) n(); else busy--; };
  ipcMain.removeHandler('archive-frame');
  ipcMain.handle('archive-frame', async (e, req) => {
    await take();
    try {
      await wait(Number(process.env.SLOW));
      return await real(e, req);
    } finally {
      give();
    }
  });
  console.log('decodifica rallentata di', process.env.SLOW, 'ms ·', slots, 'in parallelo');
}

app.whenReady().then(async () => {
  try {
    await preparaArchivio();
  } catch (e) {
    // senza archivio la scena non ha senso: si esce subito, non dopo minuti di attesa
    console.log('PREPARAZIONE FALLITA', e.stack || e);
    return app.exit(1);
  }
  rallenta();
  await wait(600);
  const w = viewerHost.open();
  w.webContents.on('console-message', (_e, lvl, msg, line, src) => {
    if (lvl >= 2 && !/willReadFrequently/.test(msg)) console.log(`console[${lvl}] ${msg} (${path.basename(src || '')}:${line})`);
  });
  w.webContents.on('render-process-gone', (_e, d) => console.log('RENDERER MORTO', d.reason, d.exitCode));
  await new Promise((r) => w.webContents.once('did-finish-load', r));
  // una finestra coperta o senza fuoco viene rallentata da Chromium: per provare deve stare davanti
  w.webContents.setBackgroundThrottling(false);
  for (const o of BrowserWindow.getAllWindows()) if (o !== w) o.minimize();
  w.show();
  w.moveTop();
  w.focus();
  await wait(1500);

  const s = w.webContents;
  const ctx = {
    w, wait, check, archive, viewerHost,
    js: (code) => s.executeJavaScript(code),
    shot: async (name, rect) => fs.writeFileSync(path.join(DATI, name + '.png'), (await s.capturePage(rect)).toPNG()),
    mouse: (type, x, y, extra) => s.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, ...(extra || {}) }),
    key: (keyCode, modifiers) => { s.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers || [] }); s.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers || [] }); },
    drag: async (x0, y0, x1, y1, button = 'left', modifiers = []) => {
      s.sendInputEvent({ type: 'mouseMove', x: x0, y: y0, modifiers });
      s.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button, clickCount: 1, modifiers });
      for (let i = 1; i <= 8; i++) { s.sendInputEvent({ type: 'mouseMove', x: x0 + (x1 - x0) * i / 8, y: y0 + (y1 - y0) * i / 8, button, modifiers }); await wait(20); }
      s.sendInputEvent({ type: 'mouseUp', x: x1, y: y1, button, clickCount: 1, modifiers });
      await wait(150);
    },
  };
  try {
    await scene(ctx);
  } catch (e) {
    console.log('SCENA FALLITA', e.stack || e);
    esito.fail++;
  }
  if (esito.ok + esito.fail) console.log(`\n${esito.fail ? 'QUALCOSA NON VA' : 'TUTTI OK'} · ${esito.ok} ok, ${esito.fail} falliti`);
  app.exit(esito.fail ? 1 : 0);
});
