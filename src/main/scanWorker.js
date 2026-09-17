'use strict';

const { parentPort, workerData } = require('worker_threads');

const { scanSource } = require('./classify');
const { readStudyInfo } = require('./dicomInfo');

/**
 * Scansione del supporto fuori dal main process.
 *
 * `classify()` e `readStudyInfo()` usano API sincrone di fs: eseguite nel main
 * bloccano il process Electron per tutto il tempo, cioè su un DVD anche per
 * decine di secondi, con la finestra congelata e gli IPC in coda. Qui girano su
 * un thread separato e il main resta libero di disegnare e di rispondere.
 */
try {
  const { plan, files } = scanSource(workerData.sourcePath);

  let study = null;
  try {
    // l'elenco è già in mano: nessuna readdir in più per l'anagrafica
    study = readStudyInfo(plan.dataRoot, plan, files);
  } catch {
    study = null;
  }

  parentPort.postMessage({ ok: true, plan, study, files });
} catch (err) {
  parentPort.postMessage({ ok: false, message: String((err && err.message) || err) });
}
