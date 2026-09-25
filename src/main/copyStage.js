'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const { isMpName } = require('./classify');

// File in copia: in una SOTTOCARTELLA dello staging, e da lì rinominati nella
// cartella di destinazione solo a copia completa (stesso volume: la
// rinomina è atomica).
//
// Prima stavano accanto ai file finiti, distinti solo dal nome. Andava bene
// finché a storescu si passava un --scan-pattern che li escludeva; ora gli si
// passa la cartella senza filtro (vedi sendStoreScu), quindi li prenderebbe.
// Cancellarli a fine copia non basta: la copia abbandonata di un settore
// illeggibile tiene il file aperto, e su Windows un file aperto non si
// cancella. storescu invece, senza +r, non scende nelle sottocartelle
// ("do not recurse within directories (default)"): lì dentro non li vede mai.
const TMP_DIR_NAME = '~copia';
const TMP_PREFIX = '~tmp_';
const TMP_SUFFIX = '.part';

// Secondo passaggio sui file scaduti in lettura (vedi stageFiles).
const SECOND_PASS_MAX_FAILS = 8;
const SECOND_PASS_BUDGET_MS = 3 * 60 * 1000;

/**
 * Letture abbandonate ancora in corso.
 *
 * fs.copyFile gira su un thread del pool di libuv e una lettura ferma su un
 * settore illeggibile non si può interrompere: il thread resta occupato finché
 * Windows non rinuncia al settore. Il pool è condiviso da tutto il processo e
 * di default ha 4 thread. Verificato con letture bloccate simulate: con 6 file
 * illeggibili in testa, i 12 file LEGGIBILI successivi restavano in coda senza
 * mai partire, scadevano, e finivano fra i saltati — 0 copiati su 12.
 *
 * Qui si tiene il conto dei thread occupati da letture abbandonate e non si
 * avvia una lettura nuova che non troverebbe un thread libero: il suo timeout
 * scadrebbe prima ancora che il file venga toccato.
 */
let abandoned = 0;

function poolSize() {
  return Math.max(4, parseInt(process.env.UV_THREADPOOL_SIZE, 10) || 4);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attende che ci sia un thread libero per una lettura nuova.
 * @returns {Promise<'ok'|'cancelled'|'stuck'>} 'stuck' = il lettore non restituisce
 *          più nessuna delle letture abbandonate: inutile insistere
 */
async function waitForThread(limit, isCancelled) {
  if (abandoned < limit) return 'ok';
  const t0 = Date.now();
  while (abandoned >= limit) {
    if (isCancelled()) return 'cancelled';
    if (Date.now() - t0 > config.COPY_DRIVE_STUCK_MS) return 'stuck';
    await delay(200);
  }
  return 'ok';
}

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
async function copyWithTimeout(src, dest, ms, tmp) {
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
    if (timedOut) {
      // il thread resta occupato finché la lettura sottostante non torna
      abandoned++;
      copying.catch(() => {}).then(() => {
        abandoned--;
      });
    }
    copying.catch(() => {}).then(() => fs.promises.rm(tmp, { force: true }).catch(() => {}));
    if (timedOut) {
      const e = new Error('timeout di lettura');
      e.timeout = true;
      throw e;
    }
    throw err;
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
    jobs.push({ src: f.p, suffixIndex: idx, size: f.size });
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
 * @param {{concurrency?:number, isCancelled?:()=>boolean, files?:object[],
 *          onStaged?:(dest:string)=>void, onLog?:(line:string)=>void, totalBytes?:number}} opts
 * @returns {Promise<{copied,skipped,recovered,total,notSendable,skippedFiles,partDirs,cancelled,bytes,elapsedSec}>}
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
  jobs.forEach((j, i) => {
    j.id = i;
  });

  const tmpDir = path.join(config.STAGING_DIR, TMP_DIR_NAME);
  await fs.promises.mkdir(tmpDir, { recursive: true });

  let copied = 0;
  let skipped = 0;
  let cancelled = false;
  let bytes = 0;
  const perPart = new Array(nParts).fill(0);
  const failed = []; // incarichi non riusciti, con il motivo

  // Byte totali: noti dalla scansione (esatti o stimati). Servono all'ETA, che
  // sulla copia è l'unica fase davvero variabile (1,5–9 MB/s nel report sul
  // campo, a seconda del supporto e della sua struttura).
  const knownTotal = jobs.reduce((a, j) => a + (j.size || 0), 0);
  const totalBytes =
    jobs.length && jobs.every((j) => j.size != null)
      ? knownTotal
      : typeof opts.totalBytes === 'number'
      ? opts.totalBytes
      : null;
  const startedAt = Date.now();

  const report = (current) => {
    if (!onProgress) return;
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = elapsed > 0 ? bytes / elapsed : 0; // byte/s
    // Stima solo dopo un avvio: i primi secondi su CD misurano lo spin-up del
    // lettore, non la velocità di lettura.
    let etaSec = null;
    const done = copied + skipped;
    if (elapsed >= 8 && done >= Math.max(5, total * 0.03)) {
      if (totalBytes && rate > 0) etaSec = Math.max(0, Math.round((totalBytes - bytes) / rate));
      else if (done > 0) etaSec = Math.round(((total - done) * elapsed) / done);
    }
    onProgress({
      phase: 'copy',
      copied,
      skipped,
      total,
      current,
      bytes,
      totalBytes,
      mbps: Math.round((rate / 1048576) * 100) / 100,
      etaSec,
    });
  };

  // Un temporaneo per incarico E per tentativo: la copia abbandonata del primo
  // tentativo può essere ancora in scrittura (CopyFileW non si interrompe)
  // quando parte il secondo, e due scritture sullo stesso file darebbero un
  // errore di condivisione o, peggio, un file mescolato. L'indice dell'incarico
  // evita anche le collisioni fra part diverse con lo stesso nome di file.
  const runJob = async (job, attempt) => {
    const tmp = path.join(tmpDir, `${TMP_PREFIX}${job.id}.${attempt}${TMP_SUFFIX}`);
    await copyWithTimeout(job.src, job.dest, config.FILE_COPY_TIMEOUT_MS, tmp);
    let size = job.size;
    if (size == null) {
      try {
        size = (await fs.promises.stat(job.dest)).size; // locale: costa nulla
      } catch {
        size = 0;
      }
    }
    bytes += size;
    copied++;
    perPart[job.part]++;
    // l'anteprima legge il file appena scritto in locale, non il supporto
    if (onStaged) onStaged(job.dest);
  };

  // Letture abbandonate tollerate prima di smettere di avviarne di nuove: il
  // pool deve avere ancora un thread per ogni copia attiva.
  const threadLimit = Math.max(1, poolSize() - concurrency);
  let driveStuck = false;

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      if (isCancelled()) {
        cancelled = true;
        return;
      }
      const w = await waitForThread(threadLimit, isCancelled);
      if (w === 'cancelled') {
        cancelled = true;
        return;
      }
      if (w === 'stuck') {
        driveStuck = true;
        return;
      }
      if (driveStuck || next >= jobs.length) return;
      const job = jobs[next++];
      try {
        await runJob(job, 1);
      } catch (err) {
        skipped++;
        failed.push({ job, timeout: !!(err && err.timeout) });
      }
      report(path.basename(job.src));
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));

  // Lettore che non restituisce più le letture abbandonate: i file non ancora
  // tentati si danno per persi e si prosegue con l'invio parziale di quello che
  // è già in staging. Restare qui ad aspettare vorrebbe dire restarci per sempre.
  if (driveStuck && !cancelled) {
    const left = jobs.length - next;
    for (let i = next; i < jobs.length; i++) {
      skipped++;
      failed.push({ job: jobs[i], timeout: false, stuck: true });
    }
    next = jobs.length;
    if (opts.onLog) {
      opts.onLog(
        `> il lettore non risponde più da ${Math.round(config.COPY_DRIVE_STUCK_MS / 1000)} s: ` +
          `${left} file non letti, si prosegue con i ${copied} già copiati`
      );
    }
    report('');
  }

  // ---- secondo passaggio sui file scaduti -----------------------------------
  //
  // Su un DVD rovinato un settore illeggibile non ferma solo il suo file: il
  // lettore è uno solo e ritenta il settore per decine di secondi, e le letture
  // dei file successivi restano in coda dietro di lui. Scadono anche quelle,
  // anche se i loro dati sono perfettamente leggibili — e venivano saltate.
  // Finito il primo giro il lettore è libero: si riprovano in sequenza.
  //
  // Limiti: si smette dopo SECOND_PASS_MAX_FAILS scadenze di fila (è una zona
  // davvero illeggibile) o dopo SECOND_PASS_BUDGET_MS, perché l'operatore sta
  // aspettando e l'invio parziale è comunque previsto.
  const retry = failed.filter((f) => f.timeout).map((f) => f.job);
  let recovered = 0;
  if (!cancelled && !driveStuck && retry.length) {
    if (opts.onLog) {
      opts.onLog(`> ${retry.length} file scaduti in lettura: secondo tentativo, uno alla volta`);
    }
    const t0 = Date.now();
    let streak = 0;
    for (const job of retry) {
      if (isCancelled()) {
        cancelled = true;
        break;
      }
      if (streak >= SECOND_PASS_MAX_FAILS || Date.now() - t0 > SECOND_PASS_BUDGET_MS) break;
      const w = await waitForThread(threadLimit, isCancelled);
      if (w === 'cancelled') {
        cancelled = true;
        break;
      }
      if (w === 'stuck') break;
      try {
        await runJob(job, 2);
        skipped--;
        recovered++;
        streak = 0;
        const i = failed.findIndex((f) => f.job === job);
        if (i !== -1) failed.splice(i, 1);
      } catch {
        streak++;
      }
      report(path.basename(job.src));
    }
    if (opts.onLog) {
      opts.onLog(
        `> secondo tentativo: ${recovered} recuperati, ${retry.length - recovered} illeggibili`
      );
    }
  }

  const skippedFiles = failed.slice(0, 500).map((f) => f.job.src);
  const elapsedSec = Math.round((Date.now() - startedAt) / 100) / 10;

  // Temporanei: la cartella si toglie se si può. Se una lettura abbandonata
  // tiene ancora aperto un file (su Windows non si cancella), resta lì senza
  // danni: storescu non scende nelle sottocartelle, quindi non la vede.
  await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  // le part rimaste vuote (meno file che worker) non vanno passate a storescu
  const usedDirs = partDirs.filter((_, i) => perPart[i] > 0);

  return {
    copied,
    skipped,
    recovered,
    total,
    notSendable,
    skippedFiles,
    partDirs: usedDirs,
    cancelled,
    driveStuck,
    bytes,
    elapsedSec,
  };
}

module.exports = { stageFiles, emptyStagingDir, buildJobs };
