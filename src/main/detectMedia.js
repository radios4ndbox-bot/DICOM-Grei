'use strict';

const { execFileP, powershell, WMIC } = require('./winExec');

const DRIVE_TYPE = {
  2: 'USB',       // supporto rimovibile / chiavetta
  3: 'FIXED',     // disco fisso
  4: 'NETWORK',
  5: 'OPTICAL',   // CD/DVD o ISO montata
};

function parseWmic(stdout) {
  const out = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^caption/i.test(line)) continue;
    const m = line.match(/^([A-Za-z]:)\s+(\d+)\s*(.*)$/);
    if (!m) continue;
    const type = Number(m[2]);
    out.push({
      caption: m[1].toUpperCase(),
      driveType: type,
      kind: DRIVE_TYPE[type] || 'UNKNOWN',
      volumeName: (m[3] || '').trim(),
    });
  }
  return out;
}

function parseCim(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) data = [data];
  return data.map((d) => {
    const type = Number(d.DriveType);
    return {
      caption: String(d.DeviceID || '').toUpperCase(),
      driveType: type,
      kind: DRIVE_TYPE[type] || 'UNKNOWN',
      volumeName: (d.VolumeName || '').trim(),
    };
  }).filter((d) => /^[A-Z]:$/.test(d.caption));
}

// Restituisce solo i supporti importabili: USB (2) e ottici / ISO montate (5).
async function detectMedia() {
  let drives = [];

  try {
    const stdout = await execFileP(WMIC, ['logicaldisk', 'get', 'caption,drivetype,volumename']);
    drives = parseWmic(stdout);
  } catch {
    drives = [];
  }

  if (drives.length === 0) {
    // wmic assente (Windows 11 recenti) -> fallback CIM
    const stdout = await powershell(
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName | ConvertTo-Json -Compress',
      { timeout: 30000 }
    );
    drives = parseCim(stdout);
  }

  return drives.filter((d) => d.driveType === 2 || d.driveType === 5);
}

module.exports = { detectMedia, DRIVE_TYPE };
