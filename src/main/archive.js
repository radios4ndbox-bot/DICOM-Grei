'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const config = require('./config');

/**
 * Archivio locale degli esami non arrivati al PACS.
 *
 * Un esame = una cartella in ARCHIVE_DIR:
 *   <id>/meta.json    paziente, studio, date, motivo: quello che serve all'elenco
 *   <id>/index.json   lo stesso più serie e ordine delle immagini, per il viewer
 *   <id>/files/       i file DICOM, con nomi neutri (000001.dcm…)
 *
 * Ci entra solo ciò che non è andato a buon fine (o che il medico conserva di
 * proposito) e ci resta ARCHIVE_DAYS giorni. È l'unico posto in cui l'app
 * tiene dati del paziente oltre la giornata: per questo scade da solo, e
 * chiunque usi la postazione può eliminare un esame prima.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// l'id viene da noi, ma torna indietro dal renderer: va sempre ricontrollato
const ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const FILE_RE = /^\d{6}\.dcm$/;

const REASONS = {
  'invio-fallito': 'Invio al PACS non riuscito',
  'non-indicizzato': 'Non indicizzato dal PACS',
  // scelta del medico: l'esame non va al PACS, lo guarda qui e poi lo elimina
  'solo-archivio': 'Importato solo in archivio',
};

let busy = false;
const listeners = new Set();

function changed() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

function newId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-` +
    crypto.randomBytes(3).toString('hex')
  );
}

function dirOf(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Esame non valido.');
  return path.join(config.ARCHIVE_DIR, id);
}

/** Percorso di un file dell'esame, solo se ha la forma che gli diamo noi. */
function filePath(id, name) {
  if (typeof name !== 'string' || !FILE_RE.test(name)) throw new Error('File non valido.');
  return path.join(dirOf(id), 'files', name);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function withDays(meta, now = Date.now()) {
  return { ...meta, daysLeft: Math.max(0, Math.ceil((meta.expiresAt - now) / DAY_MS)) };
}

/** Elenco degli esami, dal più recente. Una cartella rovinata non blocca le altre. */
function list() {
  let names;
  try {
    names = fs.readdirSync(config.ARCHIVE_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!ID_RE.test(n)) continue;
    try {
      out.push(withDays(readJson(path.join(config.ARCHIVE_DIR, n, 'meta.json'))));
    } catch {
      // archiviazione interrotta o file illeggibile: la toglie purge()
    }
  }
  return out.sort((a, b) => b.archivedAt - a.archivedAt);
}

function readIndex(id) {
  return withDays(readJson(path.join(dirOf(id), 'index.json')));
}

async function remove(id) {
  await fs.promises.rm(dirOf(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  changed();
}

/**
 * Elimina gli esami scaduti e i resti delle archiviazioni interrotte.
 * @returns {Promise<number>} esami eliminati
 */
async function purge(now = Date.now()) {
  let names;
  try {
    names = await fs.promises.readdir(config.ARCHIVE_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const n of names) {
    const dir = path.join(config.ARCHIVE_DIR, n);
    try {
      if (ID_RE.test(n)) {
        let meta = null;
        try {
          meta = readJson(path.join(dir, 'meta.json'));
        } catch {}
        // senza meta.json la scadenza si calcola dalla data della cartella
        const expires = meta && isFinite(meta.expiresAt)
          ? meta.expiresAt
          : (await fs.promises.stat(dir)).mtimeMs + config.ARCHIVE_DAYS * DAY_MS;
        if (now >= expires) {
          await fs.promises.rm(dir, { recursive: true, force: true });
          removed++;
        }
      } else if (/\.tmp$/.test(n)) {
        // un'archiviazione in corso dura secondi: dopo un'ora è un resto
        if (now - (await fs.promises.stat(dir)).mtimeMs > 60 * 60 * 1000) {
          await fs.promises.rm(dir, { recursive: true, force: true });
        }
      }
    } catch {
      // cartella in uso o non eliminabile: si riprova al prossimo giro
    }
  }
  if (removed) changed();
  return removed;
}

async function stagedFiles(partDirs) {
  const out = [];
  for (const d of partDirs) {
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    // solo i file: i temporanei della copia stanno in una sottocartella
    for (const e of entries) if (e.isFile()) out.push(path.join(d, e.name));
  }
  return out.sort();
}

/**
 * Porta in archivio i file di uno staging.
 *
 * @param {{partDirs:string[], reason:string, onProgress?:Function}} opts
 * @returns {Promise<object>} meta dell'esame archiviato
 */
async function archiveStaging(opts) {
  if (busy) throw new Error('Archiviazione già in corso.');
  const reason = REASONS[opts.reason] ? opts.reason : 'invio-fallito';
  busy = true;
  let tmp = null;
  try {
    const sources = await stagedFiles(opts.partDirs || []);
    if (!sources.length) throw new Error('Nessun file in staging da archiviare.');

    const now = Date.now();
    const id = newId(new Date(now));
    await fs.promises.mkdir(config.ARCHIVE_DIR, { recursive: true });
    tmp = path.join(config.ARCHIVE_DIR, id + '.tmp');

    let user = '';
    try {
      user = os.userInfo().username;
    } catch {}
    const meta = {
      v: 1,
      id,
      archivedAt: now,
      expiresAt: now + config.ARCHIVE_DAYS * DAY_MS,
      reason,
      reasonText: REASONS[reason],
      archivedBy: user,
    };

    const result = await new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'archiveWorker.js'), { workerData: { sources, destDir: tmp, meta } });
      w.on('message', (m) => {
        if (m.type === 'progress') {
          if (opts.onProgress) opts.onProgress(m);
        } else if (m.type === 'done') resolve(m);
        else if (m.type === 'error') reject(new Error(m.message));
      });
      w.on('error', reject);
      w.on('exit', (code) => {
        if (code !== 0) reject(new Error(`archiviazione interrotta (codice ${code})`));
      });
    });

    if (!result.meta.imageCount) throw new Error('Nessuna immagine DICOM riconosciuta fra i file dello staging.');

    // L'esame compare tutto insieme: finché ha il nome .tmp l'elenco non lo vede.
    await fs.promises.rename(tmp, dirOf(id));
    tmp = null;

    // Lo stesso studio archiviato di nuovo (un secondo tentativo d'importazione):
    // vale l'ultimo, con la scadenza che riparte.
    const uid = result.meta.study && result.meta.study.uid;
    if (uid) {
      for (const old of list()) {
        if (old.id !== id && old.study && old.study.uid === uid) {
          await fs.promises.rm(dirOf(old.id), { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    changed();
    return { ...withDays(result.meta), linked: result.linked, copied: result.copied };
  } finally {
    busy = false;
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  list,
  readIndex,
  filePath,
  remove,
  purge,
  archiveStaging,
  onChange: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  REASONS,
};
