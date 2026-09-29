'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./config');

/**
 * Impostazioni modificabili dall'operatore.
 *
 * I percorsi (staging, estrazione) NON sono qui di proposito: `cleanup()` fa
 * una rimozione ricorsiva su STAGING_DIR, e lasciarlo scrivere da un campo di
 * testo significherebbe poter cancellare una cartella qualsiasi per errore di
 * battitura. Restano in config.js.
 *
 * Ogni voce dichiara il proprio dominio: la validazione sta qui, non nella UI,
 * perché il renderer non è la fonte di verità.
 */
const SCHEMA = [
  {
    section: 'PACS di destinazione',
    fields: [
      { key: 'PACS_IP', label: 'Indirizzo', type: 'host', hint: 'IP o nome host del PACS' },
      { key: 'PACS_PORT', label: 'Porta', type: 'int', min: 1, max: 65535 },
      { key: 'DEST_AET', label: 'AE Title destinazione', type: 'aet', hint: 'Chiamato (-aec)' },
      { key: 'SRC_AET', label: 'AE Title sorgente', type: 'aet', hint: 'Chiamante (-aet)' },
    ],
  },
  {
    section: 'Timeout di rete',
    note:
      'DCMTK di default li lascia illimitati: senza questi valori storescu resta ' +
      'appeso per sempre se il PACS smette di rispondere.',
    fields: [
      {
        key: 'DIMSE_TIMEOUT_S',
        label: 'Risposta al singolo file',
        type: 'int',
        min: 5,
        max: 3600,
        unit: 's',
        hint: 'Quanto attendere la risposta a un C-STORE prima di considerarlo perso',
      },
      {
        key: 'ACSE_TIMEOUT_S',
        label: 'Negoziazione associazione',
        type: 'int',
        min: 5,
        max: 600,
        unit: 's',
      },
      {
        key: 'CONNECT_TIMEOUT_S',
        label: 'Connessione',
        type: 'int',
        min: 5,
        max: 600,
        unit: 's',
      },
    ],
  },
  {
    section: 'Trasferimento',
    note:
      'Se compare "Association Request Failed" il PACS accetta meno associazioni ' +
      'contemporanee: abbassare i valori qui sotto.',
    fields: [
      {
        key: 'WORKERS_NORMAL',
        label: 'Associazioni in parallelo (normale)',
        type: 'int',
        min: 1,
        max: 16,
      },
      {
        key: 'WORKERS_TURBO',
        label: 'Associazioni in parallelo (turbo)',
        type: 'int',
        min: 1,
        max: 16,
      },
      { key: 'SEND_RETRIES', label: 'Ritentativi sui file falliti', type: 'int', min: 0, max: 10 },
      {
        key: 'RETRY_BACKOFF_S',
        label: 'Attesa prima del 1° ritentativo',
        type: 'int',
        min: 0,
        max: 600,
        unit: 's',
        hint: 'I ritentativi successivi attendono 3× e 6× questo valore',
      },
      {
        key: 'STALL_WARN_S',
        label: 'Avviso "PACS non risponde" dopo',
        type: 'int',
        min: 10,
        max: 600,
        unit: 's',
      },
      {
        key: 'SEND_STALL_KILL_S',
        label: 'Abbatti associazione muta dopo',
        type: 'int',
        min: 30,
        max: 3600,
        unit: 's',
        hint:
          'Se da storescu non arriva un byte per questo tempo il processo viene ucciso ' +
          'e i file non inviati rientrano nei ritentativi. Evita gli invii appesi per sempre',
      },
      {
        key: 'TCP_BUFFER_KB',
        label: 'Buffer TCP verso il PACS',
        type: 'int',
        min: 0,
        max: 16384,
        unit: 'KB',
        hint: '0 = automatico di Windows (consigliato). Diverso da 0 imposta TCP_BUFFER_LENGTH di DCMTK',
      },
    ],
  },
  {
    section: 'Riga di comando di storescu',
    note:
      'Da usare per allineare l\'app a un lancio manuale da cmd che si comporta ' +
      'diversamente: con gli stessi valori, l\'app lancia esattamente gli stessi ' +
      'argomenti. Il pulsante «Copia comando» nello step 3 da\' la riga da incollare.',
    fields: [
      {
        key: 'PROPOSE_TS',
        label: 'Sintassi di trasferimento proposte',
        type: 'enum',
        options: [
          { value: 'lossless', label: 'Predefinite + JPEG lossless (--propose-lossless)' },
          { value: 'uncompr', label: 'Solo non compresse (--propose-uncompr)' },
          { value: 'little', label: 'Explicit VR little endian (--propose-little)' },
          { value: 'implicit', label: 'Implicit VR little endian (--propose-implicit)' },
        ],
        hint:
          'Non c\'entra con la qualita\': questo storescu non ha codec JPEG, non ricomprime ' +
          'mai nulla e i byte partono come stanno sul supporto. --propose-lossless serve ai ' +
          'file gia\' compressi cosi\' sul CD, che altrimenti non trovano un contesto',
      },
      {
        key: 'SEND_TIMEOUTS',
        label: 'Passa i timeout a storescu',
        type: 'bool',
        hint:
          'Disattivandolo DCMTK aspetta il PACS senza limiti, come da cmd. ' +
          'La guardia di inattivita\' dell\'app resta comunque attiva',
      },
      {
        key: 'TCP_NODELAY_ON',
        label: 'TCP_NODELAY (disattiva Nagle)',
        type: 'bool',
        hint: 'Un lancio da cmd non la imposta: toglierla per un confronto fedele',
      },
    ],
  },
  {
    section: 'Anteprima',
    note:
      'I riquadri vengono costruiti sui file gia\' copiati in locale, su un thread ' +
      'separato: non rallentano la copia e non rileggono il supporto.',
    fields: [
      {
        key: 'PREVIEW_MAX_TILES',
        label: 'Riquadri del mosaico',
        type: 'int',
        min: 0,
        max: 24,
        hint: '0 disattiva l\'anteprima. Uno per serie/orientamento',
      },
      {
        key: 'PREVIEW_MAX_SCAN',
        label: 'Intestazioni esaminate al massimo',
        type: 'int',
        min: 200,
        max: 50000,
      },
    ],
  },
  {
    section: 'Lettura supporto',
    fields: [
      {
        key: 'FILE_COPY_TIMEOUT_S',
        label: 'Timeout lettura per file',
        type: 'int',
        min: 1,
        max: 300,
        unit: 's',
        hint: 'Oltre questo tempo il file viene saltato (CD/DVD rovinati)',
      },
      {
        key: 'COPY_CONCURRENCY_FAST',
        label: 'Copie in parallelo (USB, ZIP, ISO)',
        type: 'int',
        min: 1,
        max: 32,
      },
      {
        key: 'COPY_CONCURRENCY_OPTICAL',
        label: 'Copie in parallelo (CD/DVD)',
        type: 'int',
        min: 1,
        max: 8,
        hint: 'Su un lettore ottico valori alti rallentano: la testina salta fra i file',
      },
    ],
  },
];

const DEFAULTS = {
  PACS_IP: '127.0.0.1',
  PACS_PORT: 104,
  DEST_AET: 'PACS',
  SRC_AET: 'DICOM_IMPORT',
  DIMSE_TIMEOUT_S: 60,
  ACSE_TIMEOUT_S: 30,
  CONNECT_TIMEOUT_S: 30,
  WORKERS_NORMAL: 2,
  WORKERS_TURBO: 6,
  SEND_RETRIES: 3,
  RETRY_BACKOFF_S: 10,
  STALL_WARN_S: 45,
  PROPOSE_TS: 'lossless',
  SEND_TIMEOUTS: true,
  TCP_NODELAY_ON: true,
  SEND_STALL_KILL_S: 180,
  PREVIEW_MAX_TILES: 12,
  PREVIEW_MAX_SCAN: 6000,
  FILE_COPY_TIMEOUT_S: 15,
  TCP_BUFFER_KB: 0,
  COPY_CONCURRENCY_FAST: 8,
  COPY_CONCURRENCY_OPTICAL: 2,
};

const FIELDS = new Map();
for (const s of SCHEMA) for (const f of s.fields) FIELDS.set(f.key, f);

// ---------------------------------------------------------------- validazione

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function validHost(v) {
  const s = String(v).trim();
  const m = s.match(IPV4);
  if (m) return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255) ? s : null;
  return HOSTNAME.test(s) ? s : null;
}

// AE title DICOM: al massimo 16 caratteri, niente spazi o backslash.
function validAet(v) {
  const s = String(v).trim();
  return /^[A-Za-z0-9._-]{1,16}$/.test(s) ? s : null;
}

/**
 * Restituisce i valori validi e l'elenco degli errori. Un campo non valido non
 * viene scritto: si tiene il precedente.
 */
function validate(input, base) {
  const out = { ...base };
  const errors = [];

  for (const [key, f] of FIELDS) {
    if (!(key in input)) continue;
    const raw = input[key];

    if (f.type === 'host') {
      const v = validHost(raw);
      if (v === null) errors.push(`${f.label}: indirizzo non valido.`);
      else out[key] = v;
    } else if (f.type === 'aet') {
      const v = validAet(raw);
      if (v === null) errors.push(`${f.label}: max 16 caratteri, solo lettere, cifre, . _ -`);
      else out[key] = v;
    } else if (f.type === 'enum') {
      const v = String(raw).trim();
      if (!f.options.some((o) => o.value === v)) errors.push(`${f.label}: valore non previsto.`);
      else out[key] = v;
    } else if (f.type === 'bool') {
      // dalla finestra arriva una checkbox, dal file salvato un booleano vero
      const v = String(raw).trim().toLowerCase();
      if (['true', '1', 'on', 'si', 'sì'].includes(v)) out[key] = true;
      else if (['false', '0', 'off', 'no', ''].includes(v)) out[key] = false;
      else errors.push(`${f.label}: deve essere acceso o spento.`);
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        errors.push(`${f.label}: deve essere un numero intero.`);
      } else if (n < f.min || n > f.max) {
        errors.push(`${f.label}: valore ammesso fra ${f.min} e ${f.max}.`);
      } else {
        out[key] = n;
      }
    }
  }

  return { values: out, errors };
}

// ---------------------------------------------------------------- persistenza

/*
 * Due file, lo stesso contenuto:
 *
 *   personale    %APPDATA%\dicom-import-tool\settings.json  (un utente Windows)
 *   postazione   %ProgramData%\DICOM Grei\settings.json     (tutti gli utenti)
 *
 * %APPDATA% è per utente: su una postazione condivisa chi non aveva mai aperto
 * l'ingranaggio vedeva 127.0.0.1 e l'invio falliva, anche se un collega aveva
 * già configurato il PACS sullo stesso PC. Ora vale il file salvato per ultimo
 * fra i due (_savedAt, o la data del file per quelli delle versioni
 * precedenti), e un file personale più recente viene ricopiato in quello della
 * postazione. Il primo utente già configurato che apre questa versione
 * configura così anche tutti gli altri.
 *
 * Il file della postazione lo crea il primo utente che ci scrive, e Windows
 * lascia modificarlo solo a lui: gli altri lo leggono. Non si allargano i
 * permessi apposta, perché chi può scriverlo decide verso quale host partono
 * le immagini di tutti. Se un altro utente salva, il suo file personale è più
 * recente e vale per lui; la scrittura sulla postazione fallisce in silenzio.
 *
 * Un indirizzo di loopback (127.x, localhost: il segnaposto, o un PACS finto
 * per le prove) non va mai nel file della postazione, e un file con un PACS
 * vero ha la precedenza su uno con il loopback, anche se più vecchio.
 */

const SHARED_DIR_NAME = 'DICOM Grei';
const pathOverride = { personal: null, shared: undefined }; // solo per i test

function personalPath() {
  if (pathOverride.personal) return pathOverride.personal;
  try {
    // require dentro la funzione: così il modulo resta caricabile fuori da Electron
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'settings.json');
  } catch {
    return path.join(os.tmpdir(), 'dicom-grei-settings.json');
  }
}

function sharedPath() {
  if (pathOverride.shared !== undefined) return pathOverride.shared;
  if (process.platform !== 'win32') return null;
  const base = process.env.ProgramData || 'C:\\ProgramData';
  return path.join(base, SHARED_DIR_NAME, 'settings.json');
}

function setPathsForTest(p) {
  if ('personal' in p) pathOverride.personal = p.personal;
  if ('shared' in p) pathOverride.shared = p.shared;
}

function isLoopback(host) {
  const h = String(host).trim().toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/** { kind, path, exists, ok, data, time } — non lancia mai. */
function readSettingsFile(kind, file) {
  const out = { kind, path: file, exists: false, ok: false, data: null, time: 0 };
  if (!file) return out;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return out;
  }
  out.exists = true;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
    out.data = data;
    out.time = Number(data._savedAt) || st.mtimeMs;
    out.ok = true;
  } catch {}
  return out;
}

/** Scrittura su file temporaneo e rename: chi legge non vede mai un file a metà. */
function writeSettingsFile(file, values, time) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...values, _savedAt: time }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

/** true se il file della postazione è stato scritto. */
function writeShared(values, time) {
  const file = sharedPath();
  if (!file || isLoopback(values.PACS_IP)) return false;
  try {
    writeSettingsFile(file, values, time);
    return true;
  } catch {
    return false; // file di un altro utente, o ProgramData bloccata da policy
  }
}

let current = { ...DEFAULTS };
// da dove vengono i valori correnti: 'personal' | 'shared' | 'default'
let status = { source: 'default', file: null, warnings: [] };

/** Riversa le impostazioni correnti in config, da cui leggono tutti i moduli. */
function apply() {
  config.PACS_IP = current.PACS_IP;
  config.PACS_PORT = String(current.PACS_PORT);
  config.DEST_AET = current.DEST_AET;
  config.SRC_AET = current.SRC_AET;

  config.DIMSE_TIMEOUT_S = current.DIMSE_TIMEOUT_S;
  config.ACSE_TIMEOUT_S = current.ACSE_TIMEOUT_S;
  config.CONNECT_TIMEOUT_S = current.CONNECT_TIMEOUT_S;

  config.WORKERS_NORMAL = current.WORKERS_NORMAL;
  config.WORKERS_TURBO = current.WORKERS_TURBO;
  config.SEND_RETRIES = current.SEND_RETRIES;

  const b = current.RETRY_BACKOFF_S * 1000;
  config.RETRY_BACKOFF_MS = [b, b * 3, b * 6];

  config.PROPOSE_TS = current.PROPOSE_TS;
  config.SEND_TIMEOUTS = current.SEND_TIMEOUTS;
  config.TCP_NODELAY_ON = current.TCP_NODELAY_ON;

  config.STALL_WARN_MS = current.STALL_WARN_S * 1000;
  config.SEND_STALL_KILL_MS = current.SEND_STALL_KILL_S * 1000;
  config.PREVIEW_MAX_TILES = current.PREVIEW_MAX_TILES;
  config.PREVIEW_MAX_SCAN = current.PREVIEW_MAX_SCAN;
  config.FILE_COPY_TIMEOUT_MS = current.FILE_COPY_TIMEOUT_S * 1000;

  config.TCP_BUFFER_BYTES = current.TCP_BUFFER_KB * 1024;
  config.COPY_CONCURRENCY_FAST = current.COPY_CONCURRENCY_FAST;
  config.COPY_CONCURRENCY_OPTICAL = current.COPY_CONCURRENCY_OPTICAL;
}

function load() {
  const personal = readSettingsFile('personal', personalPath());
  const shared = readSettingsFile('shared', sharedPath());

  const warnings = [];
  for (const f of [personal, shared]) {
    if (f.exists && !f.ok) warnings.push(`File delle impostazioni illeggibile, ignorato: ${f.path}`);
  }

  // Vale il più recente, a pari data quello personale. Prima però un PACS vero
  // di uno su loopback: nelle versioni precedenti «Ripristina» scriveva i
  // segnaposto (127.0.0.1) nel file personale, che essendo più recente avrebbe
  // coperto la configurazione della postazione.
  const loop = (f) => (isLoopback(f.data.PACS_IP === undefined ? DEFAULTS.PACS_IP : f.data.PACS_IP) ? 1 : 0);
  const usable = [personal, shared].filter((f) => f.ok);
  usable.sort((a, b) => loop(a) - loop(b) || b.time - a.time);
  const chosen = usable[0] || null;

  // un file manomesso o di una versione precedente non deve rompere l'avvio
  const { values } = validate(chosen ? chosen.data : {}, DEFAULTS);
  current = values;
  apply();
  status = { source: chosen ? chosen.kind : 'default', file: chosen ? chosen.path : null, warnings };

  if (chosen && chosen.kind === 'personal' && (!shared.ok || shared.time < chosen.time)) {
    writeShared(values, chosen.time);
  }
  return current;
}

function save(input) {
  const { values, errors } = validate(input || {}, current);
  if (errors.length) return { ok: false, errors, values: current };

  current = values;
  apply();
  const time = Date.now();
  const p = personalPath();
  try {
    writeSettingsFile(p, values, time);
  } catch (err) {
    return { ok: false, errors: [`Impossibile salvare: ${err.message}`], values: current };
  }
  const shared = writeShared(values, time);
  status = { source: 'personal', file: p, warnings: [] };
  return { ok: true, errors: [], values: current, shared };
}

/**
 * Toglie il file personale e rilegge: si torna alle impostazioni della
 * postazione, se ci sono, altrimenti ai predefiniti. Scrivere i predefiniti
 * come file più recente avrebbe invece rimesso 127.0.0.1 sopra un PACS
 * configurato.
 */
function reset() {
  try {
    fs.rmSync(personalPath(), { force: true });
  } catch (err) {
    return { ok: false, errors: [`Impossibile ripristinare: ${err.message}`], values: current };
  }
  load();
  return { ok: true, errors: [], values: current };
}

function describe() {
  return {
    schema: SCHEMA,
    defaults: DEFAULTS,
    values: current,
    source: status.source,
    configured: status.source !== 'default',
    file: status.file || personalPath(),
    personalFile: personalPath(),
    sharedFile: sharedPath(),
    warnings: status.warnings,
  };
}

module.exports = { load, save, reset, describe, validate, isLoopback, setPathsForTest, DEFAULTS, SCHEMA };
