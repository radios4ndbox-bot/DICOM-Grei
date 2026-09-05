'use strict';

const os = require('os');
const path = require('path');

module.exports = {
  // Parametri PACS Synapse Fujifilm — fissi
  SRC_AET: 'DICOM_IMPORT',
  DEST_AET: 'PACS',
  PACS_IP: '127.0.0.1',
  PACS_PORT: '104',

  // storescu.exe di dcmtk sul Desktop dell'utente
  STORESCU: path.join(os.homedir(), 'Desktop', 'dcmtk', 'bin', 'storescu.exe'),

  // Area di staging locale: si copia sempre qui prima di inviare
  STAGING_DIR: 'C:\\tmp\\dicom_import',

  // Sottocartella usata per l'estrazione degli ZIP
  EXTRACT_SUBDIR: '_extracted',

  // Timeout lettura per singolo file (DVD danneggiati)
  FILE_COPY_TIMEOUT_MS: 15000,
};
