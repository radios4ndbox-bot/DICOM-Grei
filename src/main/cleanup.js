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
    result.staleRemoved = true;
  } catch (err) {
    result.error = String(err.message || err);
  }

  if (opts.iso) {
    result.isoDismounted = await dismountIso(opts.iso);
  }

  return result;
}

module.exports = { cleanup };
