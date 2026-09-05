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

I casi gestiti:

| Tipo | Sorgente | Copia | scan-pattern |
|---|---|---|---|
| A | CD/DVD con file `MP*` in `DICOM\` | diretta, nomi invariati | `MP*` |
| B | file numerici senza estensione | rinomina in `.dcm` | `*.dcm` |
| C | più sottocartelle con nomi file identici | rinomina + suffisso `_<n>` | `*.dcm` |
| D | annidamento profondo | rinomina ricorsiva (+ suffisso anti-collisione) | `*.dcm` |
| E | USB con `.iso` | `Mount-DiskImage` → tratta come CD → `Dismount-DiskImage` | come sopra |
| F | USB con `.zip` | `Expand-Archive` in staging → cerca `DICOM\` → procedi | come sopra |

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
- Nessun parsing dei tag DICOM lato app: la classificazione si basa su struttura di cartelle e nomi file.
