'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const config = require('./config');

/**
 * Lato main dell'anteprima: avvia il worker, gli passa i file appena copiati e
 * gira i riquadri alla finestra.
 *
 * L'anteprima è un di più: qualunque cosa vada storta qui (worker che non
 * parte, file malformato, memoria) non deve toccare l'importazione. Per questo
 * ogni chiamata è racchiusa in un try e un fallimento si limita a spegnere il
 * pannello.
 */

const FLUSH_MS = 200;
const BATCH_MAX = 256;
const END_GRACE_MS = 20000; // oltre questo tempo il worker viene chiuso comunque

function startPreview(onEvent) {
  let worker = null;
  let pending = [];
  let timer = null;
  let stopped = false;
  let seen = 0;
  let endResolve = null;

  const emit = (ev) => {
    try {
      onEvent(ev);
    } catch {}
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!worker || stopped || pending.length === 0) return;
    const items = pending;
    pending = [];
    try {
      worker.postMessage({ t: 'files', items });
    } catch {
      stop();
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    pending = [];
    const w = worker;
    worker = null;
    if (w) w.terminate().catch(() => {});
    if (endResolve) {
      const r = endResolve;
      endResolve = null;
      r();
    }
  };

  try {
    worker = new Worker(path.join(__dirname, 'previewWorker.js'), {
      workerData: {
        maxTiles: config.PREVIEW_MAX_TILES,
        maxScan: config.PREVIEW_MAX_SCAN,
        thumbPx: config.PREVIEW_THUMB_PX,
        maxPixels: config.PREVIEW_MAX_PIXELS,
      },
      // l'anteprima non deve poter far crescere la memoria dell'app oltre
      // quanto serve a qualche miniatura
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
  } catch (err) {
    emit({ t: 'error', message: String((err && err.message) || err) });
    return { file: () => {}, end: async () => {}, kill: () => {}, available: false };
  }

  worker.on('message', (msg) => {
    if (!msg) return;
    if (msg.t === 'done') {
      emit(msg);
      stop();
      return;
    }
    emit(msg);
  });
  worker.on('error', (err) => {
    emit({ t: 'error', message: String((err && err.message) || err) });
    stop();
  });
  worker.on('exit', () => stop());

  return {
    available: true,

    /** Un file appena copiato in staging: si accoda, si manda a blocchi. */
    file(p) {
      if (stopped || !worker) return;
      if (seen >= config.PREVIEW_MAX_SCAN) return;
      seen++;
      pending.push(p);
      if (pending.length >= BATCH_MAX) flush();
      else if (!timer) timer = setTimeout(flush, FLUSH_MS);
    },

    /** Copia finita: ultimo blocco, poi si attende il riordino dei riquadri. */
    end() {
      if (stopped || !worker) return Promise.resolve();
      flush();
      return new Promise((resolve) => {
        const guard = setTimeout(stop, END_GRACE_MS);
        endResolve = () => {
          clearTimeout(guard);
          resolve();
        };
        try {
          worker.postMessage({ t: 'end' });
        } catch {
          stop();
        }
      });
    },

    kill: stop,
  };
}

module.exports = { startPreview };
