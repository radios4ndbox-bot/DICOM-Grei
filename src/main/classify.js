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
 * Percorre dataRoot una volta sola. Restituisce solo i file da copiare (gli
 * scarti sono contati, non elencati): tutto il resto — conteggi per cartella,
 * file diretti, cartelle con file propri — si ricava da questo elenco, così che
 * un filtro applicato dopo (vedi onlyDicomExtension) si rifletta ovunque.
 *
 * @returns {{
 *   files: {p:string, sub:string, d:number}[], // sub = cartella di primo livello, d = profondità
 *   dirs: string[],                            // cartelle di primo livello
 *   junk: number,
 *   truncated: boolean
 * }}
 */
function walkOnce(dataRoot) {
  const files = [];
  const dirs = [];
  let junk = 0;
  let truncated = false;

  // [cartella, sottocartella di primo livello, profondità]
  const stack = [[dataRoot, '', 0]];

  while (stack.length) {
    const [cur, sub, depth] = stack.pop();
    for (const e of safeReaddir(cur)) {
      const p = path.join(cur, e.name);

      if (e.isDirectory()) {
        if (depth === 0) dirs.push(e.name);
        stack.push([p, depth === 0 ? e.name : sub, depth + 1]);
        continue;
      }
      if (!e.isFile()) continue;

      if (isJunk(e.name)) {
        junk++;
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        continue;
      }
      files.push({ p, sub, d: depth });
    }
  }

  return { files, dirs, junk, truncated };
}

/**
 * Conteggi derivati dall'elenco dei file DA COPIARE.
 *
 * Prima "cartella con file propri" contava anche i file scartati: una cartella
 * del visualizzatore piena di .exe e .dll risultava una sottocartella di
 * immagini, e poteva spostare la classificazione verso il Tipo C.
 */
function summarize(files) {
  const counts = new Map();
  const rootNames = [];
  const directFileDirs = new Set();
  for (const f of files) {
    counts.set(f.sub, (counts.get(f.sub) || 0) + 1);
    if (f.d === 0) rootNames.push(path.basename(f.p));
    else if (f.d === 1) directFileDirs.add(f.sub);
  }
  return { counts, rootNames, directFileDirs };
}

/**
 * Supporti le cui immagini hanno già estensione .dcm (Tipo G del report sul
 * campo: `D:\0\0.x\*.dcm`). Lì il comando a mano è `for /r ... (*.dcm)`: tutto
 * ciò che non è .dcm appartiene al visualizzatore o al sistema, e copiarlo
 * significa solo inviare file che il PACS rifiuterà come "Bad DICOM file".
 *
 * Si applica solo se i .dcm sono la maggioranza: un supporto con immagini
 * senza estensione e un .dcm isolato non deve perdere le immagini.
 */
function onlyDicomExtension(files) {
  let dcm = 0;
  for (const f of files) if (f.p.toLowerCase().endsWith('.dcm')) dcm++;
  if (dcm === 0 || dcm === files.length || dcm * 2 < files.length) {
    return { files, excluded: 0 };
  }
  const kept = files.filter((f) => f.p.toLowerCase().endsWith('.dcm'));
  return { files: kept, excluded: files.length - kept.length };
}

/**
 * Ordine di lettura il più vicino possibile a quello fisico sul disco.
 *
 * Su CD/DVD i record di directory ISO9660/UDF sono ordinati per nome e i
 * programmi di masterizzazione scrivono i dati nello stesso ordine: leggere
 * così significa far avanzare la testina invece di farla saltare. Il percorso
 * della visita (una pila, quindi a ritroso fra cartelle sorelle) non lo
 * garantiva. Il confronto è per segmento di percorso: con '\0' come separatore
 * "1" precede "10" come nel record di directory, mentre con '\' finirebbe dopo.
 */
function sortDiscOrder(files) {
  const keyed = files.map((f) => ({ f, k: f.p.toUpperCase().split(path.sep).join('\0') }));
  keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return keyed.map((x) => x.f);
}

// Budget di tempo per leggere le dimensioni dei file. Su CD la dimensione sta
// nel record di directory già letto dalla visita, quindi di norma è gratis; il
// budget esiste perché non lo è su ogni lettore, e l'avvio non deve pagarlo.
const SIZE_BUDGET_MS = 3000;

/** Dimensione totale: esatta se il budget basta, altrimenti stimata dalla media. */
function measure(files) {
  const t0 = Date.now();
  let bytes = 0;
  let n = 0;
  for (const f of files) {
    if (Date.now() - t0 > SIZE_BUDGET_MS) break;
    try {
      f.size = fs.statSync(f.p).size;
      bytes += f.size;
      n++;
    } catch {
      // file sparito o illeggibile: lo scoprirà la copia
    }
  }
  if (files.length === 0) return { totalBytes: 0, bytesEstimated: false };
  if (n === 0) return { totalBytes: null, bytesEstimated: true };
  if (n === files.length) return { totalBytes: bytes, bytesEstimated: false };
  return { totalBytes: Math.round((bytes / n) * files.length), bytesEstimated: true };
}

function decide(dataRoot, w, files, extra) {
  const sum = summarize(files);
  const tree = w.dirs
    .map((name) => ({ name, count: sum.counts.get(name) || 0 }))
    .concat(sum.counts.get('') ? [{ name: '(file diretti)', count: sum.counts.get('') }] : []);

  const base = {
    dataRoot,
    // sempre valorizzato: se l'operatore forza il Tipo C su un supporto
    // classificato altrimenti, la copia deve sapere su cosa mettere i suffissi
    subfolders: w.dirs,
    tree,
    totalFiles: files.length,
    totalBytes: extra.totalBytes,
    bytesEstimated: extra.bytesEstimated,
    skippedJunk: w.junk + extra.excluded,
    excludedNonDcm: extra.excluded,
    truncated: w.truncated,
  };

  // I file scartati come "non immagine" non devono spostare la classificazione:
  // si guarda sempre a cosa resta da copiare.
  const keptRoot = sum.rootNames;

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

  const fileSubdirs = w.dirs.filter((d) => sum.directFileDirs.has(d));

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
  const { files: kept, excluded } = onlyDicomExtension(w.files);
  const files = sortDiscOrder(kept);
  const { totalBytes, bytesEstimated } = measure(files);

  const plan = decide(dataRoot, w, files, { excluded, totalBytes, bytesEstimated });
  if (excluded) {
    plan.reasoning +=
      ` Immagini con estensione .dcm: copiati solo i .dcm, ${excluded} altri file esclusi` +
      ' (visualizzatore e dati di sistema).';
  }
  // la profondità serviva solo alla classificazione: non viaggia oltre
  for (const f of files) delete f.d;
  return { plan, files };
}

function classify(sourcePath) {
  return scanSource(sourcePath).plan;
}

module.exports = { classify, scanSource, isJunk, isMpName, sortDiscOrder, onlyDicomExtension };
