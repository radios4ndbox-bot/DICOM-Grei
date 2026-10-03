# DICOM Grei

(ex DICOM Import Tool. Del nome vecchio restano solo due cose, apposta: la
cartella delle impostazioni `%APPDATA%\dicom-import-tool` e l'`appId`
dell'installer. Cambiarle romperebbe le postazioni già configurate: parametri del
PACS persi, versione vecchia installata accanto alla nuova.)

App desktop Electron per importare studi DICOM da supporti fisici (USB, CD/DVD, ISO, ZIP)
verso il PACS **Synapse Fujifilm** dell'ospedale, tramite `storescu` di dcmtk.

Pensata per postazioni Windows **senza permessi di amministratore**. Il pacchetto viene
prodotto da **GitHub Actions** (`windows-latest`, Node 24) perché `npm` è bloccato dal
proxy ospedaliero.

## Parametri PACS (da configurare al primo avvio)

I valori presenti nel repository sono **segnaposto**: i parametri reali della rete non
sono versionati. Si impostano una volta sola dall'ingranaggio in alto a destra e valgono
**per tutta la postazione**, non solo per chi li ha impostati:

| File | Chi lo usa |
|---|---|
| `%ProgramData%\DICOM Grei\settings.json` | tutti gli utenti Windows della postazione |
| `%APPDATA%\dicom-import-tool\settings.json` | un solo utente (cartella fissata in `main.js`, `USER_DATA_DIR`) |

Vale il file salvato per ultimo fra i due, e un file personale più recente viene
ricopiato in quello della postazione. Sulle postazioni già in uso basta quindi che un
utente configurato apra la nuova versione una volta: da lì in poi anche chi non aveva
mai aperto l'ingranaggio trova il PACS.

- Il file della postazione lo può modificare solo l'utente Windows che l'ha creato; gli
  altri lo leggono. I permessi non vengono allargati apposta: chi scrive quel file decide
  verso quale host partono le immagini di tutti. Se un altro utente salva, il suo valore
  vale solo per lui (l'app lo dice dopo il salvataggio).
- Un indirizzo di loopback (`127.x`, `localhost`: il segnaposto o un PACS finto per le
  prove) resta sempre personale e non finisce mai nel file della postazione. Un file
  con un PACS vero ha la precedenza su uno con il loopback, anche se più vecchio: le
  versioni precedenti, con «Ripristina», scrivevano `127.0.0.1` nel file personale.
- «Ripristina» toglie il file personale: si torna alla configurazione della postazione,
  o ai predefiniti se non c'è.
- Per attrezzare un'altra postazione si può copiare uno dei due file.

Finché il PACS non è configurato il badge in alto mostra **«PACS non configurato»**
invece di `127.0.0.1`, e il log di ogni importazione dice da dove vengono le
impostazioni (dell'utente, della postazione, nessuna). Un file illeggibile non blocca
l'avvio: viene ignorato e segnalato nel dialogo delle impostazioni e nel log.

| | predefinito nel repo |
|---|---|
| AET sorgente | `STORESCU` (il predefinito di storescu) |
| AET destinazione | `ANY-SCP` (il predefinito di storescu) |
| Indirizzo PACS | `127.0.0.1` |
| Porta | `104` |
| storescu | incluso in `resources/dcmtk/bin`, con le sue DLL e il runtime Visual C++ (fallback: `%USERPROFILE%\Desktop\dcmtk\bin`) |
| Staging | `C:\tmp\dicom_grei` |

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
`--scan-pattern`: in staging c'è già solo ciò che va inviato, e così l'elenco
dei file da inviare lo decide la cartella e non un secondo filtro da tenere
allineato. (Il commit 10e5674 sosteneva che `--scan-pattern "*.dcm"` lanciato
con `spawn` non trovasse nessun file. Rimisurato il 25/09/2026 su Windows 11
con lo `storescu` incluso contro `storescp`: li trova tutti, anche `.DCM`,
come da `cmd`, in accordo con il report sul campo. Fallisce solo se le
virgolette finiscono dentro l'argomento.) I file ancora in copia
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

Ogni importazione scrive `DICOM_Grei_AAAA-MM-GG_hh-mm-ss.log` nella cartella
**`Desktop\DICOM Grei Log`** (se il Desktop non è scrivibile, nel profilo
dell'app). Mai in `C:\tmp`, che viene svuotata. Il file si scrive mentre
l'importazione procede: se si interrompe a metà, il log arriva fino a lì.

I log delle versioni precedenti a DICOM Grei restano dov'erano, in
`Desktop\DICOM Import Log`, con il nome `DICOM_Import_…`: l'app non li sposta
né li cancella.

Contiene: supporto e classificazione, parametri PACS, modalità di invio,
percorso di `storescu`, tutte le righe di `storescu` con l'orario al
millisecondo, file non copiati (solo il nome), durate e velocità per fase,
esito. **Non contiene dati del paziente** — né nome, né ID, né data di nascita,
né etichetta del volume — perché le postazioni sono condivise e il Desktop è la
cartella più esposta.

## Archivio locale e viewer

Quando l'importazione non va a buon fine il supporto può non essere più a
portata di mano. L'esame resta allora consultabile sulla postazione, in un
viewer interno, per **20 giorni** (`ARCHIVE_DAYS`).

**Cosa entra in archivio**, e solo questo:

- in automatico, l'esame il cui invio al PACS è fallito del tutto o in parte
  (file rifiutati, PACS muto, `storescu` che non parte). Si conserva lo studio
  intero, non i soli file falliti: uno studio a metà non si legge;
- a mano, con **«Conserva in archivio»** a fine importazione: per l'esame
  inviato senza errori ma che il medico ha verificato come non indicizzato dal
  PACS. Il pulsante c'è finché lo staging non viene pulito.

Un'importazione riuscita non lascia niente. Lo stesso studio archiviato due
volte resta una volta sola, con la scadenza che riparte.

**Dove sta**: `C:\DICOM Grei\Archivio`, una cartella per esame.

| | |
|---|---|
| `<id>\files\000001.dcm…` | i file DICOM, con nomi neutri |
| `<id>\meta.json` | paziente, studio, date, motivo: ciò che mostra l'elenco |
| `<id>\index.json` | lo stesso più serie e ordine delle immagini |

È in `C:\` e non in `%ProgramData%` perché l'archivio è di **tutti i medici
della postazione**, che devono poterlo anche eliminare: sotto `C:\` una cartella
creata da un utente eredita «Authenticated Users: modifica» (verificato con
`icacls`, come `C:\tmp`), sotto `%ProgramData%` i file li cambia solo chi li ha
creati. I file entrano come collegamenti fisici allo staging: nessun byte
copiato (63 file in 0,1 s), e lo staging si può svuotare senza toccarli.

**Quando esce**: allo scadere dei 20 giorni, da solo (controllo all'avvio e ogni
10 minuti), oppure prima con la ✕ sull'esame, che chiede conferma. È l'unico
punto in cui l'app tiene dati del paziente oltre la giornata, ed è il motivo
per cui scade.

**Il viewer** («Archivio» in alto a destra) è una finestra a parte:

- elenco degli esami con motivo e giorni rimasti, serie con miniatura;
- scorrimento (rotella, trascinamento, tasti, cursore), finestra/livello con i
  preset TC, negativo, zoom, spostamento, rotazione e riflessione, cine;
- **misure**: distanza, angolo, ROI ellittica con media, deviazione standard,
  minimo, massimo e area. In mm da `PixelSpacing`; se c'è solo la spaziatura
  sul rivelatore (RX) la misura è segnata con `*` e l'immagine lo dice; senza
  spaziatura, in pixel. In TC i valori sono in HU;
- **due pannelli** per il confronto, anche fra esami diversi, con scorrimento
  sincronizzato alla stessa quota;
- lettere di orientamento (A/P, R/L, H/F) che seguono rotazioni e riflessioni;
- **«Compara»**: apre l'immagine che si sta guardando in una seconda finestra,
  come quelle del viewer del PACS, da affiancargli sullo schermo accanto. Con
  più schermi va su uno diverso da quello di partenza (il più vicino, e libero
  da altre finestre di confronto) a tutto schermo; con uno solo occupa la metà
  destra. È un viewer completo senza l'elenco a lato, che «Elenco» riapre; le
  finestre sono indipendenti, se ne possono aprire quante servono, e restano
  aperte anche chiudendo la finestra dell'archivio.

**Tastiera e mouse sono quelli del viewer del PACS** (Fujifilm Synapse 5,
elenco «Keyboard Shortcuts for the Viewer and Worklist» della sua guida in
linea), per le funzioni che esistono anche qui: chi referta non deve imparare
due serie di tasti. Le scorciatoie di Synapse si possono cambiare per sito e
lingua: se in reparto sono state personalizzate, queste sono quelle di
fabbrica.

«Lettera + clic»: la lettera sceglie lo strumento del tasto sinistro. Tenuta
premuta mentre si usa il mouse, al rilascio torna lo strumento di prima;
battuta e basta, lo strumento resta.

| Tasti | Cosa fa |
|---|---|
| `R` + clic | righello (distanza) |
| `G` + clic | angolo a tre punti |
| `E` + clic | ROI ellittica |
| `D` + clic e tieni | valore di densità sotto il cursore (HU in TC) |
| `W` + trascina, `ALT` + trascina | finestra/livello: su/giù luminosità, sinistra/destra contrasto |
| `Z` + trascina | scorrimento rapido della serie |
| `MAIUSC+Z` + trascina, `ALT+CTRL` + trascina | zoom |
| `MAIUSC+X` + trascina, `ALT+MAIUSC` + trascina | sposta |
| `+` / `−` | zoom 1x (un pixel dell'immagine per pixel dello schermo) / adatta al pannello |
| `MAIUSC+R` | ripristina l'immagine |
| frecce su/giù, `PagSu`/`PagGiù`, `Inizio`/`Fine` | immagine precedente/successiva, dieci alla volta, prima/ultima |
| `MAIUSC` + freccia sinistra/destra | serie precedente/successiva |
| `Spazio` | cine: avvia/ferma |
| tastierino numerico `0`–`7` | finestre predefinite, nell'ordine del menu |
| `MAIUSC+A` | mostra/nasconde le misure |
| `MAIUSC+T` | mostra/nasconde i dati a schermo |
| `MAIUSC+CANC` | toglie tutte le misure dell'esame (`CANC`: quella selezionata) |
| `CTRL` + rotella, doppio clic | uno/due pannelli |
| `S`, `J`, `C` | scorrimento collegato sì/no, collega, scollega |
| `X` + clic | svuota il pannello |
| `F11` | schermo intero |

Sempre attivi col mouse, qualunque strumento sia scelto: rotella = scorri,
tasto destro = finestra/livello, tasto centrale = sposta.

Due differenze volute rispetto a Synapse: lì i preset del tastierino
dipendono da modalità e sito, qui sono fissi; lì `F11` riporta la finestra
alla dimensione preferita, qui è lo schermo intero. Le scorciatoie di Synapse
per funzioni che il viewer non ha (freccia, testo, ROI a mano libera, cerchio,
lente, linee di riferimento, MPR, protocolli di lettura) non sono assegnate.

Formati decodificati (`dicomDecode.js`), ognuno confrontato pixel per pixel con
l'originale: non compressi (anche big endian e deflated), RLE, JPEG Lossless
(`jpeg-lossless-decoder-js`), JPEG-LS (CharLS), JPEG 2000 (OpenJPEG), JPEG
baseline 8 bit (libjpeg-turbo). Non ancora: JPEG esteso a 12 bit, immagini a
tavolozza, oggetti multi-fotogramma «enhanced» con geometria per fotogramma.
Non è una stazione di refertazione: niente MPR, 3D o fusione.

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

**Un file rifiutato non ferma più l'invio.** Di suo `storescu` si ferma al
primo file che il PACS non accetta (SR, PDF incapsulato, oggetto privato del
visualizzatore…) e tutto il resto passava ai ritentativi, con le loro attese
di 10/30/60 s: barra ferma per minuti. L'app passa `--no-halt`: il file
rifiutato viene segnato fra i falliti definitivi e l'invio prosegue. Misurato
contro `storescp`: 5 file rifiutati su 405 costavano 713 reinvii e tutti e
tre i ritentativi, ora 400/400 al primo passaggio.

**Un PACS che rifiuta non è un PACS muto.** Il 30/09/2026 Synapse ha
accettato il primo file e rifiutato tutti gli altri con
`Received Store Response (Refused: OutOfResources)`, e l'app lo ha descritto
come «storescu non ha segnalato risposte» e «il PACS non rispondeva più».

La causa erano **gli AE title**. Fino ad allora l'app si presentava con i
segnaposto `DICOM_IMPORT` → `PACS`; gli invii a mano da `cmd` non passano
`-aet`/`-aec`, cioè usano quelli di storescu, `STORESCU` → `ANY-SCP`. Lo
stesso pomeriggio un esame nuovo per il Synapse è stato rifiutato file per file
dall'app e accettato poco dopo per intero da `cmd`. L'associazione viene
accettata in entrambi i casi: il rifiuto arriva solo sulle singole immagini, ed
è per questo che sembrava un problema dell'invio. (Il CD del mattino era già nel
Synapse, importato il giorno prima con un altro programma: lì anche `cmd` veniva
rifiutato, e le prove su quel CD non potevano distinguere.)

- **Predefiniti** ora `STORESCU` / `ANY-SCP`, come da `cmd`.
- **Postazioni già configurate**: il salvataggio scrive tutti i campi, quindi
  la coppia `DICOM_IMPORT`/`PACS` è rimasta nei `settings.json`. Se l'app la
  trova esatta la sostituisce all'avvio, e lo dice nelle impostazioni e nel
  log; un AE title impostato davvero non si tocca.

Il riepilogo, poi, ora racconta come stanno le cose:

- il riepilogo e il log dicono quanti file non sono passati **per stato**
  (es. `3554 × Refused: OutOfResources`), con le parole del PACS;
- i ritentativi si fermano dopo un giro in cui nessun file in più è passato,
  e dicono se il PACS era muto o se ha risposto rifiutando;
- l'elenco dei file non inviati li comprende tutti, anche quelli che un giro
  interrotto non aveva ancora ritentato;
- stdout e stderr di `storescu` si leggono su due buffer separati: prima un
  avviso di stderr poteva finire in mezzo a una riga di stdout
  (`XMIT: W: …`) e rendere irriconoscibile la risposta del PACS;
- interrompendo durante l'**invio**, i file restano in staging: «Copia
  comando» li rilancia da `cmd`. Prima lo staging veniva azzerato e la riga
  copiata non trovava più niente. Interrompendo durante la **copia** lo
  staging viene ancora azzerato, perché è incompleto.

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
   gh repo create <org>/dicom-grei --private --source=. --remote=origin --push
   ```
2. Ogni push su `main` (o `workflow_dispatch`) produce l'artifact
   `DICOM Grei-Setup-<versione>.exe` (artifact `dicom-grei-setup`). Installato
   sopra una versione «DICOM Import Tool», la aggiorna al suo posto.
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
- La copia in `C:\tmp\dicom_grei` avviene sempre prima dell'invio (percorsi con spazi, lettura da ottica, invio parziale su DVD danneggiati). Ogni file ha un timeout di lettura configurabile (`FILE_COPY_TIMEOUT_MS`).
- Lo staging delle versioni precedenti (`C:\tmp\dicom_import`, `_src`, `.day`) viene tolto dalla pulizia giornaliera, ma solo quando la sua data non è quella di oggi: su una postazione condivisa un altro utente può avere ancora la versione vecchia aperta.
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
- Il viewer segue le stesse regole: finestra sandboxed con la stessa CSP, e
  nessun percorso attraversa il ponte. Chiede «esame X, file `000012.dcm`,
  fotogramma 0»: l'identificativo e il nome devono avere esattamente la forma
  che dà loro l'archivio (`archive.filePath`), altrimenti la richiesta è
  rifiutata. I codec girano in un worker thread, su pixel limitati a 64 Mpx, con
  dimensioni e offset controllati contro il buffer letto.
- L'archivio locale contiene dati del paziente (nome, ID, immagini) leggibili
  da ogni utente Windows della postazione, per scelta: è un archivio di
  reparto. Per questo ci entrano solo gli esami non arrivati al PACS e scadono
  in 20 giorni. Il log delle importazioni continua a non contenerne.
