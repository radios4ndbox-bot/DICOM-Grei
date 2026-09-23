'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const { powershell } = require('./winExec');
const { detectMedia } = require('./detectMedia');
const { extractZip } = require('./unzip');

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
  await powershell('Mount-DiskImage -ImagePath $env:DIT_ISO -ErrorAction Stop | Out-Null', {
    env: { DIT_ISO: isoPath },
  });

  // Attendi che compaia la nuova lettera ottica (drivetype 5). Su postazioni
  // lente il volume può metterci qualche secondo a essere pronto.
  let added = [];
  for (let i = 0; i < 40 && added.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await detectMedia();
    added = now.filter((d) => d.driveType === 5 && !before.has(d.caption));
  }
  if (added.length === 0) {
    // niente unità nuova: non si lascia l'immagine montata a metà
    await dismountIso(isoPath);
    throw new Error('ISO montata ma nessuna nuova unità ottica rilevata.');
  }
  return added[0].caption + '\\';
}

async function dismountIso(isoPath) {
  try {
    await powershell('Dismount-DiskImage -ImagePath $env:DIT_ISO -ErrorAction Stop | Out-Null', {
      env: { DIT_ISO: isoPath },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepara la sorgente: risolve ISO (Tipo E) e ZIP (Tipo F), altrimenti passa attraverso.
 *
 * L'estrazione dello ZIP non passa più da `Expand-Archive`: vedi unzip.js.
 * La difesa "zip slip" è dentro al lettore e fa fallire l'archivio prima che
 * venga scritto qualsiasi file.
 *
 * @returns {{ kind:'optical'|'usb'|'folder', sourcePath:string, iso:string|null, note:string }}
 */
async function prepareSource(drive, opts = {}) {
  const root = drive.caption.endsWith('\\') ? drive.caption : drive.caption + '\\';

  const iso = firstFileWithExt(root, '.iso');
  if (iso) {
    const mountRoot = await mountIso(iso);
    return { kind: 'optical', sourcePath: mountRoot, iso, note: `ISO montata su ${mountRoot}` };
  }

  const zip = firstFileWithExt(root, '.zip');
  if (zip) {
    // Fuori da STAGING_DIR: lo staging viene svuotato a ogni import.
    const r = await extractZip(zip, config.EXTRACT_DIR, {
      onProgress: opts.onProgress,
      isCancelled: opts.isCancelled,
    });
    const parent = findBucketDir(config.EXTRACT_DIR);
    return {
      kind: 'folder',
      sourcePath: parent,
      iso: null,
      note: `ZIP estratto (${r.files} file) in ${parent}`,
    };
  }

  return {
    kind: drive.driveType === 5 ? 'optical' : 'usb',
    sourcePath: root,
    iso: null,
    note: '',
  };
}

module.exports = { prepareSource, dismountIso, mountIso };
