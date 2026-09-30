# Strumenti DCMTK in più accanto a storescu, presi in CI dallo zip ufficiale
# OFFIS di DCMTK 3.7.0 (la stessa versione di storescu.exe già nel repository).
#
# Perché: il Synapse rifiuta con 0xA700 "Refused: Out of resources" le
# immagini in JPEG Lossless (1.2.840.10008.1.2.4.70), pur accettandone il
# contesto in negoziazione; accetta i file non compressi (30/09/2026).
# storescu non ha codec e non può decomprimere: servono dcmdjpeg (JPEG) e
# dcmdjpls (JPEG-LS). dcmdump serve alle verifiche a mano.
#
# In CI e non nel repository perché dall'ambiente di sviluppo il sito OFFIS
# non è raggiungibile. Le DLL già presenti (quelle di storescu) non vengono
# sovrascritte; si aggiungono solo quelle mancanti.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$url = 'https://dicom.offis.de/download/dcmtk/dcmtk370/bin/dcmtk-3.7.0-win64-dynamic.zip'
# SHA-256 dello zip. Vuoto finché non è stato letto dal primo log di CI: da
# quel momento lo zip scaricato deve combaciare, altrimenti la build si ferma.
$expected = ''

$dest = Join-Path $PSScriptRoot '..\resources\dcmtk\bin'
$tmp = Join-Path $env:RUNNER_TEMP 'dcmtk-zip'

Invoke-WebRequest -Uri $url -OutFile "$tmp.zip"
$hash = (Get-FileHash "$tmp.zip" -Algorithm SHA256).Hash
Write-Host "dcmtk-3.7.0-win64-dynamic.zip SHA256 $hash"
if ($expected -and $hash -ne $expected) {
  throw "SHA256 dello zip DCMTK inatteso: $hash (atteso $expected)"
}

Expand-Archive "$tmp.zip" -DestinationPath $tmp -Force
$bin = Get-ChildItem $tmp -Recurse -Directory -Filter bin | Select-Object -First 1
if (-not $bin) { throw 'cartella bin non trovata nello zip DCMTK' }

foreach ($exe in 'dcmdjpeg.exe', 'dcmdjpls.exe', 'dcmdump.exe') {
  Copy-Item (Join-Path $bin.FullName $exe) $dest -Force
  Write-Host "aggiunto $exe"
}
foreach ($dll in Get-ChildItem $bin.FullName -Filter *.dll) {
  $target = Join-Path $dest $dll.Name
  if (-not (Test-Path $target)) {
    Copy-Item $dll.FullName $target
    Write-Host "aggiunta $($dll.Name)"
  }
}

# Deve partire davvero: una DLL mancante si scopre qui, non in reparto.
& (Join-Path $dest 'dcmdjpeg.exe') --version
if ($LASTEXITCODE -ne 0) { throw "dcmdjpeg non parte (codice $LASTEXITCODE)" }
