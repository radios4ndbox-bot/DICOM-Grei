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

function uniqueDest(baseName) {
  let candidate = path.join(config.STAGING_DIR, baseName);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let i = 1;
  do {
    candidate = path.join(config.STAGING_DIR, `${stem}_${i}${ext}`);
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
 * @param {object} plan  risultato di classify()
 * @param {(p:object)=>void} onProgress  riceve { phase:'copy', copied, total, skipped, current }
 * @returns {Promise<{ copied:number, skipped:number, total:number, skippedFiles:string[] }>}
 */
async function stageFiles(plan, onProgress) {
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
  let copied = 0;
  let skipped = 0;
  const skippedFiles = [];

  for (const job of jobs) {
    const name = destName(job.src, plan.strategy, job.suffixIndex);
    const dest = uniqueDest(name);
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

  return { copied, skipped, total, skippedFiles };
}

module.exports = { stageFiles, emptyStagingDir };
