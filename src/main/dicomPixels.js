'use strict';

const fs = require('fs');
const dicomParser = require('dicom-parser');

/**
 * Decodifica di UN fotogramma per l'anteprima.
 *
 * Gira in un worker thread su file già copiati in locale, e i dati vengono da
 * un supporto del paziente: qualsiasi campo può essere incoerente o costruito
 * male. Ogni lettura è quindi limitata a quanto il buffer contiene davvero e il
 * numero di pixel è tagliato a una soglia: `Rows`/`Columns` a 65535 darebbero
 * 4,3 miliardi di pixel e un'allocazione che fa fuori il processo.
 */

// JPEG baseline / extended: non li decodifichiamo qui, ma i byte del
// fotogramma vanno passati alla finestra, che sa decodificarli da sola.
const JPEG_NATIVE = new Set(['1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51']);

function isCompressed(ts) {
  return /^1\.2\.840\.10008\.1\.2\.(4|5)/.test(ts || '');
}

function firstFloat(s) {
  if (s == null) return NaN;
  return parseFloat(String(s).split('\\')[0]);
}

/** Vista sui byte del dataset, solo se rientrano davvero nel buffer letto. */
function frameView(buf, element, need) {
  const start = element.dataOffset;
  if (!(start >= 0) || need <= 0) return null;
  if (start + need > buf.length) return null;
  return buf.subarray(start, start + need);
}

/** YBR_FULL non compresso: alcune US/XA lo usano. Conversione in RGB sul posto. */
function ybrToRgb(out) {
  for (let i = 0; i < out.length; i += 3) {
    const y = out[i];
    const cb = out[i + 1] - 128;
    const cr = out[i + 2] - 128;
    let r = y + 1.402 * cr;
    let g = y - 0.344136 * cb - 0.714136 * cr;
    let b = y + 1.772 * cb;
    out[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    out[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    out[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

/** Planar Configuration = 1: i tre piani sono separati, vanno interlacciati. */
function planarToInterleaved(src, nPix) {
  const out = Buffer.allocUnsafe(nPix * 3);
  for (let i = 0; i < nPix; i++) {
    out[i * 3] = src[i];
    out[i * 3 + 1] = src[nPix + i];
    out[i * 3 + 2] = src[2 * nPix + i];
  }
  return out;
}

/**
 * @param {string} file percorso locale (staging), non il supporto
 * @param {{maxPixels?:number, maxBytes?:number}} limits
 * @returns {{rows,cols,gray?,rgb?,jpeg?,photometric?,transferSyntax?,frames?,unsupported?}}
 */
function decode(file, limits = {}) {
  const maxPixels = limits.maxPixels || 64 * 1024 * 1024;
  const maxBytes = limits.maxBytes || 96 * 1024 * 1024;

  let buf;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { unsupported: 'read-error' };
    if (st.size > maxBytes) return { unsupported: 'too-large' };
    buf = fs.readFileSync(file);
  } catch (e) {
    return { unsupported: 'read-error', message: String((e && e.message) || e) };
  }

  let ds;
  try {
    ds = dicomParser.parseDicom(buf);
  } catch (e) {
    return { unsupported: 'parse-error', message: String((e && e.message) || e) };
  }

  let ts = '';
  let rows = 0;
  let cols = 0;
  let pixEl = null;
  try {
    ts = ds.string('x00020010') || '';
    rows = ds.uint16('x00280010') || 0;
    cols = ds.uint16('x00280011') || 0;
    pixEl = ds.elements.x7fe00010 || null;
  } catch {
    return { unsupported: 'parse-error' };
  }

  if (!rows || !cols || !pixEl) return { unsupported: 'no-pixel-data' };
  const nPix = rows * cols;
  if (nPix > maxPixels) return { unsupported: 'too-large', rows, cols };

  const frames = parseInt(ds.string('x00280008'), 10) || 1;
  const photometric = (ds.string('x00280004') || 'MONOCHROME2').trim().toUpperCase();

  // ---- compressi ---------------------------------------------------------
  if (isCompressed(ts)) {
    if (JPEG_NATIVE.has(ts)) {
      try {
        const frame = dicomParser.readEncapsulatedImageFrame(ds, pixEl, 0);
        if (frame && frame.length) {
          return { rows, cols, jpeg: Buffer.from(frame), photometric, transferSyntax: ts, frames };
        }
      } catch {
        // frammenti non interpretabili: si ricade su "compressa"
      }
    }
    return { unsupported: 'compressed', rows, cols, transferSyntax: ts, frames };
  }

  const bitsAllocated = ds.uint16('x00280100') || 16;
  const signed = (ds.uint16('x00280103') || 0) === 1;
  const spp = ds.uint16('x00280002') || 1;
  const planar = ds.uint16('x00280006') || 0;
  const slope = firstFloat(ds.string('x00281053')) || 1;
  const intercept = firstFloat(ds.string('x00281052')) || 0;

  // ---- colore non compresso ---------------------------------------------
  if (spp === 3) {
    if (bitsAllocated !== 8) return { unsupported: 'unsupported-bits', rows, cols };
    const view = frameView(buf, pixEl, nPix * 3);
    if (!view) return { unsupported: 'truncated', rows, cols };
    const out = planar === 1 ? planarToInterleaved(view, nPix) : Buffer.from(view);
    if (photometric.startsWith('YBR')) ybrToRgb(out);
    return { rows, cols, rgb: out, photometric, transferSyntax: ts, frames };
  }
  if (spp !== 1) return { unsupported: 'unsupported-samples', rows, cols };
  if (photometric.startsWith('PALETTE')) return { unsupported: 'palette', rows, cols };

  // ---- monocromatico -----------------------------------------------------
  const bytesPerPixel = bitsAllocated <= 8 ? 1 : 2;
  const view = frameView(buf, pixEl, nPix * bytesPerPixel);
  if (!view) return { unsupported: 'truncated', rows, cols };

  const read =
    bytesPerPixel === 1
      ? (i) => view[i]
      : signed
      ? (i) => view.readInt16LE(i * 2)
      : (i) => view.readUInt16LE(i * 2);

  let wc = firstFloat(ds.string('x00281050'));
  let ww = firstFloat(ds.string('x00281051'));
  if (!isFinite(wc) || !isFinite(ww) || ww <= 0) {
    // niente finestra nell'intestazione: si usa l'intervallo reale dei valori
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < nPix; i++) {
      const v = read(i) * slope + intercept;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFinite(mn) || !isFinite(mx)) return { unsupported: 'no-pixel-data', rows, cols };
    wc = (mn + mx) / 2;
    ww = Math.max(1, mx - mn);
  }

  const invert = photometric === 'MONOCHROME1';
  const lo = wc - 0.5 - (ww - 1) / 2;
  const span = ww - 1 || 1;
  const gray = Buffer.allocUnsafe(nPix);
  for (let i = 0; i < nPix; i++) {
    const v = read(i) * slope + intercept;
    let x = (v - lo) / span;
    if (x < 0) x = 0;
    else if (x > 1) x = 1;
    const g = (x * 255 + 0.5) | 0;
    gray[i] = invert ? 255 - g : g;
  }

  return { rows, cols, gray, wc, ww, photometric, transferSyntax: ts, frames };
}

module.exports = { decode, isCompressed };
