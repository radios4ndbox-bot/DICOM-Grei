'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

/**
 * Lettore ZIP nativo.
 *
 * Prima l'estrazione passava da `Expand-Archive` di PowerShell: per un archivio
 * di qualche migliaio di immagini costa minuti (ricrea un oggetto COM per ogni
 * voce) ed è indisponibile se la postazione è in Constrained Language Mode. Qui
 * si legge direttamente il central directory e si decomprime con zlib: stesso
 * risultato, tempi di un ordine di grandezza più bassi, nessun processo esterno.
 *
 * La difesa "zip slip" è dentro al lettore, non in un controllo a parte: un nome
 * di voce che esce dalla cartella di destinazione fa fallire l'archivio intero
 * prima che venga scritto un solo byte.
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const MAX_ENTRIES = 200000;
const MAX_NAME = 1000;
const INLINE_MAX = 16 * 1024 * 1024; // oltre questa soglia si estrae a stream
const EXTRACT_CONCURRENCY = 4;

// Nomi riservati di Windows: un file "CON" o "LPT1" non è creabile e con alcune
// API apre una periferica invece di un file.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const CONTROL_CHARS = /[\x00-\x1f]/;

function fail(msg) {
  const e = new Error(msg);
  e.zipUnsupported = true;
  return e;
}

/** Nome di voce accettabile: relativo, senza risalite, senza flussi alternati. */
function checkEntryName(name) {
  if (!name || name.length > MAX_NAME) return 'nome vuoto o troppo lungo';
  if (CONTROL_CHARS.test(name)) return 'caratteri di controllo nel nome';
  if (name.includes(':')) return 'due punti nel nome (unità o flusso alternato NTFS)';
  if (name.startsWith('/') || name.startsWith('\\')) return 'percorso assoluto';
  for (const p of name.split(/[\\/]/)) {
    if (p === '..') return 'risalita di cartella (..)';
    if (p.length > 255) return 'segmento di percorso troppo lungo';
    if (p && RESERVED.test(p)) return `nome riservato di Windows ("${p}")`;
  }
  return null;
}

async function readAt(fh, length, position) {
  if (length === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  if (got < length) throw fail('archivio troncato');
  return buf;
}

/** Cerca l'End Of Central Directory dal fondo: in coda può esserci un commento. */
async function findEocd(fh, size) {
  const span = Math.min(size, 0xffff + 22);
  const buf = await readAt(fh, span, size - span);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen !== buf.length) continue; // firma dentro al contenuto
    return {
      entries: buf.readUInt16LE(i + 10),
      cdSize: buf.readUInt32LE(i + 12),
      cdOffset: buf.readUInt32LE(i + 16),
      eocdAbs: size - span + i,
    };
  }
  throw fail('non è un archivio ZIP (End Of Central Directory non trovato)');
}

/** ZIP64: i campi a 32 bit valgono 0xffffffff e i valori veri stanno altrove. */
async function resolveZip64(fh, eocd) {
  const need =
    eocd.entries === 0xffff || eocd.cdSize === 0xffffffff || eocd.cdOffset === 0xffffffff;
  if (!need) return eocd;

  const locPos = eocd.eocdAbs - 20;
  if (locPos < 0) throw fail('ZIP64 dichiarato ma locatore assente');
  const loc = await readAt(fh, 20, locPos);
  if (loc.readUInt32LE(0) !== SIG_EOCD64_LOC) throw fail('ZIP64 dichiarato ma locatore assente');

  const rec = await readAt(fh, 56, Number(loc.readBigUInt64LE(8)));
  if (rec.readUInt32LE(0) !== SIG_EOCD64) throw fail('record ZIP64 non valido');

  return {
    ...eocd,
    entries: Number(rec.readBigUInt64LE(32)),
    cdSize: Number(rec.readBigUInt64LE(40)),
    cdOffset: Number(rec.readBigUInt64LE(48)),
  };
}

/** Valori a 64 bit nel campo extra 0x0001, nell'ordine previsto dallo standard. */
function applyZip64Extra(extra, e) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (p + 4 + len > extra.length) break;
    if (id === 0x0001) {
      const end = p + 4 + len;
      let q = p + 4;
      const take = () => {
        const v = Number(extra.readBigUInt64LE(q));
        q += 8;
        return v;
      };
      if (e.size === 0xffffffff && q + 8 <= end) e.size = take();
      if (e.compressedSize === 0xffffffff && q + 8 <= end) e.compressedSize = take();
      if (e.offset === 0xffffffff && q + 8 <= end) e.offset = take();
      return;
    }
    p += 4 + len;
  }
}

/**
 * Elenca le voci dell'archivio verificando che nessuna esca da `target`.
 * @returns {Promise<{entries:object[], totalSize:number}>}
 */
async function listEntries(fh, size, target) {
  const eocd = await resolveZip64(fh, await findEocd(fh, size));

  if (eocd.entries > MAX_ENTRIES) throw fail(`archivio con troppe voci (${eocd.entries})`);
  if (eocd.cdOffset + eocd.cdSize > size) throw fail('central directory fuori dall archivio');

  const cd = await readAt(fh, eocd.cdSize, eocd.cdOffset);
  const base = path.resolve(target);
  const entries = [];
  const bad = [];
  let totalSize = 0;
  let p = 0;

  for (let i = 0; i < eocd.entries; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CEN) {
      throw fail('central directory corrotta');
    }

    const flags = cd.readUInt16LE(p + 8);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);

    // bit 11 = nome in UTF-8; senza di esso lo standard dice CP437, ma i nomi
    // di questi archivi sono di fatto sempre ASCII e latin1 non perde byte.
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1');

    const e = {
      name,
      method: cd.readUInt16LE(p + 10),
      encrypted: !!(flags & 0x0001),
      size: cd.readUInt32LE(p + 24),
      compressedSize: cd.readUInt32LE(p + 20),
      offset: cd.readUInt32LE(p + 42),
    };
    applyZip64Extra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), e);
    p += 46 + nameLen + extraLen + commentLen;

    e.isDir = /[\\/]$/.test(name);
    const why = checkEntryName(name.replace(/[\\/]+$/, ''));
    if (why) {
      bad.push(`${name} (${why})`);
      continue;
    }

    e.dest = path.resolve(base, name.replace(/\//g, path.sep));
    if (e.dest !== base && !e.dest.startsWith(base + path.sep)) {
      bad.push(`${name} (esce dalla cartella di estrazione)`);
      continue;
    }
    if (e.encrypted) throw fail(`archivio protetto da password (voce "${name}")`);
    if (!e.isDir && e.method !== 0 && e.method !== 8) {
      throw fail(`metodo di compressione non gestito (${e.method}) nella voce "${name}"`);
    }
    if (!e.isDir && e.offset + e.compressedSize > size) throw fail('voce fuori dall archivio');

    totalSize += e.size;
    entries.push(e);
  }

  if (bad.length) {
    throw new Error(
      `Archivio ZIP non sicuro: ${bad.length} voce/i non accettabili (es. "${bad[0]}"). ` +
        'Estrazione annullata.'
    );
  }
  return { entries, totalSize };
}

/** Offset dei dati compressi: il local header ripete nome ed extra con lunghezze proprie. */
async function dataOffset(fh, e) {
  const loc = await readAt(fh, 30, e.offset);
  if (loc.readUInt32LE(0) !== SIG_LOC) throw fail(`local header non valido per "${e.name}"`);
  return e.offset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
}

async function extractOne(fh, e) {
  await fs.promises.mkdir(path.dirname(e.dest), { recursive: true });
  const start = await dataOffset(fh, e);

  if (e.compressedSize <= INLINE_MAX) {
    const raw = await readAt(fh, e.compressedSize, start);
    const out =
      e.method === 0
        ? raw
        : await new Promise((res, rej) =>
            zlib.inflateRaw(raw, (err, b) => (err ? rej(err) : res(b)))
          );
    await fs.promises.writeFile(e.dest, out);
    return;
  }

  // voci grandi: a stream, per non tenerne due copie in RAM
  const read = fh.createReadStream({
    start,
    end: start + e.compressedSize - 1,
    autoClose: false,
  });
  const write = fs.createWriteStream(e.dest);
  if (e.method === 0) await pipeline(read, write);
  else await pipeline(read, zlib.createInflateRaw(), write);
}

/**
 * Estrae `zipPath` dentro `target`, che viene svuotata prima.
 *
 * @param {string} zipPath
 * @param {string} target
 * @param {{onProgress?:(p:{done:number,total:number})=>void, isCancelled?:()=>boolean}} opts
 * @returns {Promise<{files:number, bytes:number, cancelled:boolean}>}
 */
async function extractZip(zipPath, target, opts = {}) {
  const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
  const fh = await fs.promises.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const { entries, totalSize } = await listEntries(fh, size, target);

    await fs.promises.rm(target, { recursive: true, force: true });
    await fs.promises.mkdir(target, { recursive: true });

    const files = entries.filter((e) => !e.isDir);
    let done = 0;
    let next = 0;
    let cancelled = false;

    const worker = async () => {
      while (next < files.length) {
        if (isCancelled()) {
          cancelled = true;
          return;
        }
        const e = files[next++];
        await extractOne(fh, e);
        done++;
        if (opts.onProgress) opts.onProgress({ done, total: files.length });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(EXTRACT_CONCURRENCY, Math.max(1, files.length)) }, worker)
    );

    return { files: done, bytes: totalSize, cancelled };
  } finally {
    await fh.close().catch(() => {});
  }
}

module.exports = { extractZip, listEntries, checkEntryName };
