# Prove

Prove dell'app vera, in Electron, su dati sintetici: nessun esame reale. Non
entrano nell'installer (prende solo `src/`); i dati generati finiscono in
`test/.dati`, ignorata da git.

Servono Node, le dipendenze installate (`npm install`) e, per lo studio
compresso e il PACS finto, DCMTK 3.7.0 win64: la cartella `bin` dello zip
ufficiale in `%USERPROFILE%\Downloads\dcmtk-3.7.0-win64-dynamic\bin`, oppure
indicata con `DCMTK_BIN`.

```bash
node test/fantoccio.js
```

```bash
node_modules/electron/dist/electron.exe test/importazione.js
```

```bash
node_modules/electron/dist/electron.exe test/viewer-run.js scorciatoie
```

| | |
|---|---|
| `fantoccio.js` | studio sintetico con valori noti (vertebra 700 HU, diametro 34 mm; polmone circa −820 HU; nodulo 35 HU) e la sua copia compressa |
| `importazione.js` | importazione dall'interfaccia con una chiavetta finta e `storescp` come PACS: copia, scelta (solo archivio / PACS), invio fallito, riuscito, parallelo, annullato, «Nuova importazione» |
| `supporti.js` | elenco dei supporti al passo 1: icona della chiavetta per l'USB, del disco per CD/DVD/ISO |
| `viewer-run.js <scena>` | apre il viewer su un archivio di prova ed esegue `scene/<scena>.js` |
| `scene/strumenti.js` | strumenti che si spengono ripremendone la scorciatoia, cursore a manina |
| `scene/scorciatoie.js` | le scorciatoie di Synapse, con eventi veri di tastiera e mouse |

Con `SLOW=60 SLOTS=2` il viewer decodifica come una postazione lenta (60 ms a
fetta, due alla volta).

Le finestre di prova vanno tenute in primo piano: Chromium rallenta apposta
quelle coperte, e le misure di fluidità diventerebbero false.
