# DICOM Import Tool

App desktop Electron per importare studi DICOM da supporti fisici (USB, CD/DVD, ISO, ZIP)
verso il PACS **Synapse Fujifilm** dell'ospedale, tramite `storescu` di dcmtk.

Pensata per postazioni Windows **senza permessi di amministratore**. Il pacchetto viene
prodotto da **GitHub Actions** (`windows-latest`, Node 24) perché `npm` è bloccato dal
proxy ospedaliero.

## Parametri PACS (hardcoded in `src/main/config.js`)

| | |
|---|---|
| AET sorgente | `DICOM_IMPORT` |
| AET Synapse | `PACS` |
| IP PACS | `127.0.0.1` |
| Porta | `104` |
| storescu | `%USERPROFILE%\Desktop\dcmtk\bin\storescu.exe` |
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

| Tipo | Sorgente | Copia | scan-pattern |
|---|---|---|---|
| A | CD/DVD con file `MP*` in `DICOM\` | diretta, nomi invariati | `MP*` |
| B | file numerici senza estensione | rinomina in `.dcm` | `*.dcm` |
| C | più sottocartelle con nomi file identici | rinomina + suffisso `_<n>` | `*.dcm` |
| D | annidamento profondo | rinomina ricorsiva (+ suffisso anti-collisione) | `*.dcm` |
| E | USB con `.iso` | `Mount-DiskImage` → tratta come CD → `Dismount-DiskImage` | come sopra |
| F | USB con `.zip` | `Expand-Archive` in staging → cerca `DICOM\` → procedi | come sopra |

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
| A mano parte **una sola associazione**; l'app ne apre 2 (normale) o 6 (turbo). Se Synapse limita le associazioni contemporanee per AE title, quelle in più vengono rifiutate | Tendina **Invio → Sequenziale**: una sola associazione, staging non spezzato, un solo `storescu` con `+sd`. È il lancio manuale, dentro l'app |
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

> **Mai** usare `--scan-pattern "*"`: con `+sd` esce dalla cartella e trova `NTUSER.DAT`,
> facendo abortire l'associazione. Sono ammessi solo `MP*` e `*.dcm`
> (vincolo applicato in `sendStoreScu.js`).

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
