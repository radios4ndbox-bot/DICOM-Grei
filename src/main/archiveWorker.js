'use strict';

/**
 * Worker dell'archivio: porta uno staging dentro una cartella dell'archivio e
 * ne costruisce l'indice (paziente, studio, serie, ordine delle immagini).
 *
 * Fuori dal main perché sono migliaia di aperture di file: nel main la
 * finestra si congelerebbe per secondi.
 *
 * I file entrano come collegamenti fisici (hard link): stesso volume, nessun
 * byte copiato, e lo staging può essere svuotato senza toccare l'archivio. Se
 * il collegamento non è possibile (altro volume, file system senza hard link)
 * si copia.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parentPort, workerData } = require('worker_threads');
const dicomParser = require('dicom-parser');

const HEADER_STEPS = [128 * 1024, 4 * 1024 * 1024];

function parseHeader(file, size) {
  const opts = {
    untilTag: 'x7fe00010',
    inflater: (arr, pos) => {
      const inflated = zlib.inflateRawSync(arr.subarray(pos));
      const full = new Uint8Array(pos + inflated.length);
      full.set(arr.subarray(0, pos), 0);
      full.set(inflated, pos);
      return full;
    },
  };
  for (const step of HEADER_STEPS) {
    const want = Math.min(size, step);
    let fd;
    try {
      const buf = Buffer.allocUnsafe(want);
      fd = fs.openSync(file, 'r');
      const read = fs.readSync(fd, buf, 0, want, 0);
      return dicomParser.parseDicom(buf.subarray(0, read), opts);
    } catch {
      // intestazione più lunga del blocco letto: si riprova più in grande
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
    if (want >= size) break;
  }
  return null;
}

const str = (ds, tag) => {
  try {
    return (ds.string(tag) || '').trim();
  } catch {
    return '';
  }
};
const u16 = (ds, tag) => {
  try {
    return ds.uint16(tag) || 0;
  } catch {
    return 0;
  }
};
function floats(s, n) {
  if (!s) return null;
  const v = s.split('\\').map(parseFloat);
  if (v.length < n || v.slice(0, n).some((x) => !isFinite(x))) return null;
  return v.slice(0, n);
}
const int = (s) => {
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
};

function formatDate(d) {
  return /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : d;
}
function formatName(raw) {
  const parts = String(raw || '').split('^');
  return [parts[0], parts[1]].map((s) => (s || '').trim()).filter(Boolean).join(' ') || String(raw || '').trim();
}

function normalOf(iop) {
  const [a, b, c, d, e, f] = iop;
  return [b * f - c * e, c * d - a * f, a * e - b * d];
}

/** Piano della serie, dall'asse dominante della normale. */
function planeOf(iop) {
  if (!iop) return '';
  const n = normalOf(iop).map(Math.abs);
  const m = Math.max(...n);
  if (m < 0.9) return 'Obliqua';
  return n[2] === m ? 'Assiale' : n[1] === m ? 'Coronale' : 'Sagittale';
}

function run() {
  const { sources, destDir, meta } = workerData;
  const filesDir = path.join(destDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const groups = new Map(); // serie+geometria -> gruppo
  let patient = null;
  let study = null;
  let bytes = 0;
  let nonImage = 0;
  let unreadable = 0;
  let linked = 0;
  let copied = 0;

  sources.forEach((src, i) => {
    // nomi neutri: quello sul supporto può contenere il nome del paziente
    const name = String(i + 1).padStart(6, '0') + '.dcm';
    const dest = path.join(filesDir, name);
    let size = 0;
    try {
      try {
        fs.linkSync(src, dest);
        linked++;
      } catch {
        fs.copyFileSync(src, dest);
        copied++;
      }
      size = fs.statSync(dest).size;
      bytes += size;
    } catch {
      unreadable++;
      return;
    }

    const ds = size >= 132 ? parseHeader(dest, size) : null;
    if (!ds) {
      unreadable++;
      return;
    }

    if (!patient) {
      const p = {
        name: formatName(str(ds, 'x00100010')),
        id: str(ds, 'x00100020'),
        birth: formatDate(str(ds, 'x00100030')),
        sex: str(ds, 'x00100040'),
      };
      if (p.name || p.id) patient = p;
    }
    if (!study) {
      const s = {
        uid: str(ds, 'x0020000d'),
        date: formatDate(str(ds, 'x00080020')),
        description: str(ds, 'x00081030'),
        accession: str(ds, 'x00080050'),
      };
      if (s.uid || s.date) study = s;
    }

    const rows = u16(ds, 'x00280010');
    const cols = u16(ds, 'x00280011');
    if (!rows || !cols) {
      nonImage++; // referti strutturati, PDF incapsulati, stati di presentazione
      return;
    }

    const iop = floats(str(ds, 'x00200037'), 6);
    const ipp = floats(str(ds, 'x00200032'), 3);
    const seriesUid = str(ds, 'x0020000e') || 'senza-serie';
    // Nella stessa serie possono convivere geometrie diverse (scout e fette,
    // assiali e ricostruzioni): ognuna è una pila a sé, altrimenti scorrendo
    // si salterebbe da un piano all'altro.
    const orient = iop ? normalOf(iop).map((x) => x.toFixed(1)).join(',') : '-';
    const key = `${seriesUid}|${rows}x${cols}|${orient}`;

    let g = groups.get(key);
    if (!g) {
      g = {
        uid: seriesUid,
        number: int(str(ds, 'x00200011')),
        description: str(ds, 'x0008103e'),
        modality: str(ds, 'x00080060').toUpperCase(),
        bodyPart: str(ds, 'x00180015'),
        rows,
        cols,
        iop,
        plane: planeOf(iop),
        spacing: floats(str(ds, 'x00280030'), 2) || floats(str(ds, 'x00181164'), 2),
        thickness: floats(str(ds, 'x00180050'), 1),
        images: [],
      };
      g.thickness = g.thickness ? g.thickness[0] : null;
      groups.set(key, g);
    }

    const frames = int(str(ds, 'x00280008')) || 1;
    const inst = int(str(ds, 'x00200013'));
    for (let fr = 0; fr < frames; fr++) {
      g.images.push({ f: name, fr, n: inst, p: ipp });
    }

    if ((i + 1) % 100 === 0) parentPort.postMessage({ type: 'progress', done: i + 1, total: sources.length });
  });

  const series = [...groups.values()];
  for (const g of series) {
    const normal = g.iop ? normalOf(g.iop) : null;
    const spatial = normal && g.images.every((im) => im.p);
    if (spatial) {
      // posizione lungo la normale; a parità (multi-fotogramma) l'ordine dei fotogrammi
      const pos = (im) => im.p[0] * normal[0] + im.p[1] * normal[1] + im.p[2] * normal[2];
      g.images.sort((a, b) => pos(a) - pos(b) || a.fr - b.fr);
      // il verso resta quello dei numeri di istanza, che è quello che il
      // medico si aspetta dallo scanner
      const first = g.images[0].n;
      const last = g.images[g.images.length - 1].n;
      if (first != null && last != null && first > last) g.images.reverse();
      g.images.forEach((im) => {
        im.l = Math.round(pos(im) * 100) / 100;
      });
    } else {
      g.images.sort((a, b) => (a.n == null ? 1e9 : a.n) - (b.n == null ? 1e9 : b.n) || a.f.localeCompare(b.f) || a.fr - b.fr);
    }
    // nell'indice resta solo la quota lungo la normale: basta per scorrere due
    // serie in sincronia, e tre numeri per immagine triplicano il file
    g.images.forEach((im) => {
      delete im.p;
    });
    g.spatial = !!spatial;
    g.count = g.images.length;
  }
  series.sort((a, b) => (a.number == null ? 1e9 : a.number) - (b.number == null ? 1e9 : b.number) || b.count - a.count);
  series.forEach((g, i) => {
    g.key = 's' + i;
  });

  const imageCount = series.reduce((n, g) => n + g.count, 0);
  const full = {
    ...meta,
    patient: patient || { name: '', id: '', birth: '', sex: '' },
    study: study || { uid: '', date: '', description: '', accession: '' },
    modalities: [...new Set(series.map((g) => g.modality).filter(Boolean))],
    seriesCount: series.length,
    imageCount,
    fileCount: sources.length - unreadable,
    nonImage,
    unreadable,
    bytes,
  };

  // meta.json: quello che serve all'elenco. index.json: tutto, per il viewer.
  fs.writeFileSync(path.join(destDir, 'index.json'), JSON.stringify({ ...full, series }));
  fs.writeFileSync(path.join(destDir, 'meta.json'), JSON.stringify(full, null, 1));
  parentPort.postMessage({ type: 'done', meta: full, linked, copied });
}

try {
  run();
} catch (err) {
  parentPort.postMessage({ type: 'error', message: String((err && err.message) || err) });
}
