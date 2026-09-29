'use strict';

const fs = require('fs');

const config = require('./config');
const { dismountIso } = require('./isoZip');

/**
 * Svuota lo staging (C:\tmp\dicom_grei) e, se richiesto, smonta l'ISO.
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

function readStamp(file = config.DAILY_STAMP) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
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
 * Cartelle col nome di prima di DICOM Grei (C:\tmp\dicom_import…), rimaste
 * sulle postazioni aggiornate. Si tolgono solo se la versione vecchia non ha
 * girato oggi: la sua data sta in dicom_import.day, che scriveva all'avvio e a
 * ogni cambio di data. Con l'installazione per utente, su una postazione
 * condivisa un altro utente può avere ancora la versione vecchia aperta, e il
 * suo staging di oggi non si tocca. Una cartella di un altro utente che non si
 * può cancellare resta dov'è, senza errori.
 */
async function purgeLegacy() {
  const dirs = [config.LEGACY_STAGING_DIR, config.LEGACY_EXTRACT_DIR];
  if (!dirs.some((d) => fs.existsSync(d))) return false;
  if (readStamp(config.LEGACY_DAILY_STAMP) === today()) return false;

  for (const d of dirs) {
    try {
      await fs.promises.rm(d, { recursive: true, force: true });
    } catch {}
  }
  try {
    await fs.promises.rm(config.LEGACY_DAILY_STAMP, { force: true });
  } catch {}
  return true;
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
  await purgeLegacy();

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
