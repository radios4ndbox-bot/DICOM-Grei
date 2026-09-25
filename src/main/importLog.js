'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Log di ogni importazione, salvato sul Desktop con data e ora nel nome.
 *
 * Dal report sul campo: "log salvato su Desktop, mai in C:\tmp". Lo staging
 * viene svuotato a ogni import e ogni giorno: un log lì sparirebbe proprio
 * quando serve, cioè quando si cerca di capire cosa è andato storto ieri.
 *
 * Il file si scrive MENTRE l'importazione procede, non alla fine: se l'app o
 * il PC si fermano a metà, il log arriva fino a quel punto.
 *
 * Contenuto volutamente senza dati del paziente — né nome, né ID, né data di
 * nascita, né l'etichetta del volume, che alcuni sistemi di masterizzazione
 * compongono col nome del paziente. Le postazioni sono condivise fra gli
 * utenti del reparto e il Desktop è la cartella più esposta.
 * Le righe di storescu -v non ne contengono: percorsi dello staging, classi
 * SOP, esiti.
 */

const DIR_NAME = 'DICOM Import Log';

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function clock(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Cartelle candidate: Desktop (anche se reindirizzato su OneDrive), poi il profilo dell'app. */
function candidateDirs() {
  const out = [];
  try {
    const { app } = require('electron');
    out.push(path.join(app.getPath('desktop'), DIR_NAME));
    out.push(path.join(app.getPath('userData'), 'logs'));
  } catch {
    // fuori da Electron (test)
    out.push(path.join(os.homedir(), 'Desktop', DIR_NAME));
  }
  return out;
}

function formatBytes(b) {
  if (b == null || !isFinite(b)) return '—';
  return `${(b / 1048576).toFixed(1)} MB`;
}

function formatDuration(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  if (sec < 10) return `${sec.toFixed(1)} s`;
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${pad(s % 60)} s` : `${s} s`;
}

function mbps(bytes, sec) {
  if (!bytes || !sec) return '—';
  return `${(bytes / 1048576 / sec).toFixed(2)} MB/s`;
}

/**
 * @param {{dirs?: string[]}} opts  cartelle da provare (per i test)
 * @returns {{ path: string|null, line(s:string):void, section(t:string):void, close():Promise<void> }}
 */
function openImportLog(opts = {}) {
  const dirs = opts.dirs || candidateDirs();
  let stream = null;
  let file = null;

  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, `DICOM_Import_${stamp()}.log`);
      // apertura sincrona: se la cartella non è scrivibile lo si sa qui, non
      // al primo write asincrono quando è troppo tardi per cambiare cartella
      const fd = fs.openSync(f, 'a');
      stream = fs.createWriteStream(null, { fd, encoding: 'utf8' });
      stream.on('error', () => {
        stream = null; // un disco pieno non deve far fallire l'importazione
      });
      file = f;
      break;
    } catch {
      // cartella non scrivibile (policy di dominio, Desktop bloccato): la prossima
    }
  }

  const write = (text) => {
    if (stream) stream.write(text);
  };

  return {
    path: file,
    line(s) {
      write(`${clock()}  ${s}\r\n`);
    },
    section(t) {
      write(`\r\n${clock()}  ==== ${t} ====\r\n`);
    },
    close() {
      return new Promise((resolve) => {
        if (!stream) return resolve();
        const s = stream;
        stream = null;
        s.end(resolve);
      });
    },
  };
}

module.exports = { openImportLog, formatBytes, formatDuration, mbps, stamp };
