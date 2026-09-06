'use strict';

const fs = require('fs');
const path = require('path');
const dicomParser = require('dicom-parser');

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
      else if (e.isFile() && !/^dicomdir$/i.test(e.name)) {
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

// I metadati stanno nei primi KB: non ha senso caricare in RAM un file enorme
// (o non-file) trovato su un supporto non fidato solo per leggere l'anagrafica.
const MAX_INFO_BYTES = 256 * 1024 * 1024;

function parseOne(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > MAX_INFO_BYTES) throw new Error('file non idoneo');
  const buf = fs.readFileSync(file);
  const ds = dicomParser.parseDicom(buf);
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
 * @returns {object|null}
 */
function readStudyInfo(dataRoot, plan) {
  const candidates = [];
  if (plan && plan.strategy === 'suffix' && Array.isArray(plan.subfolders) && plan.subfolders.length) {
    candidates.push(...firstFiles(path.join(dataRoot, plan.subfolders[0]), 6));
  }
  candidates.push(...firstFiles(dataRoot, 15));

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
