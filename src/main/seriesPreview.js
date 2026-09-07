'use strict';

const fs = require('fs');
const path = require('path');
const dicomParser = require('dicom-parser');

const { decode } = require('./dicomPixels');

// Limiti: l'anteprima serve a confermare paziente ed esame, non a refertare.
// Si legge poco e si tiene in RAM ancora meno.
const MAX_SERIES = 16; // quadranti mostrati
const MAX_SCAN = 4000; // file di cui si legge l'intestazione
const HEADER_BYTES = 128 * 1024; // lettura parziale: i tag di serie stanno all'inizio
const THUMB_MAX = 256; // lato massimo della miniatura

function walk(dir, cap) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < cap) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && !/^dicomdir$/i.test(e.name)) {
        out.push(p);
        if (out.length >= cap) break;
      }
    }
  }
  return out;
}

/**
 * Legge solo l'intestazione: si fermano il parsing ai pixel e si caricano al
 * massimo i primi KB del file. Su un supporto da migliaia di immagini leggere
 * tutto per intero costerebbe minuti.
 */
function readHeader(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (size < 132) return null;
    const len = Math.min(size, HEADER_BYTES);
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, 0);
    return dicomParser.parseDicom(buf, { untilTag: 'x7fe00010' });
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

function intOf(ds, tag) {
  const s = ds.string(tag);
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

// Riduzione a blocchi (nearest neighbour): per una miniatura è più che
// sufficiente e non richiede alcuna dipendenza.
function downscale(src, cols, rows, channels) {
  const scale = Math.min(1, THUMB_MAX / Math.max(cols, rows));
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

/**
 * Raggruppa i file per serie e restituisce, per ciascuna, la miniatura della
 * prima immagine (InstanceNumber più basso).
 *
 * @param {string} dataRoot
 * @returns {{series: object[], scanned: number, truncated: boolean}}
 */
function buildSeriesPreview(dataRoot) {
  const files = walk(dataRoot, MAX_SCAN + 1);
  const truncated = files.length > MAX_SCAN;
  const scan = truncated ? files.slice(0, MAX_SCAN) : files;

  const byUid = new Map();

  for (const f of scan) {
    const ds = readHeader(f);
    if (!ds) continue;

    const uid = ds.string('x0020000e') || `__no-uid__${path.dirname(f)}`;
    const instance = intOf(ds, 'x00200013');

    let s = byUid.get(uid);
    if (!s) {
      s = {
        uid,
        number: intOf(ds, 'x00200011'),
        description: (ds.string('x0008103e') || '').trim(),
        modality: (ds.string('x00080060') || '').trim().toUpperCase(),
        count: 0,
        firstFile: null,
        firstInstance: Infinity,
      };
      byUid.set(uid, s);
    }
    s.count++;
    // la "prima immagine" è quella con InstanceNumber minore; se il tag manca
    // si tiene la prima incontrata, che però cede a qualsiasi file numerato
    if (instance != null) {
      if (instance < s.firstInstance) {
        s.firstInstance = instance;
        s.firstFile = f;
      }
    } else if (!s.firstFile) {
      s.firstFile = f;
    }
  }

  const series = [...byUid.values()]
    .sort((a, b) => (a.number ?? 9999) - (b.number ?? 9999))
    .slice(0, MAX_SERIES);

  for (const s of series) {
    delete s.firstInstance;
    if (!s.firstFile) {
      s.unsupported = 'no-pixel-data';
      continue;
    }

    const r = decode(s.firstFile);
    s.sampleFile = path.basename(s.firstFile);

    if (r.unsupported) {
      s.unsupported = r.unsupported;
      s.rows = r.rows || null;
      s.cols = r.cols || null;
      continue;
    }

    if (r.gray) {
      const t = downscale(r.gray, r.cols, r.rows, 1);
      s.cols = t.cols;
      s.rows = t.rows;
      s.gray = t.data;
    } else if (r.rgb) {
      const t = downscale(r.rgb, r.cols, r.rows, 3);
      s.cols = t.cols;
      s.rows = t.rows;
      s.rgb = t.data;
    } else {
      s.unsupported = 'no-pixel-data';
    }
    s.fullSize = `${r.cols}×${r.rows}`;
  }

  // I percorsi restano nel main: il renderer riceve solo un indice e chiede
  // l'immagine grande per numero, non per path.
  const sampleFiles = series.map((s) => s.firstFile);
  series.forEach((s, i) => {
    s.id = i;
    delete s.firstFile;
  });

  return { series, files: sampleFiles, scanned: scan.length, truncated };
}

module.exports = { buildSeriesPreview };
