'use strict';

// «Compara»: seconda finestra sulla stessa immagine, nella metà di schermo scelta.
const { BrowserWindow, screen } = require('electron');

module.exports = async ({ w, wait, js, check, viewerHost }) => {
  const NL = 'String.fromCharCode(10)';
  const info = (win) => win.webContents.executeJavaScript(`({
    compare: document.body.classList.contains('compare'),
    side: getComputedStyle(document.querySelector('.side')).display,
    im: document.querySelector('.panel.active .ov--bl').textContent.split(${NL})[0],
    serie: (document.querySelector('.panel.active .ov--tr').textContent.split(${NL})[2] || ''),
  })`);
  const area = screen.getDisplayMatching(w.getBounds()).workArea;
  const half = Math.floor(area.width / 2);
  const near = (a, b) => Math.abs(a - b) <= 16;
  const closeCompares = async () => { for (const c of viewerHost.compares()) c.close(); await wait(400); };

  // serie coronale, immagine 12
  await js('document.querySelectorAll(".serie")[2].click()');
  await wait(600);
  await js('(()=>{const sl=document.querySelector(".panel.active .panel__slider");sl.value=11;sl.dispatchEvent(new Event("input"));})()');
  await wait(400);
  const src = await info(w);

  check('di partenza: metà destra scelta', await js('document.getElementById("btn-half-r").classList.contains("on") && !document.getElementById("btn-half-l").classList.contains("on")'));

  // destra
  await js('document.getElementById("btn-compare").click()');
  await wait(2500);
  let c = viewerHost.compares()[0];
  let b = c.getBounds();
  check('◨ destra: metà destra dello schermo', near(b.x, area.x + half) && near(b.width, area.width - half) && near(b.height, area.height), `${JSON.stringify(b)} su ${JSON.stringify(area)}`);
  const ci = await info(c);
  check('stessa immagine e serie, senza elenco', ci.compare && ci.side === 'none' && ci.im === src.im && ci.serie === src.serie, `${ci.serie} · ${ci.im}`);
  await closeCompares();

  // sinistra, e la scelta si ricorda
  await js('document.getElementById("btn-half-l").click()');
  check('◧ si accende', await js('document.getElementById("btn-half-l").classList.contains("on") && !document.getElementById("btn-half-r").classList.contains("on")'));
  await js('document.getElementById("btn-compare").click()');
  await wait(2500);
  c = viewerHost.compares()[0];
  b = c.getBounds();
  check('◧ sinistra: metà sinistra dello schermo', near(b.x, area.x) && near(b.width, half) && near(b.height, area.height), JSON.stringify(b));
  check('anche la finestra di confronto ha le due metà, con la stessa scelta', await c.webContents.executeJavaScript('document.getElementById("btn-half-l").classList.contains("on")'));
  await closeCompares();

  // riaprendo il viewer la scelta resta
  w.webContents.reload();
  await new Promise((r) => w.webContents.once('did-finish-load', r));
  await wait(1200);
  check('ricaricato il viewer, resta la metà sinistra', await js('document.getElementById("btn-half-l").classList.contains("on")'));
  await js('document.getElementById("btn-half-r").click()'); // si lascia com'era
  check('finestre: solo il viewer e l\'app', BrowserWindow.getAllWindows().length === 2);
};
