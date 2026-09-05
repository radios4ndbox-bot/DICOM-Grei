'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// storescu: prima la copia inclusa nell'app (resources/dcmtk/bin), poi il Desktop utente.
function resolveStorescu() {
  const bundled = path.join(process.resourcesPath || path.join(__dirname, '..', '..'), 'dcmtk', 'bin', 'storescu.exe');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(os.homedir(), 'Desktop', 'dcmtk', 'bin', 'storescu.exe');
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
