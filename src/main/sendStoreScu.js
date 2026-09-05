'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const config = require('./config');

function buildArgs(pattern) {
  return [
    '-v',
    '+sd',
    '--propose-lossless',
    '-aet', config.SRC_AET,
    '-aec', config.DEST_AET,
    config.PACS_IP,
    config.PACS_PORT,
    config.STAGING_DIR,
    '--scan-pattern', pattern,
  ];
}

/**
 * Esegue storescu e fa il parsing dello stdout/stderr in tempo reale.
 *
 * @param {'MP*'|'*.dcm'} pattern
 * @param {number} totalFiles  numero di file in staging (per la progress bar)
 * @param {(l:{type:'log'|'progress',line?:string,data?:object})=>void} emit
 * @returns {Promise<{ success:number, failed:number, total:number, released:boolean, aborted:boolean, exitCode:number|null }>}
 */
function sendStoreScu(pattern, totalFiles, emit) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(config.STORESCU)) {
      return reject(
        new Error(`storescu.exe non trovato in: ${config.STORESCU} — verifica l'installazione di dcmtk.`)
      );
    }
    if (pattern !== 'MP*' && pattern !== '*.dcm') {
      return reject(new Error(`scan-pattern non consentito: "${pattern}". Ammessi solo "MP*" o "*.dcm".`));
    }

    const args = buildArgs(pattern);
    emit({ type: 'log', line: `> storescu ${args.join(' ')}` });

    const child = spawn(config.STORESCU, args, { windowsHide: true });

    const state = { success: 0, failed: 0, total: totalFiles, released: false, aborted: false, exitCode: null };
    let buf = '';

    const handleLine = (line) => {
      if (!line) return;
      emit({ type: 'log', line });

      if (/Sending file:/i.test(line)) {
        emit({
          type: 'progress',
          data: { phase: 'send', sent: state.success + state.failed, success: state.success, failed: state.failed, total: state.total },
        });
      } else if (/Received Store Response.*Success/i.test(line)) {
        state.success++;
        emit({
          type: 'progress',
          data: { phase: 'send', sent: state.success + state.failed, success: state.success, failed: state.failed, total: state.total },
        });
      } else if (/Store SCU Failed|Bad DICOM file|Received Store Response/i.test(line) && !/Success/i.test(line)) {
        state.failed++;
        emit({
          type: 'progress',
          data: { phase: 'send', sent: state.success + state.failed, success: state.success, failed: state.failed, total: state.total },
        });
      }

      if (/Releasing Association/i.test(line)) state.released = true;
      if (/Aborting Association|Association Request Failed|Failed to establish association/i.test(line)) {
        state.aborted = true;
      }
    };

    const onChunk = (chunk) => {
      buf += chunk.toString();
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const p of parts) handleLine(p.trim());
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf.trim());
      state.exitCode = code;
      resolve(state);
    });
  });
}

module.exports = { sendStoreScu };
