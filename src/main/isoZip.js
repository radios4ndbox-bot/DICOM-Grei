'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const { detectMedia } = require('./detectMedia');

function ps(command, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout, maxBuffer: 1024 * 1024 * 16 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').trim()));
        resolve(String(stdout || ''));
      }
    );
  });
}

function firstFileWithExt(dir, ext) {
  try {
    const hit = fs
      .readdirSync(dir, { withFileTypes: true })
      .find((e) => e.isFile() && e.name.toLowerCase().endsWith(ext));
    return hit ? path.join(dir, hit.name) : null;
  } catch {
    return null;
  }
}

// Cerca ricorsivamente una cartella "DICOM"/"IMAGES" nel contenuto estratto.
function findBucketDir(root, maxDepth = 5) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (/^(dicom|images?)$/i.test(e.name)) return dir; // ritorna il PADRE del bucket
      if (depth < maxDepth) stack.push([path.join(dir, e.name), depth + 1]);
    }
  }
  return root;
}

async function mountIso(isoPath) {
  const before = new Set((await detectMedia()).map((d) => d.caption));
  await ps(`Mount-DiskImage -ImagePath ${JSON.stringify(isoPath)} | Out-Null`);

  // Attendi che compaia la nuova lettera ottica (drivetype 5).
  let added = [];
  for (let i = 0; i < 20 && added.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await detectMedia();
    added = now.filter((d) => d.driveType === 5 && !before.has(d.caption));
  }
  if (added.length === 0) {
    throw new Error('ISO montata ma nessuna nuova unità ottica rilevata.');
  }
  return added[0].caption + '\\';
}

async function dismountIso(isoPath) {
  try {
    await ps(`Dismount-DiskImage -ImagePath ${JSON.stringify(isoPath)} | Out-Null`);
    return true;
  } catch {
    return false;
  }
}

async function extractZip(zipPath) {
  const target = path.join(config.STAGING_DIR, config.EXTRACT_SUBDIR);
  await fs.promises.rm(target, { recursive: true, force: true });
  await fs.promises.mkdir(target, { recursive: true });
  await ps(
    `Expand-Archive -Path ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(target)} -Force`
  );
  return findBucketDir(target);
}

/**
 * Prepara la sorgente: risolve ISO (Tipo E) e ZIP (Tipo F), altrimenti passa attraverso.
 * @returns {{ kind:'optical'|'usb'|'folder', sourcePath:string, iso:string|null, note:string }}
 */
async function prepareSource(drive) {
  const root = drive.caption.endsWith('\\') ? drive.caption : drive.caption + '\\';

  const iso = firstFileWithExt(root, '.iso');
  if (iso) {
    const mountRoot = await mountIso(iso);
    return { kind: 'optical', sourcePath: mountRoot, iso, note: `ISO montata su ${mountRoot}` };
  }

  const zip = firstFileWithExt(root, '.zip');
  if (zip) {
    const extractedParent = await extractZip(zip);
    return { kind: 'folder', sourcePath: extractedParent, iso: null, note: `ZIP estratto in ${extractedParent}` };
  }

  return {
    kind: drive.driveType === 5 ? 'optical' : 'usb',
    sourcePath: root,
    iso: null,
    note: '',
  };
}

module.exports = { prepareSource, dismountIso };
