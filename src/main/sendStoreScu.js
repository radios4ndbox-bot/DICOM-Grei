'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config');

const ALLOWED_PATTERNS = ['MP*', '*.dcm'];

// `head` sono le opzioni prima del peer, `tail` gli argomenti posizionali dopo.
function buildArgs(head, tail) {
  return [
    '-v',
    ...head,
    '--propose-lossless',
    // Senza questi, DCMTK aspetta il PACS all'infinito (default: unlimited).
    '--dimse-timeout', String(config.DIMSE_TIMEOUT_S),
    '--acse-timeout', String(config.ACSE_TIMEOUT_S),
    '--timeout', String(config.CONNECT_TIMEOUT_S),
    '-aet', config.SRC_AET,
    '-aec', config.DEST_AET,
    config.PACS_IP,
    config.PACS_PORT,
    ...tail,
  ];
}

// File presenti in una cartella di staging che storescu prenderebbe in carico.
function stagedFiles(dir, pattern) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const match =
    pattern === 'MP*' ? (n) => /^MP/i.test(n) : (n) => n.toLowerCase().endsWith('.dcm');
  return names.filter((e) => e.isFile() && match(e.name)).map((e) => path.join(dir, e.name));
}

/**
 * Attesa interrompibile. Con un semplice setTimeout, premere "Interrompi"
 * durante il backoff fra due ritentativi non avrebbe effetto fino a 60 s dopo.
 */
function sleep(ms, isCancelled) {
  return new Promise((resolve) => {
    const step = 250;
    let waited = 0;
    const t = setInterval(() => {
      waited += step;
      if (waited >= ms || (isCancelled && isCancelled())) {
        clearInterval(t);
        resolve();
      }
    }, step);
  });
}

// Invio di un'intera cartella di staging (un worker = un'associazione DICOM).
function dirArgs(dir, pattern) {
  return buildArgs(['+sd'], [dir, '--scan-pattern', pattern]);
}

// Invio di file espliciti: usato solo dai ritentativi, niente scan-pattern.
function fileArgs(files) {
  return buildArgs([], files);
}

/**
 * Ogni file inviato deve stare dentro lo staging. I percorsi arrivano dal
 * parsing dell'output di storescu: trattarli come dati, non come verità.
 */
function insideStaging(p) {
  const base = path.resolve(config.STAGING_DIR);
  const c = path.resolve(p);
  return c === base || c.startsWith(base + path.sep);
}

/**
 * Lancia un processo storescu e fa il parsing riga per riga.
 *
 * Il conteggio si basa SOLO su "Received Store Response (...)": storescu ne
 * emette esattamente una per file, con lo stato fra parentesi. Contare anche
 * "Sending file:" produrrebbe doppioni.
 */
function runStorescu(args, { onLog, onFile, register }) {
  return new Promise((resolve, reject) => {
    // Variabili lette da DCMTK (dcmnet), verificate con "storescu -ll trace":
    // - TCP_NODELAY: senza variabile questa build lascia l'algoritmo di Nagle
    //   ATTIVO ("using the default value (0)"). Il C-STORE è uno scambio
    //   richiesta/risposta per ogni file: Nagle insieme all'ACK ritardato di
    //   Windows può aggiungere un'attesa a ogni singolo file.
    // - TCP_BUFFER_LENGTH: senza variabile DCMTK usa i buffer di sistema
    //   (auto-tuning). Si passa solo se impostato esplicitamente.
    const env = { ...process.env, TCP_NODELAY: '1' };
    if (config.TCP_BUFFER_BYTES > 0) env.TCP_BUFFER_LENGTH = String(config.TCP_BUFFER_BYTES);
    const child = spawn(config.STORESCU, args, { windowsHide: true, env });

    let buf = '';
    let current = null;
    let killed = false;

    // il listener va agganciato PRIMA di register(): se l'invio è già stato
    // annullato, register() emette '__cancel' subito
    child.once('__cancel', () => {
      killed = true;
      try {
        child.kill();
      } catch {}
    });
    if (register) register(child);

    // Formati verificati sui letterali dentro storescu.exe (DCMTK 3.7.0):
    //   "Sending file: <path>"
    //   "Received Store Response"            <- SUCCESSO, senza parentesi
    //   "Received Store Response (<stato>)"  <- esito non-Success
    //   "Store Failed, file: <path>:"        <- segue un errore già contato
    //   "No presentation context for: ..."   <- file mai inviato
    //   "Bad DICOM file: <path>: ..."        <- file illeggibile, mai inviato
    //
    // Si conta UNA sola volta per file: le "Store Failed" non incrementano,
    // perché arrivano sempre dopo una Response già conteggiata.
    const handleLine = (line) => {
      if (!line) return;
      onLog(line);

      let m = line.match(/Sending file:\s*(.+?)\s*$/i);
      if (m) {
        current = m[1];
        return;
      }

      m = line.match(/Received Store Response\s*\((.*)\)\s*$/i);
      if (m) {
        const status = m[1].trim();
        // un Warning (es. coercizione di elementi) significa comunque memorizzato
        onFile({ file: current, ok: /warning/i.test(status), status });
        current = null;
        return;
      }

      if (/Received Store Response\s*$/i.test(line)) {
        onFile({ file: current, ok: true, status: 'Success' });
        current = null;
        return;
      }

      m = line.match(/Bad DICOM file:\s*(.+?)\s*:/i);
      if (m) {
        onFile({ file: m[1], ok: false, permanent: true, status: 'Bad DICOM file' });
        current = null;
        return;
      }

      if (/No presentation context for:/i.test(line)) {
        // il PACS non accetta quella SOP class / transfer syntax: ritentare è inutile
        onFile({ file: current, ok: false, permanent: true, status: 'No presentation context' });
        current = null;
      }
    };

    const onChunk = (chunk) => {
      buf += chunk.toString();
      // una riga patologicamente lunga non deve far crescere il buffer all'infinito
      if (buf.length > 1024 * 1024) buf = buf.slice(-4096);
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const p of parts) handleLine(p.trim());
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf.trim());
      resolve({ exitCode: code, killed });
    });
  });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Invia lo staging al PACS.
 *
 * Il collo di bottiglia di un import grande non è la CPU ma il round-trip di
 * ogni C-STORE su una singola associazione: 5142 file in un'ora sono ~0,7 s a
 * file, quasi tutta attesa. Girando N associazioni in parallelo (una per
 * sottocartella `part_NN`) il tempo scende in proporzione.
 *
 * Dopo il primo passaggio i soli file falliti vengono ritentati, in modo che un
 * singolo errore non costringa a rifare tutto.
 *
 * @param {{pattern:string, partDirs:string[], totalFiles:number, retries?:number}} opts
 * @param {(ev:{type:'log'|'progress',line?:string,data?:object})=>void} emit
 */
function sendStoreScu(opts, emit) {
  const { pattern, partDirs, totalFiles } = opts;
  const retries = opts.retries != null ? opts.retries : config.SEND_RETRIES;

  const children = new Set();
  let cancelled = false;

  const state = {
    success: 0,
    failed: 0,
    total: totalFiles,
    released: false,
    aborted: false,
    exitCode: null,
    retried: 0,
    cancelled: false,
    permanentFailures: [],
  };

  const startedAt = Date.now();
  let lastActivity = Date.now();
  let stalled = false;

  // Esito per file, chiave = percorso normalizzato. Serve a non contare due
  // volte lo stesso file fra primo passaggio e ritentativi: se un file passa da
  // fallito a riuscito i contatori si spostano, non si sommano.
  const norm = (p) => path.resolve(p).toLowerCase();
  const outcomes = new Map(); // key -> true|false
  let retryQueue = new Map(); // key -> percorso originale
  const permanent = new Map();
  let anon = 0;

  const setOutcome = (key, ok) => {
    const prev = outcomes.get(key);
    if (prev === undefined) {
      ok ? state.success++ : state.failed++;
    } else if (prev !== ok) {
      if (ok) {
        state.success++;
        state.failed--;
      } else {
        state.success--;
        state.failed++;
      }
    }
    outcomes.set(key, ok);
  };

  const emitProgress = () => {
    const done = state.success + state.failed;
    const elapsed = (Date.now() - startedAt) / 1000;
    // ETA solo dopo qualche file: prima la stima è rumore
    const rate = done >= 5 && elapsed > 0 ? done / elapsed : 0;
    const etaSec = rate > 0 && state.total > done ? Math.round((state.total - done) / rate) : null;
    emit({
      type: 'progress',
      data: {
        phase: 'send',
        sent: done,
        success: state.success,
        failed: state.failed,
        total: state.total,
        etaSec,
        rate: Math.round(rate * 10) / 10,
        stalled,
      },
    });
  };

  const onLog = (line) => {
    emit({ type: 'log', line });
    if (/Releasing Association/i.test(line)) state.released = true;
    if (/Aborting Association|Association Request Failed|Failed to establish association/i.test(line)) {
      state.aborted = true;
    }
  };

  const onFile = (r) => {
    lastActivity = Date.now();
    if (stalled) {
      stalled = false;
      emit({ type: 'log', line: '> il PACS ha ripreso a rispondere' });
    }

    const usable = r.file && insideStaging(r.file);
    const key = usable ? norm(r.file) : `__anon_${anon++}`;

    setOutcome(key, !!r.ok);

    if (r.ok) {
      retryQueue.delete(key);
    } else if (usable) {
      if (r.permanent) {
        permanent.set(key, r.file);
        retryQueue.delete(key);
      } else if (!permanent.has(key)) {
        retryQueue.set(key, r.file);
      }
    }
    emitProgress();
  };

  const register = (c) => {
    children.add(c);
    c.on('close', () => children.delete(c));
    if (cancelled) c.emit('__cancel');
  };

  const run = async () => {
    if (!fs.existsSync(config.STORESCU)) {
      throw new Error(
        `storescu.exe non trovato in: ${config.STORESCU} — verifica l'installazione di dcmtk.`
      );
    }
    if (!ALLOWED_PATTERNS.includes(pattern)) {
      throw new Error(`scan-pattern non consentito: "${pattern}". Ammessi solo "MP*" o "*.dcm".`);
    }
    if (!partDirs || partDirs.length === 0) throw new Error('Nessuna cartella di staging da inviare.');
    for (const d of partDirs) {
      if (!insideStaging(d)) throw new Error(`Cartella fuori dallo staging: ${d}`);
    }

    // Il totale della barra deve essere quello che storescu invierà davvero,
    // non quanti file sono stati copiati: con il Tipo A si copia tutto il
    // contenuto del supporto ma si invia solo ciò che combacia con "MP*",
    // quindi il totale da copiare sarebbe irraggiungibile e l'ETA mai risolta.
    let inviabili = 0;
    for (const d of partDirs) inviabili += stagedFiles(d, pattern).length;
    if (inviabili === 0) {
      // meglio dirlo subito che lasciar girare storescu a vuoto e chiudere con
      // "0 inviati" senza spiegazione
      throw new Error(
        `Nessun file in staging corrisponde a "${pattern}": ` +
          'il tipo di supporto rilevato non combacia con il contenuto. ' +
          'Forzare un tipo diverso dalla tendina e riprovare.'
      );
    }
    state.total = inviabili;

    emit({
      type: 'log',
      line:
        `> ${partDirs.length} associazione/i in parallelo verso ${config.PACS_IP}:${config.PACS_PORT}` +
        ` · ${state.total} file da inviare`,
    });
    emitProgress();

    // ---- passaggio principale: un worker per sottocartella
    const results = await Promise.all(
      partDirs.map((d) => {
        const args = dirArgs(d, pattern);
        emit({ type: 'log', line: `> storescu ${args.join(' ')}` });
        return runStorescu(args, { onLog, onFile, register });
      })
    );
    state.exitCode = results.reduce((acc, r) => (r.exitCode ? r.exitCode : acc), 0);

    // Se storescu è morto a metà (timeout DIMSE perché il PACS non rispondeva
    // più) i file successivi non hanno prodotto NESSUNA riga: non risultano né
    // riusciti né falliti. Vanno recuperati confrontando con lo staging, altrimenti
    // sparirebbero in silenzio.
    const collectUnattempted = () => {
      let n = 0;
      for (const d of partDirs) {
        for (const f of stagedFiles(d, pattern)) {
          const k = norm(f);
          if (!outcomes.has(k) && !permanent.has(k) && !retryQueue.has(k)) {
            retryQueue.set(k, f);
            n++;
          }
        }
      }
      return n;
    };

    const missing = collectUnattempted();
    if (missing > 0) {
      emit({
        type: 'log',
        line: `> ${missing} file non tentati (associazione caduta): verranno ripresi da lì`,
      });
    }

    // ---- ritentativi: file falliti + file mai tentati
    for (let attempt = 1; attempt <= retries && retryQueue.size > 0 && !cancelled; attempt++) {
      const files = [...retryQueue.values()].filter((f) => {
        try {
          return fs.statSync(f).isFile();
        } catch {
          return false;
        }
      });
      if (files.length === 0) break;

      retryQueue = new Map();
      state.retried += files.length;

      // Il PACS può essere occupato (esame aperto in refertazione dal RIS):
      // si aspetta, con attesa crescente, invece di martellarlo.
      const wait = config.RETRY_BACKOFF_MS[attempt - 1] || config.RETRY_BACKOFF_MS.slice(-1)[0];
      emit({
        type: 'log',
        line: `> ritentativo ${attempt}/${retries} su ${files.length} file, fra ${Math.round(wait / 1000)} s`,
      });
      await sleep(wait, () => cancelled);
      if (cancelled) break;

      emitProgress();

      // il command line di Windows ha un limite: si spezza in blocchi
      for (const batch of chunk(files, 200)) {
        if (cancelled) break;
        await runStorescu(fileArgs(batch), { onLog, onFile, register });
      }
      collectUnattempted();
    }

    stalled = false;
    state.cancelled = cancelled;
    state.failedFiles = [...retryQueue.values(), ...permanent.values()];
    state.permanentFailures = [...permanent.values()];
    state.elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    emitProgress();
    return state;
  };

  // Sorveglianza: se il PACS smette di rispondere l'operatore deve vederlo
  // subito, non davanti a una barra ferma senza spiegazione.
  const watchdog = setInterval(() => {
    if (children.size === 0 || stalled) return;
    if (Date.now() - lastActivity < config.STALL_WARN_MS) return;
    stalled = true;
    emit({
      type: 'log',
      line: `> nessuna risposta dal PACS da ${Math.round(config.STALL_WARN_MS / 1000)} s — esame aperto in refertazione?`,
    });
    emitProgress();
  }, 5000);

  const promise = run().finally(() => clearInterval(watchdog));
  promise.cancel = () => {
    cancelled = true;
    state.cancelled = true;
    for (const c of children) c.emit('__cancel');
  };
  return promise;
}

module.exports = { sendStoreScu };
