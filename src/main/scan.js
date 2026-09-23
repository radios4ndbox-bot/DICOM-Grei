'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const { scanSource } = require('./classify');
const { readStudyInfo } = require('./dicomInfo');

const SCAN_TIMEOUT_MS = 10 * 60 * 1000;

/** Fallback: se il worker non parte, si esegue in-process (UI ferma, ma funziona). */
function scanInline(sourcePath) {
  const { plan, files } = scanSource(sourcePath);
  let study = null;
  try {
    study = readStudyInfo(plan.dataRoot, plan, files);
  } catch {
    study = null;
  }
  return { plan, study, files };
}

/**
 * Percorre e classifica il supporto su un worker thread.
 * @returns {Promise<{plan:object, study:object|null, files:{p:string,sub:string}[]}>}
 */
function scanMedia(sourcePath) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'scanWorker.js'), { workerData: { sourcePath } });
    } catch {
      try {
        return resolve(scanInline(sourcePath));
      } catch (err) {
        return reject(err);
      }
    }

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      worker.terminate().catch(() => {});
      fn(arg);
    };

    // Un supporto illeggibile può tenere una readdir appesa a tempo
    // indeterminato: meglio un errore chiaro che una finestra bloccata.
    const guard = setTimeout(
      () => finish(reject, new Error('Lettura del supporto troppo lenta: verificare il disco.')),
      SCAN_TIMEOUT_MS
    );

    // Il worker può non partire affatto in un pacchetto atipico (modulo non
    // incluso, thread non disponibili): in quel caso si scansiona in-process
    // invece di lasciare l'operatore con un errore e un supporto illeggibile.
    const fallback = (err) => {
      try {
        finish(resolve, scanInline(sourcePath));
      } catch {
        finish(reject, err);
      }
    };

    worker.on('message', (msg) => {
      if (msg && msg.ok) finish(resolve, { plan: msg.plan, study: msg.study, files: msg.files });
      else finish(reject, new Error((msg && msg.message) || 'Scansione del supporto fallita.'));
    });
    worker.on('error', fallback);
    worker.on('exit', (code) => {
      if (!settled) fallback(new Error(`Scansione interrotta (codice ${code}).`));
    });
  });
}

module.exports = { scanMedia };
