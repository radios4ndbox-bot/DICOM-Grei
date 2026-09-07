'use strict';

const fs = require('fs');

const config = require('./config');
const { dismountIso } = require('./isoZip');

/**
 * Svuota C:\tmp\dicom_import e, se richiesto, smonta l'ISO.
 * Da chiamare solo dopo conferma esplicita dell'utente.
 *
 * @param {{ iso?: string|null }} opts
 */
async function cleanup(opts = {}) {
  const result = { staleRemoved: false, isoDismounted: false };

  try {
    await fs.promises.rm(config.STAGING_DIR, { recursive: true, force: true });
    await fs.promises.mkdir(config.STAGING_DIR, { recursive: true });
    // anche la cartella di estrazione degli ZIP, che sta fuori dallo staging
    await fs.promises.rm(config.EXTRACT_DIR, { recursive: true, force: true });
    result.staleRemoved = true;
  } catch (err) {
    result.error = String(err.message || err);
  }

  if (opts.iso) {
    result.isoDismounted = await dismountIso(opts.iso);
  }

  return result;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readStamp() {
  try {
    return fs.readFileSync(config.DAILY_STAMP, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeStamp(day) {
  try {
    fs.writeFileSync(config.DAILY_STAMP, day, 'utf8');
  } catch {}
}

/**
 * Conservazione giornaliera: le copie in staging restano disponibili per tutta
 * la giornata (utile se un invio va rifatto), e vengono eliminate al primo
 * controllo successivo al cambio di data.
 *
 * @param {boolean} force  svuota comunque, aggiornando la data
 * @returns {Promise<{purged:boolean, day:string, previous:string}>}
 */
async function dailyPurge(force = false) {
  const day = today();
  const previous = readStamp();

  if (!force && previous === day) return { purged: false, day, previous };

  // primo avvio: nessuna data registrata e niente da buttare
  const hadData = fs.existsSync(config.STAGING_DIR) || fs.existsSync(config.EXTRACT_DIR);
  if (!force && !previous && !hadData) {
    writeStamp(day);
    return { purged: false, day, previous };
  }

  await cleanup({});
  writeStamp(day);
  return { purged: true, day, previous };
}

module.exports = { cleanup, dailyPurge, today };
