'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// storescu: prima la copia inclusa nell'app, poi il Desktop utente.
//
// In build impacchettata sta in <resources>/dcmtk/bin (vedi extraResources).
// In sviluppo `process.resourcesPath` punta alle risorse di Electron, non alle
// nostre: serve il percorso del repo, altrimenti `npm start` non trova mai il
// binario incluso e ricade sul Desktop.
function resolveStorescu() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'dcmtk', 'bin', 'storescu.exe'),
    path.join(__dirname, '..', '..', 'resources', 'dcmtk', 'bin', 'storescu.exe'),
    path.join(os.homedir(), 'Desktop', 'dcmtk', 'bin', 'storescu.exe'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return candidates[candidates.length - 1]; // ultimo tentativo: errore chiaro a runtime
}

module.exports = {
  // Parametri PACS Synapse Fujifilm — fissi
  SRC_AET: 'DICOM_IMPORT',
  DEST_AET: 'PACS',
  PACS_IP: '127.0.0.1',
  PACS_PORT: '104',

  // storescu.exe: bundle in resources/dcmtk/bin oppure %USERPROFILE%\Desktop\dcmtk\bin
  STORESCU: resolveStorescu(),

  // Area di staging locale: si copia sempre qui prima di inviare
  STAGING_DIR: 'C:\\tmp\\dicom_import',

  // Sottocartella usata per l'estrazione degli ZIP
  EXTRACT_SUBDIR: '_extracted',

  // Timeout lettura per singolo file (DVD danneggiati)
  FILE_COPY_TIMEOUT_MS: 15000,
};
