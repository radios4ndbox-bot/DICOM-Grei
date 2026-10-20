'use strict';

// «In primo piano»: viewer e finestre di confronto restano sopra le altre (il PACS).
const { BrowserWindow } = require('electron');

module.exports = async ({ w, wait, js, check, viewerHost }) => {
  const others = () => viewerHost.compares();
  const btn = (win) => win.webContents.executeJavaScript('document.getElementById("btn-ontop").classList.contains("on")');

  check('viewer in primo piano di serie, pulsante acceso', w.isAlwaysOnTop() && (await btn(w)));

  await js('document.getElementById("btn-compare").click()');
  await wait(2500);
  const c = others()[0];
  check('anche la finestra di confronto', c && c.isAlwaysOnTop() && (await btn(c)));

  // una finestra qualunque presa in primo piano (al posto del PACS): le nostre restano sopra
  const pacs = new BrowserWindow({ width: 800, height: 600, show: true, title: 'PACS finto' });
  pacs.focus();
  await wait(500);
  check('un\'altra finestra prende il fuoco: le nostre restano «sempre sopra»', pacs.isFocused() && w.isAlwaysOnTop() && c.isAlwaysOnTop() && !pacs.isAlwaysOnTop());
  pacs.close();

  await js('document.getElementById("btn-ontop").click()');
  await wait(400);
  check('spento dal viewer: spento in tutte le finestre, pulsanti allineati', !w.isAlwaysOnTop() && !c.isAlwaysOnTop() && !(await btn(w)) && !(await btn(c)));

  w.webContents.reload();
  await new Promise((r) => w.webContents.once('did-finish-load', r));
  await wait(1200);
  check('ricaricato il viewer: resta spento', !w.isAlwaysOnTop() && !(await btn(w)));

  await c.webContents.executeJavaScript('document.getElementById("btn-ontop").click()');
  await wait(400);
  check('riacceso dalla finestra di confronto: acceso in tutte', w.isAlwaysOnTop() && c.isAlwaysOnTop() && (await btn(w)));
  c.close();
  await wait(300);
  check('finestre rimaste: viewer e app', BrowserWindow.getAllWindows().length === 2);
};
