'use strict';

/**
 * Dove si apre «Compara», con schermi simulati (uno, due, tre).
 *   node_modules/electron/dist/electron.exe test/schermi.js
 */

const { app, screen } = require('electron');
const path = require('path');
const REPO = path.resolve(__dirname, '..');
const viewerHost = require(REPO + '/src/main/viewerHost.js');

const D = (id, x, w = 1920, h = 1080) => ({ id, bounds: { x, y: 0, width: w, height: h }, workArea: { x, y: 0, width: w, height: h - 48 } });
let ko = 0;
const check = (name, ok, extra) => { console.log(ok ? 'OK  ' : 'FAIL', name, extra == null ? '' : '· ' + extra); if (!ok) ko++; };

app.whenReady().then(() => {
  let displays = [];
  screen.getAllDisplays = () => displays;
  screen.getPrimaryDisplay = () => displays[0];
  screen.getDisplayMatching = (b) => displays.slice().sort((p, q) => Math.abs(p.bounds.x - b.x) - Math.abs(q.bounds.x - b.x))[0];
  const win = (x) => ({ isDestroyed: () => false, getBounds: () => ({ x: x + 100, y: 50, width: 1200, height: 800 }) });
  const at = (p) => `x=${p.bounds.x} largo ${p.bounds.width}`;

  displays = [D(1, 0, 2560, 1440)];
  let p = viewerHost.placeCompare(win(0), 'destra');
  check('uno schermo, destra: metà destra', p.bounds.x === 1280 && p.bounds.width === 1280 && p.bounds.height === 1392 && !p.maximize, at(p));
  p = viewerHost.placeCompare(win(0), 'sinistra');
  check('uno schermo, sinistra: metà sinistra', p.bounds.x === 0 && p.bounds.width === 1280, at(p));
  p = viewerHost.placeCompare(win(0));
  check('senza scelta: destra', p.bounds.x === 1280, at(p));

  displays = [D(1, 0), D(2, 1920)];
  p = viewerHost.placeCompare(win(1920), 'sinistra');
  check('due schermi, viewer a destra: sull\'altro schermo, metà sinistra', p.bounds.x === 0 && p.bounds.width === 960, at(p));
  p = viewerHost.placeCompare(win(0), 'destra');
  check('due schermi, viewer a sinistra: sull\'altro schermo, metà destra', p.bounds.x === 1920 + 960 && p.bounds.width === 960, at(p));

  displays = [D(1, 0), D(2, 1920), D(3, 3840)];
  p = viewerHost.placeCompare(win(0), 'destra');
  check('tre schermi, viewer sul primo: lo schermo più vicino', p.bounds.x === 1920 + 960, at(p));

  p = viewerHost.placeCompare(null, 'sinistra');
  check('senza finestra di partenza: rispetto allo schermo principale', p.bounds.x === 1920, at(p));

  console.log(ko ? 'QUALCOSA NON VA' : 'TUTTI OK');
  app.exit(ko ? 1 : 0);
});
