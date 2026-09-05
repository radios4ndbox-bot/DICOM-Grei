'use strict';

const fs = require('fs');
const dicomParser = require('dicom-parser');

// Transfer syntax compressi (JPEG / JPEG-LS / JPEG2000 / RLE): non decodificati qui.
function isCompressed(ts) {
  return /^1\.2\.840\.10008\.1\.2\.(4|5)/.test(ts || '');
}

function firstFloat(s) {
  if (!s) return NaN;
  return parseFloat(String(s).split('\\')[0]);
}

/**
 * Decodifica un singolo frame monocromatico non compresso in scala di grigi 8-bit,
 * applicando modality LUT (slope/intercept) e finestra (WindowCenter/WindowWidth).
 * RGB non compresso viene restituito così com'è. Tutto il resto → { unsupported }.
 *
 * @returns {{ rows, cols, gray?:Buffer, rgb?:Buffer, wc?, ww?, photometric?, unsupported? }}
 */
function decode(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { unsupported: 'read-error', message: String(e.message || e) };
  }

  let ds;
  try {
    ds = dicomParser.parseDicom(buf);
  } catch (e) {
    return { unsupported: 'parse-error', message: String(e.message || e) };
  }

  const ts = ds.string('x00020010') || '';
  const rows = ds.uint16('x00280010');
  const cols = ds.uint16('x00280011');
  const pixEl = ds.elements.x7fe00010;

  if (!rows || !cols || !pixEl) return { unsupported: 'no-pixel-data' };
  if (isCompressed(ts)) return { unsupported: 'compressed', rows, cols, transferSyntax: ts };

  const bitsAllocated = ds.uint16('x00280100') || 16;
  const signed = (ds.uint16('x00280103') || 0) === 1;
  const spp = ds.uint16('x00280002') || 1;
  const photometric = (ds.string('x00280004') || 'MONOCHROME2').trim().toUpperCase();
  const slope = firstFloat(ds.string('x00281053')) || 1;
  const intercept = firstFloat(ds.string('x00281052')) || 0;

  const base = buf.byteOffset + pixEl.dataOffset;

  // ---- RGB non compresso: passthrough
  if (spp === 3 && photometric.startsWith('RGB')) {
    const need = rows * cols * 3;
    if (pixEl.length < need) return { unsupported: 'truncated' };
    return { rows, cols, rgb: Buffer.from(buf.buffer, base, need), photometric };
  }
  if (spp !== 1) return { unsupported: 'unsupported-samples', spp, photometric };

  // ---- Monocromatico
  const nPix = rows * cols;
  let read;
  if (bitsAllocated <= 8) {
    if (pixEl.length < nPix) return { unsupported: 'truncated' };
    const u8 = new Uint8Array(buf.buffer, base, nPix);
    read = (i) => u8[i];
  } else {
    if (pixEl.length < nPix * 2) return { unsupported: 'truncated' };
    const dv = new DataView(buf.buffer, base, nPix * 2);
    read = signed ? (i) => dv.getInt16(i * 2, true) : (i) => dv.getUint16(i * 2, true);
  }

  let wc = firstFloat(ds.string('x00281050'));
  let ww = firstFloat(ds.string('x00281051'));
  if (!isFinite(wc) || !isFinite(ww) || ww <= 0) {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < nPix; i++) {
      const v = read(i) * slope + intercept;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    wc = (mn + mx) / 2;
    ww = Math.max(1, mx - mn);
  }

  const invert = photometric === 'MONOCHROME1';
  const lo = wc - 0.5 - (ww - 1) / 2;
  const gray = Buffer.allocUnsafe(nPix);
  for (let i = 0; i < nPix; i++) {
    const v = read(i) * slope + intercept;
    let x = (v - lo) / (ww - 1 || 1);
    if (x < 0) x = 0;
    else if (x > 1) x = 1;
    let g = Math.round(x * 255);
    if (invert) g = 255 - g;
    gray[i] = g;
  }

  return { rows, cols, gray, wc, ww, photometric, transferSyntax: ts };
}

module.exports = { decode };
