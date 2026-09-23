'use strict';

const fs = require('fs');
const path = require('path');
const dicomParser = require('dicom-parser');

const { isJunk } = require('./classify');

const MODALITY = {
  CT: 'TC — Tomografia Computerizzata',
  MR: 'RM — Risonanza Magnetica',
  DX: 'RX — Radiografia Digitale',
  CR: 'RX — Computed Radiography',
  RF: 'RX — Fluoroscopia',
  XA: 'Angiografia',
  MG: 'Mammografia',
  US: 'Ecografia',
  PT: 'PET',
  NM: 'Medicina Nucleare',
  SC: 'Secondary Capture',
  SR: 'Structured Report',
  OT: 'Altro',
};

function firstFiles(dir, limit) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const cur = stack.shift();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && !isJunk(e.name)) {
        out.push(p);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

function formatName(raw) {
  if (!raw) return { last: '', first: '', full: '' };
  const parts = String(raw).split('^');
  const last = (parts[0] || '').trim();
  const first = (parts[1] || '').trim();
  const full = [last, first].filter(Boolean).join(' ') || String(raw).trim();
  return { last, first, full };
}

function formatDate(d) {
  if (!/^\d{8}$/.test(d || '')) return d || '';
  return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
}

// I metadati stanno nei primi KB: su un DVD leggere per intero un'immagine da
// diversi MB solo per l'anagrafica costa secondi. Si leggono 128 KB e, se non
// bastano (blocchi privati voluminosi), 4 MB.
const HEADER_STEPS = [128 * 1024, 4 * 1024 * 1024];

function readHeader(file, size) {
  for (const step of HEADER_STEPS) {
    const want = Math.min(size, step);
    let fd;
    try {
      const buf = Buffer.allocUnsafe(want);
      fd = fs.openSync(file, 'r');
      const read = fs.readSync(fd, buf, 0, want, 0);
      // solo i byte letti: la coda di allocUnsafe non è inizializzata
      return dicomParser.parseDicom(buf.subarray(0, read), { untilTag: 'x7fe00010' });
    } catch {
      // intestazione troncata: si riprova più in grande
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
    if (want >= size) break; // il file era già stato letto per intero
  }
  throw new Error('intestazione non leggibile');
}

function parseOne(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size < 132) throw new Error('file non idoneo');
  const ds = readHeader(file, st.size);
  const name = formatName(ds.string('x00100010'));
  const modality = (ds.string('x00080060') || '').toUpperCase();
  return {
    patientLast: name.last,
    patientFirst: name.first,
    patientName: name.full,
    patientId: ds.string('x00100020') || '',
    birthDate: formatDate(ds.string('x00100030')),
    modality,
    modalityLabel: MODALITY[modality] || modality || '—',
    studyDate: formatDate(ds.string('x00080020')),
    studyDescription: ds.string('x00081030') || ds.string('x0008103e') || '',
    accession: ds.string('x00080050') || '',
    sampleFile: path.basename(file),
    samplePath: file,
  };
}

/**
 * Legge i dati anagrafici e di studio dal primo file DICOM leggibile.
 *
 * Il supporto è già stato percorso dalla classificazione: se l'elenco dei file
 * viene passato, non si rilegge nessuna cartella. Bastano pochi tentativi —
 * l'anagrafica è identica in tutte le immagini dello stesso studio.
 *
 * @param {string} dataRoot
 * @param {object} plan
 * @param {{p:string,sub:string}[]} [files] elenco già filtrato dalla scansione
 * @returns {object|null}
 */
function readStudyInfo(dataRoot, plan, files) {
  const candidates = [];

  if (Array.isArray(files) && files.length) {
    if (plan && plan.strategy === 'suffix') {
      // con più sottocartelle si parte da quella che la copia userà per prima
      const first = plan.subfolders && plan.subfolders[0];
      for (const f of files) {
        if (candidates.length >= 6) break;
        if (f.sub === first) candidates.push(f.p);
      }
    }
    for (const f of files) {
      if (candidates.length >= 15) break;
      candidates.push(f.p);
    }
  } else {
    if (plan && plan.strategy === 'suffix' && Array.isArray(plan.subfolders) && plan.subfolders.length) {
      candidates.push(...firstFiles(path.join(dataRoot, plan.subfolders[0]), 6));
    }
    candidates.push(...firstFiles(dataRoot, 15));
  }

  for (const f of candidates) {
    try {
      const info = parseOne(f);
      if (info.patientName || info.studyDate || info.modality) return info;
    } catch {
      // file non parsabile: prova il successivo
    }
  }
  return null;
}

module.exports = { readStudyInfo };
