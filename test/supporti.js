'use strict';

/**
 * Elenco dei supporti al passo 1: icona e etichetta secondo il tipo.
 *   node_modules/electron/dist/electron.exe test/supporti.js
 * Lo scatto finisce in %LOCALAPPDATA%\DICOM Grei test\supporti.png.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const { DATI } = require('./fantoccio');
fs.mkdirSync(DATI, { recursive: true });
require(REPO + '/src/main/settings.js').setPathsForTest({ personal: path.join(DATI, 'settings-supporti.json'), shared: null });
require(REPO + '/src/main/detectMedia.js').detectMedia = async () => [
  { caption: 'E:', driveType: 2, kind: 'USB', volumeName: 'CHIAVETTA' },
  { caption: 'D:', driveType: 5, kind: 'CD', volumeName: 'PATIENTCD' },
];
require(REPO + '/src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let first = true;
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('console-message', (_ev, lvl, msg) => { if (lvl >= 2) console.log('console: ' + msg); });
  if (!first) return;
  first = false;
  w.once('show', async () => {
    const js = (c) => w.webContents.executeJavaScript(c);
    let ko = 0;
    const check = (name, cond, extra) => { console.log(cond ? 'OK  ' : 'FAIL', name, extra == null ? '' : '· ' + extra); if (!cond) ko++; };
    await wait(900);
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); // salta l'intro
    await wait(3500);
    const cards = await js(`[...document.querySelectorAll('#drive-list li')].map((li) => ({
      icona: li.querySelector('svg.drive-icon') ? li.querySelector('svg.drive-icon').children.length : 0,
      cerchi: li.querySelectorAll('svg.drive-icon circle').length,
      testo: li.textContent.trim().replace(/\\s+/g, ' '),
      tratto: li.querySelector('svg.drive-icon') && getComputedStyle(li.querySelector('svg.drive-icon')).stroke,
    }))`);
    check('due supporti in elenco', cards.length === 2, JSON.stringify(cards.map((c) => c.testo)));
    check('USB: icona della chiavetta (nessun cerchio)', cards[0] && cards[0].icona === 4 && cards[0].cerchi === 0 && /USB/.test(cards[0].testo), JSON.stringify(cards[0]));
    check('CD/DVD: icona del disco (due cerchi)', cards[1] && cards[1].icona === 3 && cards[1].cerchi === 2 && /CD\/DVD/.test(cards[1].testo), JSON.stringify(cards[1]));
    check('icone nel colore del tema, senza riempimento', cards.every((c) => c.tratto && c.tratto !== 'none'));
    await js('document.querySelector("#drive-list li:nth-child(2)").click()');
    await wait(200);
    const r = await js('(()=>{const b=document.getElementById("drive-list").getBoundingClientRect();return {x:Math.max(0,Math.round(b.left)-10),y:Math.max(0,Math.round(b.top)-60),width:Math.round(b.width)+20,height:Math.round(b.height)+70}})()');
    fs.writeFileSync(path.join(DATI, 'supporti.png'), (await w.webContents.capturePage(r)).toPNG());
    console.log(ko ? 'QUALCOSA NON VA' : 'TUTTI OK');
    app.exit(ko ? 1 : 0);
  });
});
