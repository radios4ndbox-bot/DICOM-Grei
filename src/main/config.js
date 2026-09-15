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

  // Area di staging locale: si copia sempre qui prima di inviare.
  // Viene SVUOTATA all'inizio di ogni import.
  STAGING_DIR: 'C:\\tmp\\dicom_import',

  // Estrazione degli ZIP. DEVE stare fuori da STAGING_DIR: stageFiles()
  // svuota lo staging prima di copiare, e con l'estrazione dentro cancellava
  // la sorgente da cui stava per leggere (import da ZIP sempre a 0 file).
  EXTRACT_DIR: 'C:\\tmp\\dicom_import_src',

  // Timeout lettura per singolo file (DVD danneggiati)
  FILE_COPY_TIMEOUT_MS: 15000,

  // ---- Trasferimento verso il PACS -------------------------------------
  // Una singola associazione invia i file in sequenza e aspetta la risposta
  // di ogni C-STORE: il collo di bottiglia è il round-trip, non la CPU.
  // Più associazioni in parallelo moltiplicano il throughput.
  WORKERS_NORMAL: 2,
  WORKERS_TURBO: 6,

  // Ritentativi sui soli file falliti/non tentati, dopo il primo passaggio
  SEND_RETRIES: 3,

  // Timeout di rete per storescu, in secondi. DCMTK di default li lascia
  // ILLIMITATI: se il PACS smette di rispondere (p.es. il RIS apre l'esame in
  // refertazione e lo blocca) storescu resta appeso per sempre e il
  // trasferimento non riparte più. Con un timeout muore, e i file non inviati
  // vengono ripresi dal ciclo di ritentativi.
  DIMSE_TIMEOUT_S: 60,
  ACSE_TIMEOUT_S: 30,
  CONNECT_TIMEOUT_S: 30,

  // Attesa crescente fra un ritentativo e il successivo: se il PACS è occupato
  // serve dargli tempo, non martellarlo.
  RETRY_BACKOFF_MS: [10000, 30000, 60000],

  // Nessuna risposta dal PACS per questo tempo => avviso all'operatore
  STALL_WARN_MS: 45000,

  // ---- Prestazioni --------------------------------------------------------
  // Copie contemporanee durante lo staging (vedi copyStage). Da lettore ottico
  // restano basse: letture parallele su un solo disco fanno saltare la testina.
  COPY_CONCURRENCY_FAST: 8,
  COPY_CONCURRENCY_OPTICAL: 2,

  // Passato a storescu come variabile d'ambiente TCP_BUFFER_LENGTH, letta da
  // DCMTK (dcmnet). 0 = non passarla: DCMTK usa i buffer di sistema (verificato con -ll trace).
  TCP_BUFFER_BYTES: 0,

  // Prefisso delle sottocartelle di staging usate dai worker paralleli
  PART_PREFIX: 'part_',

  // ---- Conservazione giornaliera ---------------------------------------
  // Le copie in staging restano disponibili per la giornata e vengono
  // eliminate al cambio di data (vedi dailyPurge).
  // fuori dallo staging, altrimenti verrebbe cancellato a ogni import
  DAILY_STAMP: 'C:\\tmp\\dicom_import.day',
};
