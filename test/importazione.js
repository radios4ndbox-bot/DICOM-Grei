'use strict';

/**
 * Importazione vera dall'interfaccia, con un supporto finto (una "chiavetta"
 * che punta allo studio sintetico) e un PACS finto (storescp di DCMTK).
 *
 *   node test/fantoccio.js
 *   node_modules/electron/dist/electron.exe test/importazione.js
 *
 * Tutto avviene in test/.dati/importazione: staging, archivio, log,
 * impostazioni. Niente tocca le cartelle vere della postazione.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const { DATI, DCMTK } = require('./fantoccio');
const WORK = path.join(DATI, 'importazione');
const PORT = 11120;
fs.rmSync(WORK, { recursive: true, force: true });

// supporto finto: lo studio sintetico con nomi numerici in DICOM\ (Tipo B)
const MEDIA = path.join(WORK, 'supporto');
fs.mkdirSync(path.join(MEDIA, 'DICOM'), { recursive: true });
fs.readdirSync(path.join(DATI, 'studio')).forEach((f, i) =>
  fs.copyFileSync(path.join(DATI, 'studio', f), path.join(MEDIA, 'DICOM', String(i + 1).padStart(6, '0'))));

const config = require(REPO + '/src/main/config.js');
Object.assign(config, {
  STAGING_DIR: path.join(WORK, 'staging'), EXTRACT_DIR: path.join(WORK, 'staging_src'), DAILY_STAMP: path.join(WORK, 'staging.day'),
  LEGACY_STAGING_DIR: path.join(WORK, 'x1'), LEGACY_EXTRACT_DIR: path.join(WORK, 'x2'), LEGACY_DAILY_STAMP: path.join(WORK, 'x3'),
  ARCHIVE_DIR: path.join(WORK, 'archivio'),
});
// impostazioni di prova: PACS su una porta locale dove ascolta solo il PACS finto, quando c'è
fs.writeFileSync(path.join(WORK, 'settings.json'), JSON.stringify({ PACS_IP: '127.0.0.1', PACS_PORT: PORT, DEST_AET: 'ANY-SCP', SRC_AET: 'STORESCU' }));
require(REPO + '/src/main/settings.js').setPathsForTest({ personal: path.join(WORK, 'settings.json'), shared: null });
require(REPO + '/src/main/detectMedia.js').detectMedia = async () => [{ caption: 'X:', driveType: 2, kind: 'USB', volumeName: 'PROVA' }];
require(REPO + '/src/main/isoZip.js').prepareSource = async () => ({ kind: 'usb', sourcePath: MEDIA, iso: null, note: '' });
const importLog = require(REPO + '/src/main/importLog.js');
const realOpen = importLog.openImportLog;
importLog.openImportLog = () => realOpen({ dirs: [path.join(WORK, 'log')] });

const archive = require(REPO + '/src/main/archive.js');
require(REPO + '/src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, ko = 0;
const check = (name, cond, extra) => {
  console.log(cond ? 'OK  ' : 'FAIL', name, extra == null ? '' : '· ' + extra);
  cond ? ok++ : ko++;
};
const staged = () => {
  const out = [];
  const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else out.push(e.name); } } catch {} };
  walk(config.STAGING_DIR);
  return out.length;
};
const logs = () => { try { return fs.readdirSync(path.join(WORK, 'log')).sort(); } catch { return []; } };
const lastLog = () => fs.readFileSync(path.join(WORK, 'log', logs().pop()), 'utf8');
const pacs = () => {
  const dir = path.join(WORK, 'pacs-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const p = spawn(path.join(DCMTK, 'storescp.exe'), ['-od', dir, '-uf', '-pm', String(PORT)]);
  return { dir, stop: () => p.kill(), got: () => fs.readdirSync(dir).length };
};

let first = true;
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('console-message', (_ev, lvl, msg, line, src) => { if (lvl >= 2) console.log(`console[${lvl}] ${msg} (${path.basename(src || '')}:${line})`); });
  if (!first) return;
  first = false;
  w.once('show', async () => {
    const js = (c) => w.webContents.executeJavaScript(c);
    const until = async (cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(cond)) return true; await wait(200); } return false; };
    const visible = (id) => js(`!document.getElementById('${id}').classList.contains('hidden') && !document.getElementById('${id}').hidden`);
    const text = (id) => js(`document.getElementById('${id}').textContent`);
    const toStudy = async () => {
      await until('document.querySelectorAll("#drive-list li").length > 0', 8000);
      await js('document.querySelector("#drive-list li").click(); document.getElementById("btn-to-study").click()');
      return until('!document.getElementById("step-study").classList.contains("hidden")', 15000);
    };
    const copyToChoice = async () => {
      if (!(await toStudy())) return false;
      await js('document.getElementById("btn-start").click()');
      return until('!document.getElementById("choice").classList.contains("hidden") || !document.getElementById("summary").classList.contains("hidden")', 30000);
    };
    const waitDone = () => until('!document.getElementById("summary").classList.contains("hidden")', 120000);
    const restart = async (label) => {
      const before = staged();
      await js('document.getElementById("btn-restart").click()');
      await until('!document.getElementById("step-media").classList.contains("hidden")', 8000);
      await wait(400);
      check(`${label}: «Nuova importazione» svuota lo staging`, before > 0 && staged() === 0, `${before} -> ${staged()} file`);
    };
    const realStorescu = config.STORESCU;

    try {
      await wait(900);
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); // salta l'intro
      await wait(3500);

      // ===== 1. storescu non disponibile: la copia procede, il PACS no, l'archivio sì
      config.STORESCU = path.join(WORK, 'manca', 'storescu.exe');
      check('step 2: il pulsante dice «Copia in locale», nessuna scelta di destinazione', (await toStudy()) && (await text('btn-start')) === 'Copia in locale' && !(await js('!!document.querySelector("#step-study #send-mode")')));
      await js('document.getElementById("btn-start").click()');
      await until('!document.getElementById("choice").classList.contains("hidden")', 30000);
      check('copia finita: compare la scelta', await visible('choice'), `${await text('phase-label')} · ${await text('phase-detail')}`);
      check('stato della barra: «Copia completata», secondo passo «Destinazione»', (await text('phase-label')) === 'Copia completata' && (await text('sp-label-2')) === 'Destinazione');
      check('senza storescu: «Invia al PACS» disattivato e il motivo scritto', (await js('document.getElementById("btn-choice-pacs").disabled')) && /storescu/.test(await text('choice-why')), await text('choice-why'));
      check('niente ancora in archivio prima della scelta', archive.list().length === 0);
      check('«Nuova importazione» disponibile durante la scelta (vale come annulla)', await visible('btn-restart'));
      await js('document.getElementById("btn-choice-archive").click()');
      await waitDone();
      await wait(300);
      const a1 = archive.list();
      check('«Solo archivio»: esame conservato', a1.length === 1 && a1[0].reason === 'solo-archivio' && (await text('phase-label')) === 'Importato in archivio', `${a1.map((m) => m.reason)} · ${await text('phase-label')}`);
      const log1 = lastLog();
      check('un solo log dalla copia all\'esito', logs().length === 1 && /COPIA IN LOCALE/.test(log1) && /Destinazione: da scegliere dopo la copia/.test(log1) && /Destinazione: solo archivio/.test(log1) && /Esito: solo archivio/.test(log1));
      check('il log dice perché il PACS non era disponibile, e non ha il nome del paziente', /invio al PACS non disponibile/.test(log1) && !/PROVA|SINTETICO|TEST-0001/.test(log1));
      config.STORESCU = realStorescu;
      await restart('dopo solo archivio');

      // ===== 2. copia e poi «Nuova importazione» senza scegliere
      await copyToChoice();
      check('con storescu: «Invia al PACS» attivo', !(await js('document.getElementById("btn-choice-pacs").disabled')) && !(await visible('choice-why')));
      // è guardando l'anteprima che si sceglie: deve esserci anche dopo una copia di un attimo
      const tiles = (await until('document.querySelectorAll("#viewer-grid > *").length >= 3', 8000)) && (await js('document.querySelectorAll("#viewer-grid > *").length'));
      check('alla scelta l\'anteprima mostra le serie', tiles >= 3, `${tiles} riquadri`);
      fs.writeFileSync(path.join(DATI, 'scelta.png'), (await w.webContents.capturePage()).toPNG());
      await restart('annullata alla scelta');
      check('annullata: niente in archivio in più', archive.list().length === 1);
      check('annullata: il log lo dice', logs().length === 2 && /ANNULLATA dopo la copia/.test(lastLog()));

      // ===== 3. PACS irraggiungibile: invio fallito, l'esame va in archivio da solo
      await archive.remove(a1[0].id);
      await copyToChoice();
      await js('document.getElementById("btn-choice-pacs").click()');
      check('PACS irraggiungibile: invio concluso come non riuscito', (await waitDone()) && (await text('phase-label')) === 'Invio non riuscito', `${await text('phase-label')} · ${await text('phase-detail')}`);
      await wait(300);
      const a3 = archive.list();
      check('…e l\'esame è in archivio come «invio fallito»', a3.length === 1 && a3[0].reason === 'invio-fallito');
      check('etichetta «Invio a PACS» e contatori visibili', (await text('sp-label-2')) === 'Invio a PACS' && !(await js('document.getElementById("send-ok").hidden')));
      await restart('dopo invio fallito');
      await archive.remove(a3[0].id);

      // ===== 4. PACS finto, sequenziale: tutto arriva; poi «Conserva in archivio»
      let p = pacs();
      await wait(1500);
      await copyToChoice();
      await js('document.getElementById("btn-choice-pacs").click()');
      await waitDone();
      await wait(500);
      p.stop();
      check('sequenziale: 62 file su 62 al PACS, stato «completato»', p.got() === 62 && (await text('phase-label')) === 'Trasferimento completato' && (await text('sum-ok')) === '62', `${p.got()} ricevuti · ${await text('phase-label')}`);
      check('invio riuscito: niente in archivio, «Conserva in archivio» disponibile', archive.list().length === 0 && (await visible('btn-archive')));
      await js('document.getElementById("btn-archive").click()');
      await until('!document.getElementById("archive-status").classList.contains("hidden")', 15000);
      const a4 = archive.list();
      check('«Conserva in archivio»: esame come «non indicizzato»', a4.length === 1 && a4[0].reason === 'non-indicizzato');
      await restart('dopo invio riuscito');
      await archive.remove(a4[0].id);

      // ===== 5. PACS finto, parallelo: lo staging si divide solo adesso, a copia finita
      p = pacs();
      await wait(1500);
      await copyToChoice();
      await js('(()=>{const s=document.getElementById("send-mode");s.value="normal";s.dispatchEvent(new Event("change"));})()');
      check('Parallelo: la nota dice cosa fare se il PACS rifiuta', /Association Request Failed/.test(await text('send-mode-note')));
      await js('document.getElementById("btn-choice-pacs").click()');
      await waitDone();
      await wait(500);
      p.stop();
      const log5 = lastLog();
      const parts = fs.readdirSync(config.STAGING_DIR).filter((d) => d.startsWith(config.PART_PREFIX));
      check('parallelo: 62 su 62, nessun doppione, due associazioni', p.got() === 62 && (await text('sum-ok')) === '62' && /2 associazione\/i in parallelo/.test(log5) && /Destinazione: PACS · invio normal · 2 associazioni/.test(log5), `${p.got()} ricevuti`);
      check('…sulle due parti create dopo la copia', parts.length === 2, parts.join(', '));
      await restart('dopo invio parallelo');
      check('dopo «Nuova importazione» la modalità torna Sequenziale', (await js('document.getElementById("send-mode").value')) === 'single');
    } catch (e) {
      console.log('PROVA FALLITA', e.stack || e);
      ko++;
    }
    console.log(`\n${ko ? 'QUALCOSA NON VA' : 'TUTTI OK'} · ${ok} ok, ${ko} falliti`);
    app.exit(ko ? 1 : 0);
  });
});
