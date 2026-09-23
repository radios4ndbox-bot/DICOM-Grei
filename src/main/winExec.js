'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Eseguibili di sistema per percorso ASSOLUTO.
 *
 * `execFile('powershell', ...)` risolve il nome sul PATH. Su una postazione
 * dove un utente senza privilegi può scrivere in una cartella del PATH (o
 * dove il PATH contiene una cartella su chiavetta) basterebbe un
 * `powershell.exe` fasullo per far eseguire codice arbitrario a questa app,
 * che gira con le credenziali dell'operatore e vede i dati del paziente.
 * I binari di Windows si prendono quindi da %SystemRoot%\System32.
 */
function systemExe(rel, fallback) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = path.join(root, rel);
  try {
    if (fs.existsSync(full)) return full;
  } catch {}
  return fallback; // fuori da Windows (test) o installazione atipica
}

const POWERSHELL = systemExe(
  path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  'powershell.exe'
);
const WMIC = systemExe(path.join('System32', 'wbem', 'WMIC.exe'), 'wmic.exe');

/**
 * execFile in versione promise. `env` viene AGGIUNTO all'ambiente corrente:
 * è il canale con cui si passano i percorsi agli script PowerShell senza
 * interpolarli nel comando.
 */
function execFileP(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: opts.timeout || 20000,
        maxBuffer: opts.maxBuffer || 1024 * 1024 * 16,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || err).trim()));
        resolve(String(stdout || ''));
      }
    );
  });
}

/**
 * Esegue uno script PowerShell FISSO. I valori variabili (percorsi di file su
 * supporto paziente) non vengono mai interpolati nel comando: passano come
 * variabili d'ambiente e lo script le legge con $env:NOME. Così un file
 * chiamato `evil$(calc).iso` non può iniettare comandi, perché le stringhe
 * "..." di PowerShell espandono $() e il backtick.
 */
function powershell(command, opts = {}) {
  return execFileP(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], {
    timeout: opts.timeout || 120000,
    env: opts.env,
    maxBuffer: opts.maxBuffer,
  });
}

module.exports = { POWERSHELL, WMIC, execFileP, powershell };
