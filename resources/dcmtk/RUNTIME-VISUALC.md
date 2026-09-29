# Runtime Microsoft Visual C++ in `bin/`

`storescu.exe` e le DLL di DCMTK 3.7.0 (build dinamica) dipendono dal runtime
Visual C++ 2015-2022 x64:

| file | versione |
|---|---|
| `msvcp140.dll` | 14.50.35719.0 |
| `vcruntime140.dll` | 14.50.35719.0 |
| `vcruntime140_1.dll` | 14.50.35719.0 |

Il runtime non fa parte di Windows e sulle postazioni dell'ospedale, senza
permessi di amministratore, non si può installare. Le tre DLL stanno quindi
accanto a `storescu.exe` (distribuzione "app-local"): Windows cerca le DLL
prima nella cartella del programma, e le usa da lì anche dove il runtime non
c'è. Verificato il 29/09/2026: il processo storescu carica queste copie, non
quelle di sistema.

Sono file di Microsoft Corporation, firmati, presi dal runtime installato su
Windows 11; Microsoft ne consente la ridistribuzione insieme al programma che
li usa (Visual C++ Redistributable, elenco dei file ridistribuibili di Visual
Studio). Il runtime 14.x è compatibile all'indietro: una versione più recente
di quella con cui DCMTK è stato compilato va bene, una più vecchia no.

Per aggiornarle: copiare le tre DLL da `C:\Windows\System32` di un PC con il
Visual C++ Redistributable x64 aggiornato, e aggiornare la tabella.
