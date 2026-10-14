'use strict';

/**
 * Studi DICOM sintetici per le prove. Nessun dato reale: un "paziente" di
 * prova con densità plausibili, così misure e finestre hanno valori attesi.
 *
 *   node test/fantoccio.js            -> test/.dati/studio   (62 file, 4 serie)
 *                                        test/.dati/studio2  (lo stesso, compresso, altro studio)
 *
 * studio:  RX torace MONOCHROME1 (spaziatura sul rivelatore), TC assiale 40
 *          fette 256x256 12 bit con intercetta -1024, MPR coronale 16 bit con
 *          segno, eco a colori 12 fotogrammi RGB.
 * studio2: TC e MPR in JPEG Lossless, RX in JPEG-LS (serve DCMTK: DCMTK_BIN o
 *          la cartella in Download), con UID dello studio e paziente diversi.
 *
 * Valori noti del fantoccio: aria -1000 HU, vertebra 700 HU (diametro 34 mm,
 * centro a y = +62 mm), polmone circa -820 HU, nodulo 35 HU (raggio 11 mm,
 * fetta z = 120 mm, cioè la 25), aorta con contrasto 180 HU.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DATI = path.join(__dirname, '.dati');
const ROOT = '1.2.826.0.1.3680043.2.1125.77';
const DCMTK = process.env.DCMTK_BIN || path.join(os.homedir(), 'Downloads', 'dcmtk-3.7.0-win64-dynamic', 'bin');

// ---- scrittore DICOM minimo, Explicit VR Little Endian --------------------
const LONG = new Set(['OB', 'OW', 'SQ', 'UN', 'UT']);
function el(tag, vr, value) {
  let v;
  if (Buffer.isBuffer(value)) v = value;
  else if (vr === 'US') { v = Buffer.alloc(2); v.writeUInt16LE(value); }
  else if (vr === 'UL') { v = Buffer.alloc(4); v.writeUInt32LE(value); }
  else v = Buffer.from(String(value), 'latin1');
  if (v.length % 2) v = Buffer.concat([v, Buffer.from(vr === 'UI' ? '\0' : ' ')]);
  const [g, e] = tag;
  const head = Buffer.alloc(LONG.has(vr) ? 12 : 8);
  head.writeUInt16LE(g, 0); head.writeUInt16LE(e, 2); head.write(vr, 4, 'latin1');
  if (LONG.has(vr)) head.writeUInt32LE(v.length, 8); else head.writeUInt16LE(v.length, 6);
  return Buffer.concat([head, v]);
}

function write(file, a, study) {
  const meta = Buffer.concat([
    el([2, 1], 'OB', Buffer.from([0, 1])),
    el([2, 2], 'UI', a.sopClass),
    el([2, 3], 'UI', a.sop),
    el([2, 0x10], 'UI', '1.2.840.10008.1.2.1'),
    el([2, 0x12], 'UI', ROOT + '.0'),
  ]);
  const ds = [
    el([8, 8], 'CS', 'ORIGINAL\\PRIMARY\\AXIAL'),
    el([8, 0x16], 'UI', a.sopClass),
    el([8, 0x18], 'UI', a.sop),
    el([8, 0x20], 'DA', '20260928'),
    el([8, 0x30], 'TM', '101500'),
    el([8, 0x50], 'SH', 'PROVA0001'),
    el([8, 0x60], 'CS', a.modality),
    el([8, 0x1030], 'LO', 'STUDIO DI PROVA - TC TORACE ADDOME'),
    el([8, 0x103e], 'LO', a.seriesDesc),
    el([0x10, 0x10], 'PN', 'PROVA^PAZIENTE SINTETICO'),
    el([0x10, 0x20], 'LO', 'TEST-0001'),
    el([0x10, 0x30], 'DA', '19500101'),
    el([0x10, 0x40], 'CS', 'O'),
  ];
  if (a.thickness) ds.push(el([0x18, 0x50], 'DS', a.thickness));
  if (a.imagerSpacing) ds.push(el([0x18, 0x1164], 'DS', a.imagerSpacing));
  ds.push(el([0x20, 0xd], 'UI', study), el([0x20, 0xe], 'UI', a.series),
    el([0x20, 0x11], 'IS', a.seriesNumber), el([0x20, 0x13], 'IS', a.instance));
  if (a.ipp) ds.push(el([0x20, 0x32], 'DS', a.ipp.join('\\')), el([0x20, 0x37], 'DS', a.iop.join('\\')));
  ds.push(el([0x28, 2], 'US', a.samples || 1), el([0x28, 4], 'CS', a.photometric || 'MONOCHROME2'));
  if (a.samples === 3) ds.push(el([0x28, 6], 'US', 0));
  if (a.frames) ds.push(el([0x28, 8], 'IS', a.frames));
  ds.push(el([0x28, 0x10], 'US', a.rows), el([0x28, 0x11], 'US', a.cols));
  if (a.spacing) ds.push(el([0x28, 0x30], 'DS', a.spacing));
  ds.push(el([0x28, 0x100], 'US', a.bits), el([0x28, 0x101], 'US', a.stored), el([0x28, 0x102], 'US', a.stored - 1),
    el([0x28, 0x103], 'US', a.signed ? 1 : 0));
  if (a.wc != null) ds.push(el([0x28, 0x1050], 'DS', a.wc), el([0x28, 0x1051], 'DS', a.ww));
  if (a.intercept != null) ds.push(el([0x28, 0x1052], 'DS', a.intercept), el([0x28, 0x1053], 'DS', a.slope || 1));
  ds.push(el([0x7fe0, 0x10], a.bits === 8 ? 'OB' : 'OW', a.pixels));
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), el([2, 0], 'UL', meta.length), meta, ...ds]));
}

// ---- fantoccio: torace/addome con densità plausibili (HU) ------------------
function hu(x, y, z) { // mm, origine al centro
  const body = (x / 150) ** 2 + (y / 105) ** 2;
  if (body > 1) return -1000;                          // aria
  if (body > 0.93) return -90;                         // grasso sottocutaneo
  if (x * x + (y - 62) ** 2 < 17 * 17) return (x * x + (y - 62) ** 2 < 8 * 8) ? 30 : 700; // vertebra + canale
  if (z > 80) {                                        // torace: polmoni
    const l = ((x + 68) / 52) ** 2 + ((y + 8) / 68) ** 2, r = ((x - 68) / 52) ** 2 + ((y + 8) / 68) ** 2;
    if (l < 1 || r < 1) {
      if ((x - 78) ** 2 + (y + 20) ** 2 + (z - 120) ** 2 < 11 * 11) return 35;  // nodulo polmonare
      return -820 + ((Math.sin(x / 3) * Math.cos(y / 4)) * 40 | 0);
    }
    if (x * x / 900 + (y + 15) ** 2 / 1200 < 1) return 45;                     // mediastino
  } else {
    if ((x + 55) ** 2 / 3600 + (y + 10) ** 2 / 2500 < 1) {                     // fegato
      if ((x + 70) ** 2 + (y + 5) ** 2 + (z - 40) ** 2 < 14 * 14) return 20;   // lesione ipodensa
      return 62;
    }
    if ((x - 30) ** 2 + (y - 55) ** 2 < 9 * 9) return 180;                     // aorta con contrasto
    if ((x - 80) ** 2 / 900 + (y - 20) ** 2 / 1600 < 1) return 48;             // milza
  }
  return 38 + ((x * 7 + y * 13 + z * 3) % 9) - 4;                              // tessuto molle
}

/**
 * @param {string} out cartella di destinazione (viene ricreata)
 * @param {{n?:number, slices?:number, sp?:number, dz?:number, study?:string, solo?:'ct'}} o
 */
function genera(out, o = {}) {
  const N = o.n || 256, SLICES = o.slices || 40, SP = o.sp || 1.4, DZ = o.dz || 5;
  const study = o.study || ROOT + '.1';
  const uid = (s, i) => `${study}.${s}.${i}`;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // serie 2: TC assiale, 12 bit senza segno, intercetta -1024
  for (let k = 0; k < SLICES; k++) {
    const z = k * DZ;
    const px = Buffer.alloc(N * N * 2);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      px.writeUInt16LE(Math.max(0, Math.min(4095, hu((c - N / 2) * SP, (r - N / 2) * SP, z) + 1024)), (r * N + c) * 2);
    }
    write(path.join(out, `ax_${String(k + 1).padStart(3, '0')}`), {
      sopClass: '1.2.840.10008.5.1.4.1.1.2', sop: uid(2, k + 1), modality: 'CT', seriesDesc: 'ASSIALE 5 mm MDC',
      series: uid(2, 0), seriesNumber: 2, instance: k + 1, thickness: DZ,
      ipp: [-N / 2 * SP, -N / 2 * SP, z], iop: [1, 0, 0, 0, 1, 0],
      rows: N, cols: N, spacing: `${SP}\\${SP}`, bits: 16, stored: 12, signed: false,
      wc: 40, ww: 400, intercept: -1024, pixels: px,
    }, study);
  }
  if (o.solo === 'ct') return;

  // serie 3: ricostruzione coronale, 16 bit con segno
  const CR = 100, CC = N;
  for (let k = 0; k < 20; k++) {
    const y = -70 + k * 7;
    const px = Buffer.alloc(CR * CC * 2);
    for (let r = 0; r < CR; r++) for (let c = 0; c < CC; c++) px.writeInt16LE(hu((c - CC / 2) * SP, y, (CR - 1 - r) * 2), (r * CC + c) * 2);
    write(path.join(out, `cor_${String(k + 1).padStart(3, '0')}`), {
      sopClass: '1.2.840.10008.5.1.4.1.1.2', sop: uid(3, k + 1), modality: 'CT', seriesDesc: 'MPR CORONALE',
      series: uid(3, 0), seriesNumber: 3, instance: k + 1, thickness: 7,
      ipp: [-CC / 2 * SP, y, (CR - 1) * 2], iop: [1, 0, 0, 0, 0, -1],
      rows: CR, cols: CC, spacing: `2\\${SP}`, bits: 16, stored: 16, signed: true,
      wc: 40, ww: 400, intercept: 0, pixels: px,
    }, study);
  }

  // serie 1: RX torace, MONOCHROME1, spaziatura sul rivelatore
  {
    const R = 700, C = 600, px = Buffer.alloc(R * C * 2);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const x = (c - C / 2) / (C / 2), y = (r - R / 2) / (R / 2);
      let v = 600;
      if (Math.abs(x) < 0.85) v = 2400;
      if (((x + 0.42) / 0.33) ** 2 + (y / 0.7) ** 2 < 1 || ((x - 0.42) / 0.33) ** 2 + (y / 0.7) ** 2 < 1) v = 1100;
      if (Math.abs(x) < 0.07) v = 3300;
      if (Math.abs(((y + 1) * 9) % 1 - 0.5) < 0.07 && Math.abs(x) < 0.8) v += 350;
      px.writeUInt16LE(Math.min(4095, v), (r * C + c) * 2);
    }
    write(path.join(out, 'rx_001'), {
      sopClass: '1.2.840.10008.5.1.4.1.1.1.1', sop: uid(1, 1), modality: 'DX', seriesDesc: 'TORACE PA',
      series: uid(1, 0), seriesNumber: 1, instance: 1, imagerSpacing: '0.6\\0.6',
      rows: R, cols: C, bits: 16, stored: 12, signed: false, photometric: 'MONOCHROME1', wc: 2048, ww: 4096, pixels: px,
    }, study);
  }

  // serie 4: eco a colori, 12 fotogrammi RGB 8 bit
  {
    const R = 240, C = 320, F = 12, px = Buffer.alloc(R * C * 3 * F);
    for (let f = 0; f < F; f++) for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const o2 = f * R * C * 3 + (r * C + c) * 3;
      const dx = c - C / 2, dy = r - 20, d = Math.hypot(dx, dy), ang = Math.atan2(dx, dy);
      if (Math.abs(ang) < 0.6 && d < 210) {
        const g = 40 + ((Math.sin(d / 6 + f * 0.5) * 30) | 0) + ((r * 31 + c * 17) % 23);
        const flow = Math.hypot(dx - 10 - f * 2, dy - 110) < 22;
        px[o2] = flow ? 220 : g; px[o2 + 1] = flow ? 40 : g; px[o2 + 2] = flow ? 30 : g;
      }
    }
    write(path.join(out, 'us_001'), {
      sopClass: '1.2.840.10008.5.1.4.1.1.3.1', sop: uid(4, 1), modality: 'US', seriesDesc: 'ECO COLOR DOPPLER',
      series: uid(4, 0), seriesNumber: 4, instance: 1, frames: F,
      rows: R, cols: C, samples: 3, photometric: 'RGB', bits: 8, stored: 8, signed: false, pixels: px,
    }, study);
  }
}

/** Copia compressa di uno studio, come altro studio di un altro paziente. */
function comprimi(src, out) {
  const exe = (n) => path.join(DCMTK, n + '.exe');
  if (!fs.existsSync(exe('dcmcjpeg'))) {
    console.log(`DCMTK non trovato in ${DCMTK}: studio compresso saltato (impostare DCMTK_BIN)`);
    return false;
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (f.startsWith('ax_') || f.startsWith('cor_')) execFileSync(exe('dcmcjpeg'), ['+e1', path.join(src, f), path.join(out, f + '.dcm')]);
  }
  execFileSync(exe('dcmcjpls'), ['+el', path.join(src, 'rx_001'), path.join(out, 'rx_001.dcm')]);
  const files = fs.readdirSync(out).map((f) => path.join(out, f));
  execFileSync(exe('dcmodify'), ['-nb',
    '-m', '(0020,000d)=1.2.826.0.1.3680043.2.1125.78.1',
    '-m', '(0010,0010)=COMPRESSO^ESAME DI PROVA',
    '-m', '(0010,0020)=TEST-0002',
    '-m', '(0008,0020)=20260915',
    '-m', '(0008,1030)=TC COMPRESSA JPEG LOSSLESS', ...files]);
  return true;
}

module.exports = { genera, comprimi, DATI, DCMTK, write };

if (require.main === module) {
  const studio = path.join(DATI, 'studio');
  genera(studio);
  console.log('studio  :', fs.readdirSync(studio).length, 'file');
  if (comprimi(studio, path.join(DATI, 'studio2'))) console.log('studio2 :', fs.readdirSync(path.join(DATI, 'studio2')).length, 'file');
}
