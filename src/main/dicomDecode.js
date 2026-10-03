'use strict';

const fs = require('fs');
const zlib = require('zlib');
const dicomParser = require('dicom-parser');

/**
 * Decodifica di un fotogramma per il VIEWER: restituisce i valori originali
 * (8 o 16 bit, con segno se il file lo dichiara), non un'immagine già
 * finestrata. Finestra e livello si applicano nella finestra del viewer, e per
 * poterli cambiare servono i valori veri.
 *
 * (dicomPixels.js fa un altro mestiere: miniature a 8 bit per l'anteprima
 * durante la copia, senza codec. Resta com'è.)
 *
 * Gira in un worker thread. I file vengono dall'archivio, cioè da un supporto
 * del paziente: ogni campo può essere incoerente. Dimensioni e offset sono
 * controllati contro il buffer letto e il numero di pixel è limitato.
 *
 * Formati:
 *   non compressi (implicit/explicit little endian, big endian, deflated)
 *   RLE Lossless                          (qui sotto)
 *   JPEG Lossless, processo 14 e SV1      jpeg-lossless-decoder-js
 *   JPEG baseline 8 bit                   libjpeg-turbo (wasm)
 *   JPEG-LS lossless e near-lossless      CharLS (wasm)
 *   JPEG 2000 lossless e lossy            OpenJPEG (wasm)
 * Gli stessi tre motori (libjpeg, CharLS, OpenJPEG) dei viewer commerciali.
 */

const TS = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  DEFLATED: '1.2.840.10008.1.2.1.99',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
  JPEG_BASELINE: '1.2.840.10008.1.2.4.50',
  JPEG_EXTENDED: '1.2.840.10008.1.2.4.51',
  JPEG_LOSSLESS: '1.2.840.10008.1.2.4.57',
  JPEG_LOSSLESS_SV1: '1.2.840.10008.1.2.4.70',
  JPEGLS_LOSSLESS: '1.2.840.10008.1.2.4.80',
  JPEGLS_NEAR: '1.2.840.10008.1.2.4.81',
  J2K_LOSSLESS: '1.2.840.10008.1.2.4.90',
  J2K: '1.2.840.10008.1.2.4.91',
  RLE: '1.2.840.10008.1.2.5',
};

const NATIVE = new Set([TS.IMPLICIT_LE, TS.EXPLICIT_LE, TS.DEFLATED, TS.EXPLICIT_BE, '']);

const TS_NAME = {
  [TS.JPEG_BASELINE]: 'JPEG baseline',
  [TS.JPEG_EXTENDED]: 'JPEG esteso 12 bit',
  [TS.JPEG_LOSSLESS]: 'JPEG Lossless',
  [TS.JPEG_LOSSLESS_SV1]: 'JPEG Lossless',
  [TS.JPEGLS_LOSSLESS]: 'JPEG-LS',
  [TS.JPEGLS_NEAR]: 'JPEG-LS',
  [TS.J2K_LOSSLESS]: 'JPEG 2000',
  [TS.J2K]: 'JPEG 2000',
  [TS.RLE]: 'RLE',
};

// 64 Mpx: una radiografia grande ne ha 10–15, una mammografia 30
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 1536 * 1024 * 1024;

function fail(code, extra) {
  return { error: code, ...(extra || {}) };
}

function floats(s, n) {
  if (s == null) return null;
  const v = String(s).split('\\').map(parseFloat);
  if (v.length < n || v.slice(0, n).some((x) => !isFinite(x))) return null;
  return v.slice(0, n);
}

function firstFloat(s) {
  const v = floats(s, 1);
  return v ? v[0] : NaN;
}

// ---- moduli wasm, caricati una volta sola e solo se servono ---------------

const loaded = {};
function codec(name) {
  // OpenJPEG scrive tre righe "[INFO]" per ogni immagine: zittite
  if (!loaded[name]) loaded[name] = require(name)({ print() {}, printErr() {} });
  return loaded[name];
}

/** Decoder wasm di cornerstone: stessa forma per CharLS, OpenJPEG e libjpeg-turbo. */
async function wasmDecode(moduleName, className, data) {
  const m = await codec(moduleName);
  const dec = new m[className]();
  try {
    dec.getEncodedBuffer(data.length).set(data);
    dec.decode();
    const info = dec.getFrameInfo();
    // il buffer è una vista sulla memoria wasm: va copiato prima di liberare
    const out = new Uint8Array(dec.getDecodedBuffer());
    return { info, bytes: out };
  } finally {
    dec.delete();
  }
}

// ---- RLE Lossless (PS3.5 allegato G) --------------------------------------

function rleDecode(frame, rows, cols, samples, bytesPerSample) {
  if (frame.length < 64) throw new Error('intestazione RLE troncata');
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const nSeg = dv.getUint32(0, true);
  const expected = samples * bytesPerSample;
  if (nSeg !== expected) throw new Error(`segmenti RLE ${nSeg}, attesi ${expected}`);
  const nPix = rows * cols;
  const out = new Uint8Array(nPix * expected);

  for (let s = 0; s < nSeg; s++) {
    let p = dv.getUint32(4 + s * 4, true);
    const end = s + 1 < nSeg ? dv.getUint32(8 + s * 4, true) : frame.length;
    if (!(p >= 64) || end > frame.length || p > end) throw new Error('offset RLE fuori dal fotogramma');
    // I segmenti sono per byte, dal più significativo: in uscita little endian
    // (e per il colore interlacciato per pixel).
    const sample = Math.floor(s / bytesPerSample);
    const byteInSample = bytesPerSample - 1 - (s % bytesPerSample);
    const stride = expected;
    const base = sample * bytesPerSample + byteInSample;
    let n = 0;
    while (p < end && n < nPix) {
      const h = frame[p++];
      if (h < 128) {
        for (let k = 0; k <= h && p < end && n < nPix; k++) out[n++ * stride + base] = frame[p++];
      } else if (h > 128) {
        const v = frame[p++];
        for (let k = 0; k < 257 - h && n < nPix; k++) out[n++ * stride + base] = v;
      }
    }
  }
  return out;
}

// ---- fotogramma incapsulato -----------------------------------------------

function encapsulatedFrame(ds, el, frame, frames) {
  if (el.basicOffsetTable && el.basicOffsetTable.length) {
    return dicomParser.readEncapsulatedImageFrame(ds, el, frame);
  }
  const nFrag = el.fragments ? el.fragments.length : 0;
  if (!nFrag) throw new Error('nessun frammento');
  // un solo fotogramma: tutti i frammenti gli appartengono
  if (frames <= 1) return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, 0, nFrag);
  // un frammento per fotogramma, il caso comune senza tabella degli offset
  if (nFrag === frames) return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, frame);
  // JPEG multi-frammento: la tabella si ricostruisce dai marcatori di fine immagine
  const bot = dicomParser.createJPEGBasicOffsetTable(ds, el);
  return dicomParser.readEncapsulatedImageFrame(ds, el, frame, bot);
}

// ---- conversioni ----------------------------------------------------------

function ybrToRgb(px) {
  for (let i = 0; i + 2 < px.length; i += 3) {
    const y = px[i];
    const cb = px[i + 1] - 128;
    const cr = px[i + 2] - 128;
    const r = y + 1.402 * cr;
    const g = y - 0.344136 * cb - 0.714136 * cr;
    const b = y + 1.772 * cb;
    px[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    px[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    px[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

function planarToInterleaved(src, nPix) {
  const out = new Uint8Array(nPix * 3);
  for (let i = 0; i < nPix; i++) {
    out[i * 3] = src[i];
    out[i * 3 + 1] = src[nPix + i];
    out[i * 3 + 2] = src[2 * nPix + i];
  }
  return out;
}

/** Byte little endian -> Int16Array/Uint16Array allineato, con maschera e segno. */
function toWords(bytes, nPix, signed, bitsStored, bigEndian) {
  const src = new Uint8Array(nPix * 2);
  src.set(bytes.subarray(0, nPix * 2));
  if (bigEndian) {
    for (let i = 0; i < src.length; i += 2) {
      const t = src[i];
      src[i] = src[i + 1];
      src[i + 1] = t;
    }
  }
  const out = signed ? new Int16Array(src.buffer) : new Uint16Array(src.buffer);
  // Bit oltre BitsStored: possono contenere overlay o rumore. Si azzerano, e
  // per i dati con segno si estende il segno da BitsStored.
  if (bitsStored > 0 && bitsStored < 16) {
    const mask = (1 << bitsStored) - 1;
    if (signed) {
      const sign = 1 << (bitsStored - 1);
      for (let i = 0; i < out.length; i++) {
        const v = out[i] & mask;
        out[i] = v & sign ? v - (1 << bitsStored) : v;
      }
    } else {
      for (let i = 0; i < out.length; i++) out[i] &= mask;
    }
  }
  return out;
}

/** Intestazione utile al viewer, anche senza pixel (per i messaggi d'errore). */
function describe(ds) {
  const ts = (ds.string('x00020010') || '').trim();
  return {
    transferSyntax: ts,
    rows: ds.uint16('x00280010') || 0,
    cols: ds.uint16('x00280011') || 0,
    frames: parseInt(ds.string('x00280008'), 10) || 1,
    samples: ds.uint16('x00280002') || 1,
    photometric: (ds.string('x00280004') || 'MONOCHROME2').trim().toUpperCase(),
    bitsAllocated: ds.uint16('x00280100') || 16,
    bitsStored: ds.uint16('x00280101') || 0,
    signed: (ds.uint16('x00280103') || 0) === 1,
    planar: ds.uint16('x00280006') || 0,
  };
}

function parse(buf) {
  return dicomParser.parseDicom(buf, {
    // Deflated Explicit VR: il dataset è compresso con deflate "raw"
    inflater: (arr, pos) => {
      const inflated = zlib.inflateRawSync(arr.subarray(pos));
      const full = new Uint8Array(pos + inflated.length);
      full.set(arr.subarray(0, pos), 0);
      full.set(inflated, pos);
      return full;
    },
  });
}

/**
 * @param {string} file
 * @param {number} frame  indice del fotogramma, da 0
 * @returns {Promise<object>} { rows, cols, samples, pixels (TypedArray), ... } oppure { error }
 */
async function decodeFrame(file, frame = 0) {
  let buf;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return fail('lettura');
    if (st.size > MAX_FILE_BYTES) return fail('troppo-grande');
    buf = fs.readFileSync(file);
  } catch (e) {
    return fail('lettura', { message: String((e && e.message) || e) });
  }

  let ds;
  let d;
  let el;
  try {
    ds = parse(buf);
    d = describe(ds);
    el = ds.elements.x7fe00010 || null;
  } catch (e) {
    return fail('non-dicom', { message: String((e && e.message) || e) });
  }

  const { rows, cols, frames, samples, transferSyntax: ts } = d;
  if (!rows || !cols || !el) return fail('senza-immagine');
  const nPix = rows * cols;
  if (nPix > MAX_PIXELS) return fail('troppo-grande', { rows, cols });
  if (!(frame >= 0 && frame < frames)) return fail('fotogramma', { frames });
  if (samples !== 1 && samples !== 3) return fail('campioni', { samples });
  if (d.bitsAllocated !== 8 && d.bitsAllocated !== 16) return fail('bit', { bits: d.bitsAllocated });
  if (samples === 3 && d.bitsAllocated !== 8) return fail('bit', { bits: d.bitsAllocated });
  if (d.photometric.startsWith('PALETTE')) return fail('tavolozza');

  const bytesPerSample = d.bitsAllocated / 8;
  const bitsStored = d.bitsStored || d.bitsAllocated;
  let signed = d.signed;
  let pixels;
  let rgbReady = false; // il codec ha già restituito RGB

  try {
    if (NATIVE.has(ts)) {
      // ---- non compresso ----
      const frameBytes = nPix * samples * bytesPerSample;
      // dopo deflate il dataset vive nel buffer del parser, non in quello letto
      const src = ds.byteArray;
      const start = el.dataOffset + frame * frameBytes;
      if (!(start >= 0) || start + frameBytes > src.length) return fail('troncato', { rows, cols });
      const view = src.subarray(start, start + frameBytes);
      if (samples === 3) {
        pixels = d.planar === 1 ? planarToInterleaved(view, nPix) : new Uint8Array(view);
      } else if (bytesPerSample === 1) {
        pixels = new Uint8Array(view);
      } else {
        pixels = toWords(view, nPix, signed, bitsStored, ts === TS.EXPLICIT_BE);
      }
    } else {
      // ---- incapsulato ----
      const data = encapsulatedFrame(ds, el, frame, frames);
      let bytes;

      if (ts === TS.RLE) {
        bytes = rleDecode(data, rows, cols, samples, bytesPerSample);
        // RLE del colore: i segmenti sono già stati interlacciati per pixel
      } else if (ts === TS.JPEG_LOSSLESS || ts === TS.JPEG_LOSSLESS_SV1) {
        const { Decoder } = require('jpeg-lossless-decoder-js');
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        bytes = new Uint8Array(new Decoder().decompress(ab, 0, ab.byteLength));
      } else if (ts === TS.JPEGLS_LOSSLESS || ts === TS.JPEGLS_NEAR) {
        const r = await wasmDecode('@cornerstonejs/codec-charls/decodewasmjs', 'JpegLSDecoder', data);
        bytes = r.bytes;
        if (r.info.width !== cols || r.info.height !== rows) return fail('incoerente', { rows, cols });
      } else if (ts === TS.J2K_LOSSLESS || ts === TS.J2K) {
        const r = await wasmDecode('@cornerstonejs/codec-openjpeg/decodewasmjs', 'J2KDecoder', data);
        bytes = r.bytes;
        if (r.info.width !== cols || r.info.height !== rows) return fail('incoerente', { rows, cols });
        // il segno vero è quello del codestream: l'intestazione DICOM a volte lo sbaglia
        if (samples === 1) signed = !!r.info.isSigned;
        rgbReady = samples === 3; // OpenJPEG applica già la trasformata colore
      } else if (ts === TS.JPEG_BASELINE) {
        const r = await wasmDecode('@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs', 'JPEGDecoder', data);
        bytes = r.bytes;
        if (r.info.width !== cols || r.info.height !== rows) return fail('incoerente', { rows, cols });
        rgbReady = samples === 3; // libjpeg converte YCbCr in RGB
      } else {
        return fail('compressione', { transferSyntax: ts, name: TS_NAME[ts] || ts, rows, cols });
      }

      const need = nPix * samples * bytesPerSample;
      if (bytes.length < need) return fail('troncato', { rows, cols });
      if (samples === 3) pixels = bytes.length === need ? bytes : bytes.slice(0, need);
      else if (bytesPerSample === 1) pixels = bytes.length === need ? bytes : bytes.slice(0, need);
      else pixels = toWords(bytes, nPix, signed, bitsStored, false);
    }
  } catch (e) {
    return fail('decodifica', {
      transferSyntax: ts,
      name: TS_NAME[ts] || '',
      message: String((e && e.message) || e),
      rows,
      cols,
    });
  }

  if (samples === 3 && !rgbReady && d.photometric.startsWith('YBR') && d.photometric !== 'YBR_RCT' && d.photometric !== 'YBR_ICT') {
    if (d.photometric === 'YBR_FULL_422' && NATIVE.has(ts)) return fail('colore', { photometric: d.photometric });
    ybrToRgb(pixels);
  }

  const wc = floats(ds.string('x00281050'), 1);
  const ww = floats(ds.string('x00281051'), 1);
  const ps = floats(ds.string('x00280030'), 2);
  const ips = floats(ds.string('x00181164'), 2);

  return {
    rows,
    cols,
    samples,
    frames,
    signed,
    bitsStored,
    pixels,
    photometric: d.photometric,
    invert: d.photometric === 'MONOCHROME1',
    slope: firstFloat(ds.string('x00281053')) || 1,
    intercept: firstFloat(ds.string('x00281052')) || 0,
    wc: wc && ww && ww[0] > 0 ? wc[0] : null,
    ww: wc && ww && ww[0] > 0 ? ww[0] : null,
    // PixelSpacing è nel paziente; ImagerPixelSpacing è sul rivelatore (RX):
    // lì le misure sono ingrandite, e il viewer lo dice.
    spacing: ps || ips || null,
    spacingKind: ps ? 'paziente' : ips ? 'rivelatore' : null,
    transferSyntax: ts,
    lossy:
      (ds.string('x00282110') || '').trim() === '01' ||
      ts === TS.JPEG_BASELINE ||
      ts === TS.JPEGLS_NEAR ||
      ts === TS.J2K,
  };
}

module.exports = { decodeFrame, TS, TS_NAME };
