# DICOM Import Tool

App desktop Electron per importare studi DICOM da supporti fisici (USB, CD/DVD, ISO, ZIP)
verso il PACS **Synapse Fujifilm** dell'ospedale, tramite `storescu` di dcmtk.

Pensata per postazioni Windows **senza permessi di amministratore**. Il pacchetto viene
prodotto da **GitHub Actions** (`windows-latest`, Node 24) perché `npm` è bloccato dal
proxy ospedaliero.

## Parametri PACS (da configurare al primo avvio)

I valori presenti nel repository sono **segnaposto**: i parametri reali della rete non
sono versionati. Si impostano una volta sola dall'ingranaggio in alto a destra e vengono
salvati in `%APPDATA%\dicom-import-tool\settings.json`, fuori dal repository. Per
attrezzare più postazioni si può copiare quel file sulle altre.

Finché non sono configurati, il badge in alto mostra `PACS @ 127.0.0.1:104` e l'invio
fallisce con un errore di connessione: è il segnale che la configurazione manca.

| | predefinito nel repo |
|---|---|
| AET sorgente | `DICOM_IMPORT` |
| AET destinazione | `PACS` |
| Indirizzo PACS | `127.0.0.1` |
| Porta | `104` |
| storescu | incluso in `resources/dcmtk/bin` (fallback: `%USERPROFILE%\Desktop\dcmtk\bin`) |
| Staging | `C:\tmp\dicom_import` |

## Flusso

`RILEVA SUPPORTO → ANALIZZA STRUTTURA → CLASSIFICA (A–F) → COPIA IN LOCALE → INVIA → PULISCI`

Durante la copia in locale il pannello a destra si riempie con l'**anteprima a
mosaico**: un riquadro per serie, con la *prima* immagine di ciascuna. In TC
questo significa un riquadro per assiale, coronale e sagittale (l'orientamento
viene dal cosenodirettore `ImageOrientationPatient`, quindi le ricostruzioni si
distinguono anche quando stanno nella stessa serie); in RX un riquadro per
proiezione (`ViewPosition`: AP, PA, LAT…). Clic su un riquadro per ingrandirlo,
trascinamento per luminosità/contrasto, doppio clic per reimpostare.

I casi gestiti:

| Tipo | Sorgente | Copia in staging | Cosa finisce in staging |
|---|---|---|---|
| A | CD/DVD con file `MP*` in `DICOM\` | diretta, nomi invariati | solo i `MP*` |
| B | file numerici senza estensione | rinomina in `.dcm` | tutto, come `.dcm` |
| C | più sottocartelle con nomi file identici | rinomina + suffisso `_<n>` | tutto, come `.dcm` |
| D | annidamento profondo | rinomina ricorsiva (+ suffisso anti-collisione) | tutto, come `.dcm` |
| E | USB con `.iso` | `Mount-DiskImage` → tratta come CD → `Dismount-DiskImage` | come sopra |
| F | USB con `.zip` | estrazione nativa (`unzip.js`) → cerca `DICOM\` → procedi | come sopra |
| G | immagini già `.dcm` in sottocartelle (`D:\0\0.x\*.dcm`) | si copiano **solo i `.dcm`**, il resto è il visualizzatore | i `.dcm` |

A `storescu` l'app passa **la cartella di staging e basta**, senza
`--scan-pattern`: in staging c'è già solo ciò che va inviato. Con questo
`storescu`, `--scan-pattern "*.dcm"` lanciato come fa l'app non trova nessun
file (verificato su `main`, commit 10e5674): il passaggio principale inviava
zero file e tutto finiva nei ritentativi, uno per uno. I file ancora in copia
stanno nella sottocartella `~copia`, e `storescu` senza `+r` non scende nelle
sottocartelle: non può prendere un file a metà nemmeno quando una lettura
bloccata di un DVD rovinato lo tiene aperto e non lo si può cancellare.

## Dati dal campo (report del 25/09/2026)

Due CD reali importati a mano da `cmd`, verso questo Synapse:

| | Sessione 1 (CLIP) | Sessione 2 (PATIENTCD) |
|---|---|---|
| File · dimensione | 3172 · 665 MB | 1936 · 637 MB |
| Copia | 7 min 09 s · 1,55 MB/s | 1 min 10 s · 9,10 MB/s |
| Invio (1 associazione) | 3 min 29 s · **3,18 MB/s** · 15,2 file/s | 3 min 43 s · **2,86 MB/s** · 8,7 file/s |
| Pausa manuale fra copia e invio | 20 s | 2 min 20 s |

Cosa ne è disceso nel codice:

- **Invio sequenziale di default.** Il comando che non perde associazioni ne
  apre una sola; l'app ne apriva 2. Parallelo e turbo restano disponibili.
- **ETA a byte, non a file.** L'invio tiene ~3 MB/s costanti, mentre in file/s
  le due sessioni vanno da 15,2 a 8,7 (dipende dalla dimensione media delle
  immagini). Stimata a file, la sessione 2 sarebbe uscita sbagliata del 43%; a
  byte, del 10%. Prima di partire lo step 2 mostra dimensione e invio stimato a
  `SEND_MBPS_ESTIMATE` (3 MB/s).
- **Copia senza stima a priori.** È la fase variabile (1,5–9 MB/s): la stima
  compare solo dopo qualche secondo di lettura misurata.
- **Tempi per fase nel riepilogo e nel log**, con le stesse grandezze del report
  (durata · MB · MB/s), così un'importazione dall'app si confronta riga per riga
  con una fatta a mano.
- **Nessuna pausa fra copia e invio**: nel report fino a 2 min 20 s.

## Log delle importazioni

Ogni importazione scrive `DICOM_Import_AAAA-MM-GG_hh-mm-ss.log` nella cartella
**`Desktop\DICOM Import Log`** (se il Desktop non è scrivibile, nel profilo
dell'app). Mai in `C:\tmp`, che viene svuotata. Il file si scrive mentre
l'importazione procede: se si interrompe a metà, il log arriva fino a lì.

Contiene: supporto e classificazione, parametri PACS, modalità di invio,
percorso di `storescu`, tutte le righe di `storescu` con l'orario al
millisecondo, file non copiati (solo il nome), durate e velocità per fase,
esito. **Non contiene dati del paziente** — né nome, né ID, né data di nascita,
né etichetta del volume — perché le postazioni sono condivise e il Desktop è la
cartella più esposta.

## CD/DVD danneggiati

`fs.copyFile` gira su un thread del pool di libuv e una lettura ferma su un
settore illeggibile non si può interrompere: il thread resta occupato finché
Windows non rinuncia al settore. Il pool di default ha 4 thread, condivisi da
tutto il processo. Misurato con letture bloccate simulate: **6 file illeggibili
in testa facevano saltare anche tutti i 12 file leggibili successivi** — restavano
in coda senza partire, scadevano, e finivano fra i "saltati".

Ora:

1. il pool resta quello di default (4). Portarlo a 16 da codice non funziona:
   misurato il 25/09/2026 su Windows 11, assegnare `UV_THREADPOOL_SIZE` da
   `main.js` non cambia il pool, né in Electron né in Node, e dava alla
   contropressione un numero falso (credeva di avere 16 thread). Ha effetto
   solo se la variabile è già nell'ambiente quando parte l'app;
2. soprattutto, **non si avvia una lettura se non c'è un thread libero**: la
   copia aspetta che una lettura abbandonata torni indietro. Sul caso
   realistico (il settore alla fine torna errore) si passa da 0/12 a 12/12 file
   buoni con il pool di default;
3. i file scaduti vengono **ritentati una volta, in sequenza**, a fine copia:
   quelli rimasti in coda dietro un settore rovinato di solito passano. Ci si
   ferma dopo 8 scadenze di fila o 3 minuti;
4. se il lettore non restituisce più nessuna lettura per 60 s è considerato
   bloccato: si smette di leggere e si invia quanto già copiato, dicendolo.

## Prestazioni

Il tempo di un'importazione è quasi tutto I/O, non CPU. Quello che il codice fa
per contenerlo:

| | |
|---|---|
| Una sola passata sull'albero | La classificazione percorre il supporto una volta e passa l'elenco dei file alla copia. Prima erano tre passate (conteggio per cartella, totale, copia), e su un DVD ogni `readdir` è un riposizionamento della testina. |
| Niente scansioni nel main process | Classificazione, lettura anagrafica e anteprima girano su `worker_threads`. Il main resta libero: barra di avanzamento e pulsante «Interrompi» rispondono sempre. |
| Si copia solo ciò che verrà inviato | Eseguibili del visualizzatore, `DICOMDIR`, `autorun.inf` e simili non finiscono in staging. Nel Tipo A vengono copiati solo i file `MP*`, gli unici che `storescu` prenderà. |
| Estrazione ZIP nativa | `unzip.js` legge il central directory e decomprime con `zlib`. `Expand-Archive` di PowerShell, che ricrea un oggetto COM per ogni voce, costava minuti su un archivio di qualche migliaio di immagini. |
| Copia e invio in parallelo | `fs.copyFile` (CopyFileW) con concorrenza, e N associazioni DICOM simultanee, una per sottocartella `part_NN`. |
| Anteprima a costo (quasi) zero | I riquadri si costruiscono sui file **già copiati in locale**, riusando I/O appena fatto: il supporto non viene mai riletto. |

## «Da cmd va più veloce e non perde un'associazione»

Osservazione di campo che vale la pena chiarire, perché porta a una conclusione
sbagliata.

**L'app già lancia `storescu.exe` direttamente**, con `child_process.spawn` e
senza shell: non c'è nessun `cmd.exe` in mezzo da togliere. Metterlo
*aggiungerebbe* un processo, e per giunta romperebbe l'abbattimento dei
processi appesi (si ucciderebbe `cmd`, non `storescu`).

**Il trasferimento è già bit per bit identico.** Il binario incluso dipende solo
da `dcmdata`, `dcmnet`, `dcmtls`, `oflog`, `ofstd`: **nessun codec JPEG
linkato**, quindi `storescu` non ricomprime e non decomprime nulla, con
qualsiasi opzione. `--propose-lossless` non ha niente a che vedere con la
qualità: serve a proporre anche il contesto di presentazione JPEG lossless, di
cui hanno bisogno i file che sul CD sono **già** compressi così (gran parte di
TC e RM). Toglierlo li farebbe uscire come `No presentation context for:`, cioè
persi davvero. Per questo resta il default.

Le differenze vere fra un lancio a mano e l'app sono altre, ed è su quelle che
si agisce:

| Differenza | Cosa fare |
|---|---|
| A mano parte **una sola associazione**. Se Synapse limita le associazioni contemporanee per AE title, quelle in più vengono rifiutate | **Sequenziale è il default**: una sola associazione, staging non spezzato, un solo `storescu` con `+sd`. È il comando del report, dentro l'app. Parallelo (2) e turbo (6) si scelgono dalla tendina |
| A mano non ci sono timeout: DCMTK aspetta il PACS all'infinito. L'app glieli passa, e un PACS lento può far cadere l'associazione | Impostazioni → *Riga di comando di storescu* → **Passa i timeout a storescu**: spegnendolo si aspetta come da cmd. La guardia di inattività dell'app resta, quindi resta recuperabile |
| A mano `TCP_NODELAY` non è impostata | Stessa sezione, si può spegnere |
| A mano non c'è la copia in staging | Quella serve (percorsi con spazi, DVD rovinati, invio parziale) e non si toglie |

Per confrontare **come si deve**, il pulsante **«Copia comando»** nello step 3
mette negli appunti la riga esatta dell'ultimo invio, già con le virgolette
giuste. Lo staging resta sul disco per tutta la giornata: si incolla in `cmd` e
si rilancia lo stesso invio sugli stessi file. Se a quel punto le due esecuzioni
si comportano ancora diversamente, la differenza non è negli argomenti.

## Stalli durante l'invio

Un invio che resta appeso è il guasto peggiore: la barra si ferma e non c'è modo
di capire perché. Le difese, in ordine:

1. **Timeout DCMTK** (`--dimse-timeout`, `--acse-timeout`, `--timeout`). Senza
   di essi DCMTK aspetta il PACS *all'infinito*.
2. **Avviso a 45 s** senza risposta: l'operatore lo vede nel log.
3. **Guardia di inattività**: se da `storescu` non arriva un byte per
   `SEND_STALL_KILL_MS` (3 min di default) il processo viene abbattuto. I file
   non tentati vengono ritrovati confrontando lo staging e rientrano nei
   ritentativi.
4. **Resa dichiarata**: se un intero giro di ritentativi non porta a casa
   nemmeno un file e si chiude abbattendo associazioni mute, i ritentativi si
   fermano con un messaggio esplicito invece di consumare altri minuti a vuoto.
5. **«Interrompi» immediato**, in copia come in invio, anche durante l'attesa
   fra due ritentativi.

Nessun processo `storescu` sopravvive alla fine dell'invio, alla chiusura della
finestra o a un errore: se uno dei processi paralleli fallisce, gli altri
vengono abbattuti invece di restare a scrivere sul PACS scollegati dall'app.

> **A mano, mai** usare `--scan-pattern "*"` su una cartella che non sia lo
> staging: con `+sd` trova `NTUSER.DAT` e fa abortire l'associazione. L'app non
> passa alcun carattere jolly: indica solo la propria cartella di staging, dove
> nessun altro scrive.

## Sviluppo / build

Localmente `npm` non è disponibile: la prima verifica reale è l'artifact della CI oppure
`npm run start` su una macchina con rete libera.

```bash
npm install
npm run start        # avvio in sviluppo
npm run dist         # pacchetto NSIS (richiede Windows)
```

### Pubblicazione

1. Da una macchina con `gh` + rete:
   ```bash
   gh repo create <org>/dicom-import-tool --private --source=. --remote=origin --push
   ```
2. Ogni push su `main` (o `workflow_dispatch`) produce l'artifact
   `DICOM Import Tool-Setup-<versione>.exe`.
3. Un tag `vX.Y.Z` pubblica anche una GitHub Release.
4. Consigliato: da quella macchina, `npm install` una volta e committare il
   `package-lock.json` per build riproducibili.

### Icona

`electron-builder.yml` non imposta `win.icon` finché non esiste il file.
Aggiungere `build/icon.ico` in formato **BMP**, minimo **256×256**, poi scommentare la
riga `icon: build/icon.ico`.

## Note tecniche

- `asar: false` — serve l'accesso diretto ai file locali.
- La finestra principale usa `loadURL` + `url.format()` per il path resolution nell'exe pacchettizzato.
- `storescu` è invocato con `child_process.spawn` e stdout parsato riga per riga per la progress bar e il log live.
- `storescu.exe` mancante viene segnalato **prima** della copia, non dopo minuti di lettura del CD.
- I supporti vengono rilevati da soli all'avvio e a ogni «Nuova importazione».
- La copia in `C:\tmp\dicom_import` avviene sempre prima dell'invio (percorsi con spazi, lettura da ottica, invio parziale su DVD danneggiati). Ogni file ha un timeout di lettura configurabile (`FILE_COPY_TIMEOUT_MS`).
- La pulizia finale è sempre dietro conferma dell'utente.

## Limiti noti

- `Mount-DiskImage` / `Dismount-DiskImage` possono richiedere privilegi a seconda della policy di dominio.
- `wmic` è assente su Windows 11 recenti: `detectMedia.js` ha un fallback a `Get-CimInstance`.
- L'installer NSIS non è firmato: SmartScreen mostrerà un avviso al primo avvio.
- La classificazione si basa su struttura di cartelle e nomi file; i tag DICOM
  vengono letti solo per l'anagrafica e per l'anteprima.
- L'anteprima decodifica un fotogramma non compresso (monocromatico con modality
  LUT e finestra, oppure RGB/YBR) e i JPEG baseline, che passa alla finestra
  perché li decodifichi con il motore del browser. JPEG lossless, JPEG-LS e
  JPEG 2000 mostrano il riquadro con la dicitura «immagine compressa».

## Note di sicurezza

I file arrivano da un supporto del paziente, quindi sono dati non fidati.

- `powershell.exe` e `WMIC.exe` vengono invocati per **percorso assoluto** sotto
  `%SystemRoot%\System32`: col solo nome li avrebbe risolti il `PATH`, e una
  cartella scrivibile dall'utente nel `PATH` basta a far eseguire all'app un
  binario altrui.
- Gli script PowerShell sono fissi: i percorsi passano come variabili
  d'ambiente e vengono letti con `$env:NOME`, mai interpolati nel comando (le
  stringhe `"..."` di PowerShell espandono `$()` e il backtick).
- Difesa **zip slip** dentro al lettore ZIP: risalite `..`, percorsi assoluti,
  lettere di unità, flussi alternati NTFS (`:`), nomi riservati di Windows e
  archivi cifrati fanno fallire l'estrazione *prima* che venga scritto un byte.
- Il decoder dell'anteprima non si fida di `Rows`/`Columns`: ogni vista sui
  pixel è limitata ai byte realmente presenti nel buffer e il numero di pixel è
  tagliato a `PREVIEW_MAX_PIXELS`. Senza, un'intestazione costruita male
  bastava a far crescere un'allocazione fino a far fuori il processo.
- Il renderer non riceve mai percorsi di file dell'anteprima: riceve un indice e
  pixel già ridotti.
- Il main non accetta percorsi dal renderer: dal renderer arrivano solo scelte
  (quale unità fra quelle rilevate, quale tipo forzato).
- La finestra è `sandbox: true` + `contextIsolation: true`, con CSP
  `default-src 'none'`, navigazione e nuove finestre negate.
