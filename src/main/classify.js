'use strict';

const fs = require('fs');
const path = require('path');

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function countFilesRecursive(dir, cap = 200000) {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < cap) {
    const cur = stack.pop();
    for (const e of safeReaddir(cur)) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) n++;
    }
  }
  return n;
}

function looksLikeDicomBucket(name) {
  return /^(dicom|images?)$/i.test(name);
}

// Individua la cartella che contiene realmente i dati DICOM.
function findDataRoot(sourcePath) {
  const entries = safeReaddir(sourcePath);
  const bucket = entries.find((e) => e.isDirectory() && looksLikeDicomBucket(e.name));
  if (bucket) return path.join(sourcePath, bucket.name);
  return sourcePath;
}

function splitEntries(dir) {
  const files = [];
  const dirs = [];
  for (const e of safeReaddir(dir)) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) files.push(e.name);
  }
  return { files, dirs };
}

function dirHasDirectFiles(dir) {
  return safeReaddir(dir).some((e) => e.isFile());
}

function isMpName(name) {
  return /^MP[\w.-]*$/i.test(name);
}

/**
 * Classifica la sorgente in uno dei tipi A–D.
 * (E = ISO, F = ZIP sono gestiti a monte da isoZip/prepareSource.)
 *
 * @returns {{
 *   type: 'A'|'B'|'C'|'D'|'UNKNOWN',
 *   pattern: 'MP*'|'*.dcm',
 *   strategy: 'keep'|'rename'|'suffix',
 *   dataRoot: string,
 *   subfolders: string[],
 *   totalFiles: number,
 *   tree: {name:string,count:number}[],
 *   reasoning: string
 * }}
 */
function classify(sourcePath) {
  const dataRoot = findDataRoot(sourcePath);
  const { files, dirs } = splitEntries(dataRoot);

  const tree = dirs
    .map((name) => ({ name, count: countFilesRecursive(path.join(dataRoot, name)) }))
    .concat(files.length ? [{ name: '(file diretti)', count: files.length }] : []);

  const base = { dataRoot, subfolders: [], tree, totalFiles: countFilesRecursive(dataRoot) };

  if (files.some(isMpName)) {
    return {
      ...base,
      type: 'A',
      pattern: 'MP*',
      strategy: 'keep',
      reasoning: 'File con prefisso MP* direttamente nella cartella DICOM (Tipo A). Copia diretta, scan-pattern "MP*".',
    };
  }

  if (files.length > 0) {
    return {
      ...base,
      type: 'B',
      pattern: '*.dcm',
      strategy: 'rename',
      reasoning: 'File numerici senza estensione direttamente nella cartella (Tipo B). Copia con rinomina in .dcm.',
    };
  }

  if (dirs.length === 0) {
    return {
      ...base,
      type: 'UNKNOWN',
      pattern: '*.dcm',
      strategy: 'rename',
      reasoning: 'Nessun file e nessuna sottocartella trovati nella cartella dati. Verificare il supporto o forzare il tipo manualmente.',
    };
  }

  const fileSubdirs = dirs.filter((d) => dirHasDirectFiles(path.join(dataRoot, d)));

  if (fileSubdirs.length >= 2) {
    return {
      ...base,
      type: 'C',
      pattern: '*.dcm',
      strategy: 'suffix',
      subfolders: fileSubdirs,
      reasoning: `${fileSubdirs.length} sottocartelle con file numerici e nomi potenzialmente identici (Tipo C). Copia con suffisso progressivo per sottocartella.`,
    };
  }

  if (fileSubdirs.length === 1) {
    return {
      ...base,
      type: 'B',
      pattern: '*.dcm',
      strategy: 'rename',
      reasoning: 'Una sola sottocartella con file (Tipo B annidato di un livello). Copia ricorsiva con rinomina in .dcm.',
    };
  }

  return {
    ...base,
    type: 'D',
    pattern: '*.dcm',
    strategy: 'rename',
    reasoning: 'Struttura profondamente annidata: nessun file ai primi livelli (Tipo D). Copia ricorsiva con rinomina in .dcm e suffisso anti-collisione.',
  };
}

module.exports = { classify, countFilesRecursive };
