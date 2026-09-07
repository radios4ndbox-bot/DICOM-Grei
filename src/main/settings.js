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
  FILE_COPY_TIMEOUT_S: 15,
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

function settingsPath() {
  try {
    // require dentro la funzione: così il modulo resta caricabile fuori da Electron
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'settings.json');
  } catch {
    return path.join(os.tmpdir(), 'dicom-import-settings.json');
  }
}

let current = { ...DEFAULTS };

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

  config.STALL_WARN_MS = current.STALL_WARN_S * 1000;
  config.FILE_COPY_TIMEOUT_MS = current.FILE_COPY_TIMEOUT_S * 1000;
}

function load() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    stored = {};
  }
  // un file manomesso o di una versione precedente non deve rompere l'avvio
  const { values } = validate(stored && typeof stored === 'object' ? stored : {}, DEFAULTS);
  current = values;
  apply();
  return current;
}

function save(input) {
  const { values, errors } = validate(input || {}, current);
  if (errors.length) return { ok: false, errors, values: current };

  current = values;
  apply();
  try {
    const p = settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(current, null, 2), 'utf8');
  } catch (err) {
    return { ok: false, errors: [`Impossibile salvare: ${err.message}`], values: current };
  }
  return { ok: true, errors: [], values: current };
}

function reset() {
  current = { ...DEFAULTS };
  apply();
  try {
    const p = settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(current, null, 2), 'utf8');
  } catch {}
  return { ok: true, errors: [], values: current };
}

function describe() {
  return { schema: SCHEMA, defaults: DEFAULTS, values: current, file: settingsPath() };
}

module.exports = { load, save, reset, describe, validate, DEFAULTS, SCHEMA };
