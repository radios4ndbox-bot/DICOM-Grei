'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
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
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

async function emptyStagingDir() {
  await fs.promises.rm(config.STAGING_DIR, { recursive: true, force: true });
  await fs.promises.mkdir(config.STAGING_DIR, { recursive: true });
}

function copyFileWithTimeout(src, dest, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      rs.destroy();
      ws.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);

    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rs.destroy();
      ws.destroy();
      reject(err);
    };
    rs.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    });
    rs.pipe(ws);
  });
}

function uniqueDest(dir, baseName) {
  let candidate = path.join(dir, baseName);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let i = 1;
  do {
    candidate = path.join(dir, `${stem}_${i}${ext}`);
    i++;
  } while (fs.existsSync(candidate));
  return candidate;
}

// nome di destinazione secondo la strategia
function destName(srcFile, strategy, suffixIndex) {
  const raw = path.basename(srcFile);
  const stem = path.basename(raw, path.extname(raw));
  if (strategy === 'keep') return raw;
  if (strategy === 'suffix') return `${stem}_${suffixIndex}.dcm`;
  return `${stem}.dcm`; // 'rename'
}

/**
 * Copia i file dalla sorgente classificata in C:\tmp\dicom_import.
 *
 * Con `parts > 1` i file vengono distribuiti a rotazione in sottocartelle
 * `part_00`, `part_01`, … : ognuna sarà inviata da un processo storescu
 * separato, cioè su un'associazione DICOM indipendente. È questo che moltiplica
 * il throughput — il singolo invio è limitato dal round-trip del C-STORE, non
 * dalla CPU. Le collisioni di nome fra part diverse sono irrilevanti: il PACS
 * distingue le istanze dal SOP Instance UID, non dal nome file.
 *
 * @param {object} plan  risultato di classify()
 * @param {(p:object)=>void} onProgress  riceve { phase:'copy', copied, total, skipped, current }
 * @param {number} parts  numero di sottocartelle (worker) da preparare
 * @returns {Promise<{ copied, skipped, total, skippedFiles, partDirs }>}
 */
async function stageFiles(plan, onProgress, parts = 1) {
  await emptyStagingDir();

  let jobs = [];
  if (plan.strategy === 'suffix') {
    plan.subfolders.forEach((sub, idx) => {
      for (const f of walkFiles(path.join(plan.dataRoot, sub))) {
        jobs.push({ src: f, suffixIndex: idx });
      }
    });
  } else {
    for (const f of walkFiles(plan.dataRoot)) jobs.push({ src: f, suffixIndex: 0 });
  }

  const total = jobs.length;
  const nParts = Math.max(1, Math.min(parts | 0 || 1, total || 1));

  const partDirs = [];
  for (let i = 0; i < nParts; i++) {
    const d =
      nParts === 1
        ? config.STAGING_DIR
        : path.join(config.STAGING_DIR, config.PART_PREFIX + String(i).padStart(2, '0'));
    if (nParts > 1) await fs.promises.mkdir(d, { recursive: true });
    partDirs.push(d);
  }

  let copied = 0;
  let skipped = 0;
  const skippedFiles = [];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const dir = partDirs[i % nParts];
    const name = destName(job.src, plan.strategy, job.suffixIndex);
    const dest = uniqueDest(dir, name);
    try {
      await copyFileWithTimeout(job.src, dest, config.FILE_COPY_TIMEOUT_MS);
      copied++;
    } catch (err) {
      skipped++;
      skippedFiles.push(job.src);
      try {
        fs.rmSync(dest, { force: true });
      } catch {}
    }
    if (onProgress) {
      onProgress({ phase: 'copy', copied, skipped, total, current: path.basename(job.src) });
    }
  }

  // le part rimaste vuote (meno file che worker) non vanno passate a storescu
  const usedDirs = partDirs.filter((d) => {
    try {
      return fs.readdirSync(d).length > 0;
    } catch {
      return false;
    }
  });

  return { copied, skipped, total, skippedFiles, partDirs: usedDirs };
}

module.exports = { stageFiles, emptyStagingDir };
