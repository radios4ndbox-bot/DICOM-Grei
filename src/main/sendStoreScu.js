'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config');

const ALLOWED_PATTERNS = ['MP*', '*.dcm'];

// Ultima riga di comando lanciata: il main la offre all'operatore per rilanciare
// lo stesso invio da cmd, identico, quando vuole confrontare.
let lastCommand = '';

// CreateProcess di Windows taglia la riga di comando a 32767 caratteri. I
// ritentativi passano i file uno per uno come argomenti: si spezzano per
// lunghezza, non per numero, perché con percorsi lunghi 200 file bastano a
// superare il limite e il processo non parte nemmeno.
const CMDLINE_BUDGET = 24000;

// Sintassi di trasferimento proposte in associazione.
//
// ATTENZIONE a cosa significa "lossless" qui: questa build di storescu NON ha
// codec JPEG linkati (dipende solo da dcmdata/dcmnet/dcmtls/oflog/ofstd), quindi
// non ricomprime e non decomprime NULLA. I byte del dataset partono come stanno
// sul supporto, sempre, con qualsiasi opzione --propose-*.
//
// A cosa serve allora --propose-lossless: a far accettare al PACS un contesto
// di presentazione con la sintassi JPEG lossless, che serve ai file che sono
// GIA' compressi cosi' sul CD (moltissime TC e RM lo sono). Con
// --propose-uncompr quegli stessi file non troverebbero nessun contesto e
// uscirebbero come "No presentation context for:", cioe' persi.
const PROPOSE_FLAG = {
  lossless: '--propose-lossless',
  uncompr: '--propose-uncompr',
  little: '--propose-little',
  implicit: '--propose-implicit',
};

// `head` sono le opzioni prima del peer, `tail` gli argomenti posizionali dopo.
function buildArgs(head, tail) {
  const args = ['-v', ...head, PROPOSE_FLAG[config.PROPOSE_TS] || PROPOSE_FLAG.lossless];

  // Senza questi, DCMTK aspetta il PACS all'infinito (default: unlimited).
  // Si possono togliere per riprodurre esattamente un lancio a mano da cmd:
  // resta comunque la guardia di inattivita' di questo modulo, che un lancio
  // da cmd non ha.
  if (config.SEND_TIMEOUTS) {
    args.push(
      '--dimse-timeout', String(config.DIMSE_TIMEOUT_S),
      '--acse-timeout', String(config.ACSE_TIMEOUT_S),
      '--timeout', String(config.CONNECT_TIMEOUT_S)
    );
  }

  args.push(
    '-aet', config.SRC_AET,
    '-aec', config.DEST_AET,
    config.PACS_IP,
    config.PACS_PORT,
    ...tail
  );
  return args;
}

/**
 * Riga di comando pronta da incollare in `cmd`.
 *
 * Serve a confrontare come si deve: l'app e il lancio a mano devono usare
 * ESATTAMENTE gli stessi argomenti, altrimenti si confrontano due cose diverse.
 * Le virgolette seguono le regole di CreateProcess, che e' anche il modo in cui
 * spawn() passa gli argomenti: quello che si incolla e' quello che gira.
 */
function quoteForCmd(arg) {
  const s = String(arg);
  if (s !== '' && !/[\s"^&|<>()%!]/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}

function commandLine(args) {
  return [config.STORESCU, ...args].map(quoteForCmd).join(' ');
}

/**
 * Controlli che non dipendono dallo staging: si fanno PRIMA della copia.
 * Scoprire che storescu.exe manca dopo sette minuti di lettura del CD è il
 * modo peggiore di scoprirlo. Il pattern non arriva più a storescu (vedi
 * dirArgs) ma decide ancora cosa finisce in staging: resta verificato.
 */
function preflightSend(pattern) {
  if (!fs.existsSync(config.STORESCU)) {
    throw new Error(
      `storescu.exe non trovato in: ${config.STORESCU} — verifica l'installazione di dcmtk.`
    );
  }
  if (!ALLOWED_PATTERNS.includes(pattern)) {
    throw new Error(`scan-pattern non consentito: "${pattern}". Ammessi solo "MP*" o "*.dcm".`);
  }
}

/**
 * File presenti in una cartella di staging.
 *
 * Sono TUTTI quelli che storescu prendera' in carico, perche' gli si passa la
 * cartella senza filtro e in staging finisce solo cio' che va inviato (ci
 * pensa copyStage; i file ancora in copia stanno in una sottocartella, e
 * storescu senza +r non scende nelle sottocartelle).
 *
 * Prima qui si rifiltrava per pattern, e le due viste non combaciavano: con
 * "*.dcm" il filtro nostro trovava i file mentre storescu non ne trovava
 * nessuno. Il disallineamento faceva risultare "mai tentati" dei file che
 * nessuno aveva mai provato a inviare, e li mandava nei ritentativi.
 */
async function stagedFiles(dir) {
  let names;
  try {
    names = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
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

/**
 * Invio di un'intera cartella di staging (un worker = un'associazione DICOM).
 *
 * NESSUN --scan-pattern, di proposito. In staging finiscono solo i file da
 * inviare (copyStage copia soltanto quelli: nel Tipo A i soli "MP*", negli
 * altri tutti rinominati in .dcm), quindi basta indicare la cartella.
 *
 * E non e' una scelta di stile: con questo storescu il pattern "*.dcm" non
 * combacia con NESSUN file. Verificato lanciandolo come fa l'app, con spawn e
 * array di argomenti: "MP*" e "IMG*" trovano i file, "*.dcm" restituisce
 * "no input files to be sent". Il passaggio principale inviava quindi zero
 * file per i Tipi B, C e D, e tutto il trasferimento finiva nei ritentativi,
 * che passano i file elencati uno per uno: funzionava, ma per la strada piu'
 * lenta possibile.
 *
 * Il vincolo di non passare mai "*" resta rispettato: qui non si passa alcun
 * carattere jolly, e storescu percorre solo la cartella che gli indichiamo.
 */
function dirArgs(dir) {
  return buildArgs(['+sd'], [dir]);
}

// Invio di file espliciti: usato solo dai ritentativi, niente scan-pattern.
function fileArgs(files) {
  return buildArgs([], files);
}

/**
 * Ogni file inviato deve stare dentro lo staging. I percorsi arrivano dal
 * parsing dell'output di storescu: trattarli come dati, non come verità.
 *
 * Il confronto ignora le maiuscole su Windows: `c:\tmp\...` e `C:\tmp\...`
 * sono lo stesso percorso, ma un confronto sensibile al caso avrebbe
 * classificato come "fuori dallo staging" file perfettamente legittimi,
 * facendoli sparire dai contatori e dai ritentativi.
 */
function insideStaging(p) {
  const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const base = fold(path.resolve(config.STAGING_DIR));
  const c = fold(path.resolve(p));
  return c === base || c.startsWith(base + path.sep);
}

/**
 * Lancia un processo storescu e fa il parsing riga per riga.
 *
 * Il conteggio si basa SOLO su "Received Store Response (...)": storescu ne
 * emette esattamente una per file, con lo stato fra parentesi. Contare anche
 * "Sending file:" produrrebbe doppioni.
 *
 * Oltre ai timeout passati a DCMTK c'è una guardia nostra: se dal processo non
 * arriva un byte per SEND_STALL_KILL_MS, il processo viene ucciso. Serve per i
 * casi in cui DCMTK non applica i propri timeout — connessione stabilita e poi
 * silenzio, o processo bloccato in scrittura sul socket — che è esattamente il
 * modo in cui un invio restava appeso a tempo indeterminato con la barra ferma.
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
    const env = { ...process.env };
    if (config.TCP_NODELAY_ON) env.TCP_NODELAY = '1';
    if (config.TCP_BUFFER_BYTES > 0) env.TCP_BUFFER_LENGTH = String(config.TCP_BUFFER_BYTES);

    let child;
    try {
      child = spawn(config.STORESCU, args, { windowsHide: true, env });
    } catch (err) {
      return reject(err);
    }

    let buf = '';
    let current = null;
    let killed = false;
    let stallKilled = false;
    let settled = false;
    let lastByte = Date.now();

    const stop = (why) => {
      if (child.exitCode !== null || child.signalCode) return;
      killed = true;
      if (why === 'stall') stallKilled = true;
      try {
        child.kill();
      } catch {}
      // se non muore col segnale gentile, si insiste una volta sola
      setTimeout(() => {
        try {
          if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
        } catch {}
      }, 5000).unref();
    };

    // il listener va agganciato PRIMA di register(): se l'invio è già stato
    // annullato, register() emette '__cancel' subito
    child.once('__cancel', () => stop('cancel'));
    if (register) register(child);

    // il passo del controllo non deve essere più grosso della soglia, altrimenti
    // con soglie brevi si aspetta fino a un giro intero in più
    const step = Math.min(5000, Math.max(500, Math.round(config.SEND_STALL_KILL_MS / 4)));
    const guard = setInterval(() => {
      if (Date.now() - lastByte >= config.SEND_STALL_KILL_MS) {
        onLog(
          `> nessun dato da storescu da ${Math.round(config.SEND_STALL_KILL_MS / 1000)} s: ` +
            'associazione abbattuta, i file non inviati rientrano nei ritentativi'
        );
        stop('stall');
      }
    }, step);
    guard.unref();

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearInterval(guard);
      fn(arg);
    };

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
        // Forma reale a -v, verificata sul log di storescu contro un PACS:
        //   "Received Store Response (Success)"            -> memorizzato
        //   "Received Store Response (Warning: ...)"       -> memorizzato, con avviso
        //   "Received Store Response (Error: ...)"         -> non memorizzato
        // Il successo HA le parentesi. Considerare solo i Warning come
        // riusciti faceva contare ogni file memorizzato come fallito e lo
        // rimandava: il PACS riceveva tutto due volte.
        const ok = /^success/i.test(status) || /warning/i.test(status);
        onFile({ file: current, ok, status });
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
      lastByte = Date.now();
      buf += chunk.toString();
      // una riga patologicamente lunga non deve far crescere il buffer all'infinito
      if (buf.length > 1024 * 1024) buf = buf.slice(-4096);
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const p of parts) handleLine(p.trim());
    };

    if (child.stdout) child.stdout.on('data', onChunk);
    if (child.stderr) child.stderr.on('data', onChunk);

    child.on('error', (err) => done(reject, err));
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf.trim());
      done(resolve, { exitCode: code, killed, stallKilled });
    });
  });
}

/** Spezza un elenco di file in lotti che stanno nella riga di comando. */
function chunkByLength(files, budget = CMDLINE_BUDGET) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const f of files) {
    const cost = f.length + 3; // spazio + eventuali virgolette
    if (cur.length && len + cost > budget) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(f);
    len += cost;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Distribuisce i lotti su N esecuzioni parallele (una associazione ciascuna). */
function spread(batches, n) {
  const lanes = Array.from({ length: Math.max(1, Math.min(n, batches.length)) }, () => []);
  batches.forEach((b, i) => lanes[i % lanes.length].push(b));
  return lanes;
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
    stallKills: 0,
    permanentFailures: [],
    failedFiles: [],
  };

  const startedAt = Date.now();
  let lastActivity = Date.now();
  let stalled = false;

  // Esito per file, chiave = percorso normalizzato. Serve a non contare due
  // volte lo stesso file fra primo passaggio e ritentativi: se un file passa da
  // fallito a riuscito i contatori si spostano, non si sommano.
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const outcomes = new Map(); // key -> true|false
  let retryQueue = new Map(); // key -> percorso originale
  const permanent = new Map();
  let anon = 0;

  const setOutcome = (key, ok) => {
    const prev = outcomes.get(key);
    if (prev === undefined) {
      ok ? state.success++ : state.failed++;
      // file non riconosciuto (percorso assente nella riga): media dei noti
      doneBytes += sizes.has(key)
        ? sizes.get(key)
        : sizes.size
        ? Math.round(totalBytes / sizes.size)
        : 0;
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

  // Byte per file, dallo staging. L'ETA si fa sui byte e non sul numero di
  // file: dal report sul campo l'invio su una sola associazione tiene ~3 MB/s
  // costanti (3,2 e 2,9 MB/s su due CD), mentre in file al secondo va da 15,2 a
  // 8,7 a seconda della dimensione media delle immagini. Stimata a file, la
  // seconda sessione sarebbe uscita sbagliata del 43%; a byte, del 10%.
  const sizes = new Map(); // key -> byte
  let totalBytes = 0;
  let doneBytes = 0;

  const emitProgress = () => {
    const done = state.success + state.failed;
    const elapsed = (Date.now() - startedAt) / 1000;
    // stima solo dopo qualche file: prima misura l'apertura dell'associazione
    const warm = done >= 5 && elapsed >= 3;
    const byteRate = warm && elapsed > 0 ? doneBytes / elapsed : 0;
    const fileRate = warm && elapsed > 0 ? done / elapsed : 0;
    let etaSec = null;
    if (byteRate > 0 && totalBytes > doneBytes) etaSec = Math.round((totalBytes - doneBytes) / byteRate);
    else if (fileRate > 0 && state.total > done) etaSec = Math.round((state.total - done) / fileRate);
    emit({
      type: 'progress',
      data: {
        phase: 'send',
        sent: done,
        success: state.success,
        failed: state.failed,
        total: state.total,
        bytes: doneBytes,
        totalBytes,
        etaSec,
        rate: Math.round(fileRate * 10) / 10,
        mbps: Math.round((byteRate / 1048576) * 100) / 100,
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

  const killAll = () => {
    for (const c of children) {
      try {
        c.emit('__cancel');
      } catch {}
    }
  };

  // Ogni esecuzione, sia del passaggio principale sia dei ritentativi, registra
  // qui il proprio esito: il conteggio delle associazioni mute serve a decidere
  // se ha ancora senso ritentare.
  const runOne = async (args) => {
    const line = commandLine(args);
    emit({ type: 'log', line: '> ' + line });
    // Si offre alla copia solo la forma "+sd <cartella>": l'unico pezzo
    // variabile e' lo staging, che decidiamo noi. La forma con l'elenco dei
    // file conterrebbe nomi presi dal supporto, e cmd espande i %...% anche
    // dentro le virgolette.
    if (args.includes('+sd')) {
      lastCommand = line;
      emit({ type: 'command', line });
    }
    const r = await runStorescu(args, { onLog, onFile, register });
    if (r.exitCode) state.exitCode = r.exitCode;
    if (r.stallKilled) state.stallKills++;
    return r;
  };

  /**
   * Esegue più processi storescu insieme e NON lascia indietro i fratelli se
   * uno esplode: con Promise.all un rigetto usciva subito lasciando gli altri
   * processi vivi e scollegati, che continuavano a scrivere sul PACS mentre
   * l'app dichiarava l'invio finito.
   */
  const runParallel = async (argsList) => {
    const results = await Promise.allSettled(argsList.map(runOne));
    const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (errors.length) {
      killAll();
      for (const e of errors) {
        emit({ type: 'log', line: `> errore storescu: ${String((e && e.message) || e)}` });
      }
      // tutte fallite: non è un problema di singolo file, è l'invio che non parte
      if (errors.length === argsList.length) throw errors[0];
    }
  };

  const collectUnattempted = async () => {
    let n = 0;
    for (const d of partDirs) {
      for (const f of await stagedFiles(d)) {
        const k = norm(f);
        if (!outcomes.has(k) && !permanent.has(k) && !retryQueue.has(k)) {
          retryQueue.set(k, f);
          n++;
        }
      }
    }
    return n;
  };

  const run = async () => {
    preflightSend(pattern);
    if (!partDirs || partDirs.length === 0) throw new Error('Nessuna cartella di staging da inviare.');
    for (const d of partDirs) {
      if (!insideStaging(d)) throw new Error(`Cartella fuori dallo staging: ${d}`);
    }

    // Il totale della barra deve essere quello che storescu invierà davvero,
    // non quanti file sono stati copiati: con il Tipo A si copia tutto il
    // contenuto del supporto ma si invia solo ciò che combacia con "MP*",
    // quindi il totale da copiare sarebbe irraggiungibile e l'ETA mai risolta.
    let inviabili = 0;
    for (const d of partDirs) {
      const list = await stagedFiles(d);
      inviabili += list.length;
      // file locali: 64 stat alla volta costano pochi millisecondi anche su migliaia
      for (let i = 0; i < list.length; i += 64) {
        const part = list.slice(i, i + 64);
        const st = await Promise.all(part.map((f) => fs.promises.stat(f).catch(() => null)));
        part.forEach((f, j) => {
          if (st[j]) {
            sizes.set(norm(f), st[j].size);
            totalBytes += st[j].size;
          }
        });
      }
    }
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
        ` · ${state.total} file da inviare (${(totalBytes / 1048576).toFixed(1)} MB)`,
    });
    emitProgress();

    // ---- passaggio principale: un worker per sottocartella
    await runParallel(partDirs.map((d) => dirArgs(d)));

    // Se storescu è morto a metà (timeout DIMSE perché il PACS non rispondeva
    // più, o guardia di inattività) i file successivi non hanno prodotto NESSUNA
    // riga: non risultano né riusciti né falliti. Vanno recuperati confrontando
    // con lo staging, altrimenti sparirebbero in silenzio.
    const missing = await collectUnattempted();
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

      const before = state.success + state.failed;
      const killsBefore = state.stallKills;

      // Di norma si tiene il parallelismo del passaggio principale: un
      // ritentativo su qualche migliaio di file non deve costare più
      // dell'invio iniziale. Ma se finora NON è passato un solo file, il
      // problema non è il singolo trasferimento: la spiegazione più probabile
      // è che le associazioni in più vengano rifiutate. In quel caso si
      // ritenta con UNA sola, cioè come il lancio manuale da cmd.
      const lanesCount = state.success > 0 ? partDirs.length : 1;
      if (lanesCount === 1 && partDirs.length > 1) {
        emit({
          type: 'log',
          line: '> nessun file passato finora: ritentativo con una sola associazione',
        });
      }
      const lanes = spread(chunkByLength(files), lanesCount);
      await Promise.all(
        lanes.map(async (lane) => {
          for (const batch of lane) {
            if (cancelled) return;
            try {
              await runOne(fileArgs(batch));
            } catch (err) {
              emit({ type: 'log', line: `> errore storescu: ${String((err && err.message) || err)}` });
            }
          }
        })
      );
      await collectUnattempted();

      // Un giro intero senza che UN SOLO file si muova. Rifarlo con gli stessi
      // argomenti costerebbe solo altri minuti di attesa a vuoto: si chiude
      // qui, dicendo perché, invece di tenere l'operatore davanti a una barra
      // ferma. Vale sia quando le associazioni sono state abbattute perché
      // mute, sia quando storescu è uscito senza produrre risposte
      // riconoscibili: in entrambi i casi insistere non cambia l'esito.
      if (state.success + state.failed === before) {
        const mute = state.stallKills > killsBefore;
        emit({
          type: 'log',
          line: mute
            ? '> il PACS non risponde: ritentativi interrotti. ' +
              'Verificare la rete o che l\'esame non sia aperto in refertazione, poi riprovare.'
            : '> nessun file è passato in questo giro e storescu non ha segnalato risposte: ' +
              'ritentativi interrotti. Con «Copia comando» si può rilanciare la stessa riga in cmd e confrontare.',
        });
        state.gaveUp = true;
        break;
      }
    }

    stalled = false;
    state.cancelled = cancelled;
    state.failedFiles = [...retryQueue.values(), ...permanent.values()];
    state.permanentFailures = [...permanent.values()];
    state.elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    state.bytes = doneBytes;
    state.totalBytes = totalBytes;
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
  watchdog.unref();

  const promise = run().finally(() => {
    clearInterval(watchdog);
    // nessun processo storescu deve sopravvivere alla fine dell'invio, né
    // quando esce bene né quando esce per errore
    killAll();
  });
  promise.cancel = () => {
    cancelled = true;
    state.cancelled = true;
    killAll();
  };
  return promise;
}

module.exports = {
  sendStoreScu,
  chunkByLength,
  insideStaging,
  commandLine,
  quoteForCmd,
  preflightSend,
  lastSentCommand: () => lastCommand,
};
