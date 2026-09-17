'use strict';

const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const dicomParser = require('dicom-parser');

const { decode } = require('./dicomPixels');

/**
 * Anteprima a mosaico, costruita MENTRE si copia in locale.
 *
 * Il motivo per cui l'anteprima era stata tolta: leggeva l'intestazione di ogni
 * file direttamente dal supporto e lo faceva nel main process. Su un DVD da
 * 3000 immagini erano minuti di I/O ottico con la finestra congelata.
 *
 * Qui cambiano due cose. Primo: si leggono i file GIÀ COPIATI in
 * C:\tmp\dicom_import, cioè da disco locale, riusando un I/O che la copia ha
 * appena fatto — il supporto non viene letto una seconda volta. Secondo: tutto
 * gira in un worker thread, quindi né la barra di avanzamento né il pulsante
 * "Interrompi" possono restare bloccati.
 *
 * Di ogni serie si mostra una sola immagine, la prima: in TC ciò significa un
 * riquadro per assiale, coronale e sagittale; in RX un riquadro per proiezione.
 */

const CFG = {
  maxTiles: 12,
  maxScan: 6000,
  thumbPx: 256,
  headerBytes: 96 * 1024,
  maxPixels: 64 * 1024 * 1024,
  maxJpegBytes: 4 * 1024 * 1024,
  ...(workerData || {}),
};

const TAG = {
  seriesUid: 'x0020000e',
  seriesNumber: 'x00200011',
  seriesDesc: 'x0008103e',
  modality: 'x00080060',
  instance: 'x00200013',
  orientation: 'x00200037',
  viewPosition: 'x00185101',
  laterality: 'x00200062',
  bodyPart: 'x00180015',
};

// ---------------------------------------------------------------- intestazioni

function readHeader(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (size < 132) return null;
    const len = Math.min(size, CFG.headerBytes);
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, buf, 0, len, 0);
    return dicomParser.parseDicom(buf.subarray(0, read), { untilTag: 'x7fe00010' });
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function str(ds, tag) {
  try {
    return (ds.string(tag) || '').trim();
  } catch {
    return '';
  }
}

function intOf(ds, tag) {
  const n = parseInt(str(ds, tag), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- orientamento

const AXIS = ['Sagittale', 'Coronale', 'Assiale']; // |n.x| , |n.y| , |n.z|

/**
 * Orientamento dal cosenodirettore dell'immagine (0020,0037): la normale al
 * piano è il prodotto vettoriale di riga e colonna, e l'asse su cui la normale
 * è più grande dà il piano. È il criterio con cui una TC distingue assiale,
 * coronale e sagittale anche quando le ricostruzioni stanno nella stessa serie.
 */
function planeFromOrientation(raw) {
  if (!raw) return '';
  const v = String(raw).split('\\').map(Number);
  if (v.length < 6 || v.some((x) => !Number.isFinite(x))) return '';
  const [rx, ry, rz, cx, cy, cz] = v;
  const n = [ry * cz - rz * cy, rz * cx - rx * cz, rx * cy - ry * cx];
  const a = n.map(Math.abs);
  const i = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
  // normale molto inclinata rispetto a ogni asse: è un piano obliquo
  const norm = Math.hypot(n[0], n[1], n[2]) || 1;
  if (a[i] / norm < 0.8) return 'Obliquo';
  return AXIS[i];
}

const VIEW = {
  AP: 'AP', PA: 'PA', LL: 'LL', RL: 'RL', LLD: 'LLD', RLD: 'RLD',
  LAT: 'Laterale', OBL: 'Obliqua', CC: 'CC', MLO: 'MLO',
};

/** In radiologia tradizionale il riquadro è la proiezione, non il piano. */
function projectionLabel(ds) {
  const vp = str(ds, TAG.viewPosition).toUpperCase();
  if (vp) return VIEW[vp] || vp;
  const lat = str(ds, TAG.laterality).toUpperCase();
  return lat ? `Lato ${lat}` : '';
}

const PROJECTION_MODALITIES = new Set(['CR', 'DX', 'MG', 'RF', 'XA', 'PX', 'IO']);

function describeView(ds, modality) {
  if (PROJECTION_MODALITIES.has(modality)) {
    return projectionLabel(ds) || planeFromOrientation(str(ds, TAG.orientation));
  }
  return planeFromOrientation(str(ds, TAG.orientation)) || projectionLabel(ds);
}

// ---------------------------------------------------------------- miniature

/** Riduzione a blocchi: per un riquadro di 256 px il nearest neighbour basta. */
function downscale(src, cols, rows, channels) {
  const scale = Math.min(1, CFG.thumbPx / Math.max(cols, rows));
  if (scale >= 1) return { data: src, cols, rows };

  const w = Math.max(1, Math.round(cols * scale));
  const h = Math.max(1, Math.round(rows * scale));
  const out = Buffer.allocUnsafe(w * h * channels);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(rows - 1, Math.floor((y * rows) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(cols - 1, Math.floor((x * cols) / w));
      const si = (sy * cols + sx) * channels;
      const di = (y * w + x) * channels;
      for (let c = 0; c < channels; c++) out[di + c] = src[si + c];
    }
  }
  return { data: out, cols: w, rows: h };
}

const REASON = {
  compressed: 'Immagine compressa: anteprima non disponibile',
  'no-pixel-data': 'Nessun dato immagine',
  'parse-error': 'File non interpretabile',
  'read-error': 'File non leggibile',
  truncated: 'Dati immagine incompleti',
  'too-large': 'Immagine troppo grande per l anteprima',
  palette: 'Tavolozza colore non gestita',
  'unsupported-samples': 'Formato colore non gestito',
  'unsupported-bits': 'Profondità colore non gestita',
};

/** Riquadro pronto per la finestra: pixel già ridotti, nessun percorso. */
function buildTile(group) {
  const tile = {
    id: group.id,
    series: group.number,
    description: group.description,
    modality: group.modality,
    view: group.view,
    count: group.count,
    sampleFile: path.basename(group.bestFile),
  };

  const r = decode(group.bestFile, { maxPixels: CFG.maxPixels });
  if (r.unsupported) {
    tile.note = REASON[r.unsupported] || 'Anteprima non disponibile';
    if (r.rows && r.cols) tile.fullSize = `${r.cols}×${r.rows}`;
    return tile;
  }

  tile.fullSize = `${r.cols}×${r.rows}`;
  tile.frames = r.frames || 1;

  if (r.jpeg) {
    // JPEG baseline: lo decodifica la finestra, che ha un decoder nativo
    if (r.jpeg.length > CFG.maxJpegBytes) {
      tile.note = 'Immagine compressa troppo grande per l anteprima';
      return tile;
    }
    tile.jpeg = new Uint8Array(r.jpeg);
    tile.cols = r.cols;
    tile.rows = r.rows;
    return tile;
  }

  if (r.gray) {
    const t = downscale(r.gray, r.cols, r.rows, 1);
    tile.cols = t.cols;
    tile.rows = t.rows;
    tile.gray = new Uint8Array(t.data);
  } else if (r.rgb) {
    const t = downscale(r.rgb, r.cols, r.rows, 3);
    tile.cols = t.cols;
    tile.rows = t.rows;
    tile.rgb = new Uint8Array(t.data);
  } else {
    tile.note = 'Anteprima non disponibile';
  }
  return tile;
}

function post(tile, kind) {
  const transfer = [];
  for (const k of ['gray', 'rgb', 'jpeg']) {
    if (tile[k]) transfer.push(tile[k].buffer);
  }
  parentPort.postMessage({ t: kind, tile }, transfer);
}

// ---------------------------------------------------------------- stato

const groups = new Map(); // chiave serie|proiezione -> gruppo
let scanned = 0;
let nextId = 0;
let ended = false;

function handleFile(file) {
  if (scanned >= CFG.maxScan) return;
  scanned++;

  const ds = readHeader(file);
  if (!ds) return;

  const modality = str(ds, TAG.modality).toUpperCase();
  const uid = str(ds, TAG.seriesUid) || `__dir__${path.dirname(file)}`;
  const view = describeView(ds, modality);
  const key = `${uid}|${view}`;

  let g = groups.get(key);
  if (!g) {
    if (groups.size >= CFG.maxTiles) return; // mosaico pieno: basta così
    g = {
      id: nextId++,
      key,
      number: intOf(ds, TAG.seriesNumber),
      description: str(ds, TAG.seriesDesc) || str(ds, TAG.bodyPart),
      modality,
      view,
      count: 0,
      bestFile: file,
      bestInstance: intOf(ds, TAG.instance),
      shownFile: null,
    };
    groups.set(key, g);
    g.count = 1;
    // il riquadro compare subito, con il primo file visto: l'operatore vede
    // l'anteprima riempirsi mentre la copia sta ancora andando
    g.shownFile = g.bestFile;
    post(buildTile(g), 'tile');
    return;
  }

  g.count++;
  const inst = intOf(ds, TAG.instance);
  // "prima immagine" = InstanceNumber più basso; un file senza numero cede
  // sempre a uno numerato
  if (inst != null && (g.bestInstance == null || inst < g.bestInstance)) {
    g.bestInstance = inst;
    g.bestFile = file;
  }
}

/**
 * A copia finita si sistemano i riquadri per cui, dopo la comparsa, è emerso un
 * file con InstanceNumber più basso. Solo quelli: ridecodificare tutto
 * raddoppierebbe il lavoro senza cambiare l'immagine.
 */
function finish() {
  if (ended) return;
  ended = true;
  for (const g of groups.values()) {
    try {
      if (g.bestFile !== g.shownFile) {
        g.shownFile = g.bestFile;
        post(buildTile(g), 'update');
      } else {
        parentPort.postMessage({ t: 'count', id: g.id, count: g.count });
      }
    } catch {
      // un riquadro non aggiornabile non deve far fallire gli altri
    }
  }
  parentPort.postMessage({ t: 'done', groups: groups.size, scanned });
}

parentPort.on('message', (msg) => {
  try {
    if (!msg) return;
    if (msg.t === 'files') {
      for (const f of msg.items) {
        if (ended) break;
        try {
          handleFile(f);
        } catch {
          // file singolo illeggibile o malformato: si prosegue
        }
      }
    } else if (msg.t === 'end') {
      finish();
    }
  } catch (err) {
    parentPort.postMessage({ t: 'error', message: String((err && err.message) || err) });
  }
});
