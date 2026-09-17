'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Classificazione del supporto, con UNA sola passata sull'albero.
 *
 * Prima l'albero veniva percorso tre volte: una per contare i file di ogni
 * sottocartella, una per il totale e una terza dentro stageFiles al momento di
 * copiare. Su un DVD, dove ogni readdir costa un riposizionamento della
 * testina, erano i due terzi del tempo di avvio dell'importazione. Qui si
 * percorre una volta sola e l'elenco dei file viene restituito al chiamante,
 * che lo passa alla copia.
 */

// Cap di sicurezza: un supporto con più file di così non è un esame.
const MAX_FILES = 300000;

// Estensioni che su un CD di refertazione non sono MAI immagini: sono il
// visualizzatore, i suoi dati e la roba di Windows. Copiarle significa portarsi
// in staging centinaia di MB che storescu non invierà comunque.
// L'elenco è volutamente prudente: niente estensioni ambigue (.dat, .img, .raw)
// e niente file senza estensione, che nel Tipo B sono proprio le immagini.
const SKIP_EXT = new Set([
  '.exe', '.dll', '.msi', '.cab', '.sys', '.ocx', '.scr', '.com', '.drv',
  '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jse', '.wsf', '.hta', '.lnk', '.url',
  '.ini', '.inf', '.cfg', '.log', '.txt', '.rtf', '.doc', '.docx', '.pdf',
  '.htm', '.html', '.css', '.xml', '.xsl', '.chm', '.hlp', '.manifest',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.iso', '.cue', '.bin',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.tif', '.tiff', '.svg',
  '.mp3', '.mp4', '.avi', '.wav', '.wmv', '.mov', '.ttf', '.fon', '.otf',
]);

const SKIP_NAME = new Set(['dicomdir', 'autorun.inf', 'thumbs.db', 'desktop.ini']);

function isJunk(name) {
  const low = name.toLowerCase();
  if (SKIP_NAME.has(low)) return true;
  const ext = path.extname(low);
  return ext !== '' && SKIP_EXT.has(ext);
}

function isMpName(name) {
  return /^MP[\w.-]*$/i.test(name);
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function looksLikeDicomBucket(name) {
  return /^(dicom|images?)$/i.test(name);
}

// Individua la cartella che contiene realmente i dati DICOM.
function findDataRoot(sourcePath) {
  const bucket = safeReaddir(sourcePath).find(
    (e) => e.isDirectory() && looksLikeDicomBucket(e.name)
  );
  return bucket ? path.join(sourcePath, bucket.name) : sourcePath;
}

/**
 * Percorre dataRoot una volta sola.
 *
 * @returns {{
 *   files: {p:string, sub:string}[],  // sub = cartella di primo livello ('' se file diretto)
 *   counts: Map<string, number>,      // file per cartella di primo livello
 *   rootFiles: string[],              // nomi dei file direttamente in dataRoot
 *   dirs: string[],                   // cartelle di primo livello
 *   directFileDirs: Set<string>,      // fra quelle, chi ha file propri (non annidati)
 *   junk: number,
 *   truncated: boolean
 * }}
 */
function walkOnce(dataRoot) {
  const files = [];
  const counts = new Map();
  const rootFiles = [];
  const dirs = [];
  const directFileDirs = new Set();
  let junk = 0;
  let truncated = false;

  // [cartella, sottocartella di primo livello, profondità]
  const stack = [[dataRoot, '', 0]];

  while (stack.length) {
    const [cur, sub, depth] = stack.pop();
    for (const e of safeReaddir(cur)) {
      const p = path.join(cur, e.name);

      if (e.isDirectory()) {
        const nextSub = depth === 0 ? e.name : sub;
        if (depth === 0) dirs.push(e.name);
        stack.push([p, nextSub, depth + 1]);
        continue;
      }
      if (!e.isFile()) continue;

      if (depth === 0) rootFiles.push(e.name);
      else if (depth === 1) directFileDirs.add(sub);

      if (isJunk(e.name)) {
        junk++;
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        continue;
      }
      files.push({ p, sub });
      counts.set(sub, (counts.get(sub) || 0) + 1);
    }
  }

  return { files, counts, rootFiles, dirs, directFileDirs, junk, truncated };
}

function decide(dataRoot, w) {
  const tree = w.dirs
    .map((name) => ({ name, count: w.counts.get(name) || 0 }))
    .concat(w.counts.get('') ? [{ name: '(file diretti)', count: w.counts.get('') }] : []);

  const base = {
    dataRoot,
    // sempre valorizzato: se l'operatore forza il Tipo C su un supporto
    // classificato altrimenti, la copia deve sapere su cosa mettere i suffissi
    subfolders: w.dirs,
    tree,
    totalFiles: w.files.length,
    skippedJunk: w.junk,
    truncated: w.truncated,
  };

  // I file scartati come "non immagine" non devono spostare la classificazione:
  // si guarda sempre a cosa resta da copiare.
  const keptRoot = w.rootFiles.filter((n) => !isJunk(n));

  if (keptRoot.some(isMpName)) {
    return {
      ...base,
      type: 'A',
      pattern: 'MP*',
      strategy: 'keep',
      reasoning:
        'File con prefisso MP* direttamente nella cartella DICOM (Tipo A). Copia diretta, scan-pattern "MP*".',
    };
  }

  if (keptRoot.length > 0) {
    return {
      ...base,
      type: 'B',
      pattern: '*.dcm',
      strategy: 'rename',
      reasoning:
        'File numerici senza estensione direttamente nella cartella (Tipo B). Copia con rinomina in .dcm.',
    };
  }

  if (w.dirs.length === 0) {
    return {
      ...base,
      type: 'UNKNOWN',
      pattern: '*.dcm',
      strategy: 'rename',
      reasoning:
        'Nessun file e nessuna sottocartella trovati nella cartella dati. Verificare il supporto o forzare il tipo manualmente.',
    };
  }

  const fileSubdirs = w.dirs.filter((d) => w.directFileDirs.has(d));

  if (fileSubdirs.length >= 2) {
    return {
      ...base,
      type: 'C',
      pattern: '*.dcm',
      strategy: 'suffix',
      subfolders: fileSubdirs,
      reasoning:
        `${fileSubdirs.length} sottocartelle con file numerici e nomi potenzialmente identici ` +
        '(Tipo C). Copia con suffisso progressivo per sottocartella.',
    };
  }

  if (fileSubdirs.length === 1) {
    return {
      ...base,
      type: 'B',
      pattern: '*.dcm',
      strategy: 'rename',
      reasoning:
        'Una sola sottocartella con file (Tipo B annidato di un livello). Copia ricorsiva con rinomina in .dcm.',
    };
  }

  return {
    ...base,
    type: 'D',
    pattern: '*.dcm',
    strategy: 'rename',
    reasoning:
      'Struttura profondamente annidata: nessun file ai primi livelli (Tipo D). ' +
      'Copia ricorsiva con rinomina in .dcm e suffisso anti-collisione.',
  };
}

/**
 * Classifica la sorgente in uno dei tipi A–D e restituisce anche l'elenco dei
 * file trovati, così che la copia non debba ripercorrere l'albero.
 * (E = ISO, F = ZIP sono gestiti a monte da isoZip/prepareSource.)
 */
function scanSource(sourcePath) {
  const dataRoot = findDataRoot(sourcePath);
  const w = walkOnce(dataRoot);
  return { plan: decide(dataRoot, w), files: w.files };
}

function classify(sourcePath) {
  return scanSource(sourcePath).plan;
}

module.exports = { classify, scanSource, isJunk, isMpName };
