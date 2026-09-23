'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const { isMpName } = require('./classify');

// Nome dei file durante la copia: prefisso e suffisso non combaciano né con
// "MP*" né con "*.dcm", quindi storescu non può mai prendere un file a metà.
const TMP_PREFIX = '~tmp_';
const TMP_SUFFIX = '.part';

function walkFiles(dir) {
  const out = [];
  const stack = [[dir, '', 0]];
  while (stack.length) {
    const [cur, sub, depth] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push([p, depth === 0 ? e.name : sub, depth + 1]);
      else if (e.isFile()) out.push({ p, sub });
    }
  }
  return out;
}

async function emptyStagingDir() {
  await fs.promises.rm(config.STAGING_DIR, { recursive: true, force: true });
  await fs.promises.mkdir(config.STAGING_DIR, { recursive: true });
}

/**
 * Copia con tempo massimo, pensata per CD/DVD danneggiati.
 *
 * fs.promises.copyFile usa la copia nativa di Windows (CopyFileW): per migliaia
 * di file è molto più rapida di una coppia di stream per file. Si scrive su un
 * nome temporaneo e si rinomina solo a copia completa: se scade il tempo, il
 * file abbandonato resta col nome temporaneo e non verrà mai inviato.
 */
async function copyWithTimeout(src, dest, ms) {
  const tmp = path.join(path.dirname(dest), TMP_PREFIX + path.basename(dest) + TMP_SUFFIX);
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('timeout'));
    }, ms);
  });

  const copying = fs.promises.copyFile(src, tmp);
  try {
    await Promise.race([copying, timeout]);
  } catch (err) {
    // Una lettura bloccata su un settore illeggibile non si può annullare da
    // Node: si abbandona. Il temporaneo va tolto DOPO che la copia sottostante
    // ha finito, altrimenti CopyFileW lo ricrea subito dopo il rm e resta lì.
    copying.catch(() => {}).then(() => fs.promises.rm(tmp, { force: true }).catch(() => {}));
    throw timedOut ? new Error('timeout di lettura') : err;
  } finally {
    clearTimeout(timer);
  }

  try {
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
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
 * Nomi di destinazione assegnati PRIMA di copiare, in memoria.
 *
 * Con copie in parallelo, verificare l'esistenza sul disco al momento della
 * copia sarebbe una corsa: due file omonimi potrebbero scegliere lo stesso
 * nome e uno sovrascriverebbe l'altro. Il confronto ignora le maiuscole perché
 * NTFS non le distingue. Lo staging è appena stato svuotato, quindi l'insieme
 * in memoria è la verità.
 */
function planDestinations(jobs, partDirs, strategy) {
  const taken = partDirs.map(() => new Set());
  for (let i = 0; i < jobs.length; i++) {
    const part = i % partDirs.length;
    const base = destName(jobs[i].src, strategy, jobs[i].suffixIndex);
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    let name = base;
    for (let n = 1; taken[part].has(name.toLowerCase()); n++) name = `${stem}_${n}${ext}`;
    taken[part].add(name.toLowerCase());
    jobs[i].part = part;
    jobs[i].dest = path.join(partDirs[part], name);
  }
}

/**
 * Dall'elenco dei file del supporto agli incarichi di copia.
 *
 * Con la strategia 'keep' il file mantiene il suo nome, quindi verrà inviato
 * solo se combacia con lo scan-pattern: copiare gli altri è tempo di lettura
 * ottica buttato (su molti CD il visualizzatore da solo pesa più delle
 * immagini). Con 'rename'/'suffix' ogni file diventa .dcm e va sempre copiato.
 *
 * L'indice del suffisso viene dalla cartella di primo livello di ciascun file,
 * non da plan.subfolders: così anche forzando il Tipo C su un supporto
 * classificato diversamente i suffissi restano coerenti.
 */
function buildJobs(files, plan) {
  const keepOnlyMp = plan.strategy === 'keep' && plan.pattern === 'MP*';
  const subIndex = new Map();
  const jobs = [];
  let notSendable = 0;

  for (const f of files) {
    if (keepOnlyMp && !isMpName(path.basename(f.p))) {
      notSendable++;
      continue;
    }
    let idx = subIndex.get(f.sub);
    if (idx === undefined) {
      idx = subIndex.size;
      subIndex.set(f.sub, idx);
    }
    jobs.push({ src: f.p, suffixIndex: idx });
  }
  return { jobs, notSendable };
}

/**
 * Copia i file dalla sorgente classificata in C:\tmp\dicom_import.
 *
 * Con `parts > 1` i file vengono distribuiti a rotazione in sottocartelle
 * `part_00`, `part_01`, … : ognuna sarà inviata da un processo storescu
 * separato, cioè su un'associazione DICOM indipendente. Le collisioni di nome
 * fra part diverse sono irrilevanti: il PACS distingue le istanze dal SOP
 * Instance UID, non dal nome file.
 *
 * @param {object} plan  risultato di classify()
 * @param {(p:object)=>void} onProgress  riceve { phase:'copy', copied, total, skipped, current }
 * @param {number} parts  numero di sottocartelle (worker) da preparare
 * @param {{concurrency?:number, isCancelled?:()=>boolean, files?:object[], onStaged?:(dest:string)=>void}} opts
 * @returns {Promise<{copied,skipped,total,notSendable,skippedFiles,partDirs,cancelled}>}
 */
async function stageFiles(plan, onProgress, parts = 1, opts = {}) {
  const concurrency = Math.max(1, (opts.concurrency | 0) || 1);
  const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
  const onStaged = typeof opts.onStaged === 'function' ? opts.onStaged : null;

  await emptyStagingDir();

  // L'elenco arriva dalla classificazione: l'albero del supporto è già stato
  // percorso una volta, non lo si ripercorre.
  const files = Array.isArray(opts.files) && opts.files.length ? opts.files : walkFiles(plan.dataRoot);
  const { jobs, notSendable } = buildJobs(files, plan);

  const total = jobs.length;
  const nParts = Math.max(1, Math.min((parts | 0) || 1, total || 1));

  const partDirs = [];
  for (let i = 0; i < nParts; i++) {
    const d =
      nParts === 1
        ? config.STAGING_DIR
        : path.join(config.STAGING_DIR, config.PART_PREFIX + String(i).padStart(2, '0'));
    if (nParts > 1) await fs.promises.mkdir(d, { recursive: true });
    partDirs.push(d);
  }

  planDestinations(jobs, partDirs, plan.strategy);

  let copied = 0;
  let skipped = 0;
  let cancelled = false;
  const skippedFiles = [];
  const perPart = new Array(nParts).fill(0);

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      if (isCancelled()) {
        cancelled = true;
        return;
      }
      const job = jobs[next++];
      try {
        await copyWithTimeout(job.src, job.dest, config.FILE_COPY_TIMEOUT_MS);
        copied++;
        perPart[job.part]++;
        // l'anteprima legge il file appena scritto in locale, non il supporto
        if (onStaged) onStaged(job.dest);
      } catch {
        skipped++;
        if (skippedFiles.length < 500) skippedFiles.push(job.src);
      }
      if (onProgress) {
        onProgress({ phase: 'copy', copied, skipped, total, current: path.basename(job.src) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));

  // le part rimaste vuote (meno file che worker) non vanno passate a storescu
  const usedDirs = partDirs.filter((_, i) => perPart[i] > 0);

  return { copied, skipped, total, notSendable, skippedFiles, partDirs: usedDirs, cancelled };
}

module.exports = { stageFiles, emptyStagingDir, buildJobs };
