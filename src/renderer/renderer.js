'use strict';

const $ = (id) => document.getElementById(id);

// Etichette di volume, nomi di file e di cartella arrivano da un supporto
// paziente: non sono fidati. Si inseriscono sempre come testo, mai come HTML.
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

const TYPE_MAP = {
  A: { pattern: 'MP*', strategy: 'keep' },
  B: { pattern: '*.dcm', strategy: 'rename' },
  C: { pattern: '*.dcm', strategy: 'suffix' },
  D: { pattern: '*.dcm', strategy: 'rename' },
};

const DRIVE_LABEL = { 2: 'USB', 5: 'CD/DVD/ISO' };

// step della barra: 0 = Copia, 1 = Invio a PACS, 2 = Pulizia
const SP_STATUS = ['Copia in locale…', 'Invio a Synapse…', 'Pulizia cartella…'];

const state = {
  drives: [],
  drive: null,
  prepared: null,
  plan: null,
  effective: null,
  finished: false,
};

function showStep(name) {
  for (const s of document.querySelectorAll('.step')) s.classList.add('hidden');
  $(`step-${name}`).classList.remove('hidden');
  const order = ['media', 'study', 'transfer'];
  const idx = order.indexOf(name);
  document.querySelectorAll('#stepnav span').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done', i < idx);
  });
}

// step: indice 0..2 ; frac: avanzamento 0..1 dentro lo step
function setProgress(step, frac, opts) {
  opts = opts || {};
  frac = Math.max(0, Math.min(1, frac));
  const fills = document.querySelectorAll('.progress .sp__bar-fill');
  const hubs = document.querySelectorAll('.progress .sp__hub');
  const hubFills = document.querySelectorAll('.progress .sp__hub-fill');
  const dots = document.querySelectorAll('.progress .sp__dot');

  fills.forEach((el, i) => {
    const f = i < step ? 1 : i === step ? frac : 0;
    el.style.strokeDashoffset = String(40 * (1 - f));
  });
  [0, 1, 2].forEach((i) => {
    const done = i < step || (i === step && frac >= 1);
    hubs[i].classList.toggle('sp__hub--done', done);
    hubFills[i].classList.toggle('sp__hub-fill--done', done);
    dots[i].classList.toggle('sp__dot--done', done);
  });

  $('phase-label').textContent = opts.status || SP_STATUS[step] || '';
  if (opts.detail != null) $('phase-detail').textContent = opts.detail;
}

// ---------------------------------------------------------------- STEP 1

$('btn-detect').addEventListener('click', detect);

async function detect() {
  $('detect-status').textContent = 'Scansione in corso…';
  $('drive-list').innerHTML = '';
  $('btn-to-study').disabled = true;
  state.drive = null;
  try {
    state.drives = await window.api.detectMedia();
  } catch (err) {
    $('detect-status').textContent = 'Errore: ' + err.message;
    return;
  }
  if (state.drives.length === 0) {
    $('detect-status').textContent = 'Nessun supporto USB o ottico rilevato.';
    return;
  }
  $('detect-status').textContent = `${state.drives.length} supporto/i rilevato/i.`;
  for (const d of state.drives) {
    const li = document.createElement('li');
    li.append(
      el('span', 'tag', DRIVE_LABEL[d.driveType] || d.kind),
      el('b', null, d.caption),
      el('span', 'muted', d.volumeName || 'senza nome')
    );
    li.addEventListener('click', () => {
      document.querySelectorAll('#drive-list li').forEach((x) => x.classList.remove('sel'));
      li.classList.add('sel');
      state.drive = d;
      $('btn-to-study').disabled = false;
    });
    $('drive-list').appendChild(li);
  }
}

$('btn-to-study').addEventListener('click', async () => {
  if (!state.drive) return;
  $('btn-to-study').disabled = true;
  $('detect-status').textContent = 'Lettura supporto e file DICOM…';
  try {
    state.prepared = await window.api.prepareSource(state.drive);
    state.plan = await window.api.classify();
  } catch (err) {
    $('detect-status').textContent = 'Errore: ' + err.message;
    $('btn-to-study').disabled = false;
    return;
  }
  renderStudy();
  showStep('study');
});

// ---------------------------------------------------------------- STEP 2

function renderStudy() {
  const p = state.plan;

  const note = $('prepare-note');
  if (state.prepared.note) {
    note.textContent = state.prepared.note;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }

  const s = p.study;
  const dash = (v) => (v && String(v).trim() ? v : '—');
  $('pt-last').textContent = dash(s && s.patientLast);
  $('pt-first').textContent = dash(s && s.patientFirst);
  $('pt-birth').textContent = dash(s && s.birthDate);
  $('st-modality').textContent = dash(s && s.modalityLabel);
  $('st-desc').textContent = dash(s && s.studyDescription);
  $('st-date').textContent = dash(s && s.studyDate);
  $('study-src').textContent = s
    ? `Letto da: ${s.sampleFile}${s.patientId ? ' · ID ' + s.patientId : ''}${s.accession ? ' · Accession ' + s.accession : ''}`
    : 'Dati anagrafici non leggibili dai file di questo supporto.';

  $('clf-type').textContent = p.type;
  $('clf-pattern').textContent = p.pattern;
  $('clf-total').textContent = p.totalFiles;
  $('clf-reasoning').textContent = p.reasoning;
  const tree = $('clf-tree');
  tree.textContent = '';
  for (const t of p.tree) {
    const li = document.createElement('li');
    li.append(el('b', null, t.name), ` — ${Number(t.count) || 0} file`);
    tree.appendChild(li);
  }
  $('override').value = '';

  loadPreview(s && s.samplePath);
}

// ---------------------------------------------------------------- reader interno

const viewer = { bright: 1, contrast: 1, dragging: false, x0: 0, y0: 0 };

function viewerMessage(text) {
  $('dcm-canvas').classList.remove('ready');
  $('viewer-msg').textContent = text;
  $('viewer-msg').style.display = '';
  $('viewer-meta').textContent = '';
}

function applyViewerFilter() {
  $('dcm-canvas').style.filter = `brightness(${viewer.bright}) contrast(${viewer.contrast})`;
}

async function loadPreview(samplePath) {
  if (!samplePath) return viewerMessage('Nessun file DICOM leggibile su questo supporto.');
  viewerMessage('Caricamento anteprima…');
  let r;
  try {
    r = await window.api.previewImage(samplePath);
  } catch (err) {
    return viewerMessage('Errore anteprima: ' + err.message);
  }
  if (!r || r.unsupported) {
    const map = {
      compressed: 'Immagine compressa (JPEG/JPEG2000/RLE): anteprima non disponibile.',
      'no-pixel-data': 'Il file non contiene dati immagine.',
      'parse-error': 'File non interpretabile.',
      'read-error': 'File non leggibile.',
      truncated: 'Dati immagine incompleti.',
      'too-large': 'Immagine troppo grande per l’anteprima.',
      'no-path': 'Percorso non consentito per l’anteprima.',
    };
    return viewerMessage((map[r && r.unsupported] || 'Anteprima non disponibile.') +
      (r && r.rows ? ` (${r.cols}×${r.rows})` : ''));
  }

  const cv = $('dcm-canvas');
  const cx = cv.getContext('2d');
  cv.width = r.cols;
  cv.height = r.rows;
  const img = cx.createImageData(r.cols, r.rows);

  if (r.gray) {
    const g = new Uint8Array(r.gray);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      img.data[j] = img.data[j + 1] = img.data[j + 2] = g[i];
      img.data[j + 3] = 255;
    }
  } else if (r.rgb) {
    const s = new Uint8Array(r.rgb);
    for (let i = 0, j = 0; j < img.data.length; i += 3, j += 4) {
      img.data[j] = s[i];
      img.data[j + 1] = s[i + 1];
      img.data[j + 2] = s[i + 2];
      img.data[j + 3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);

  viewer.bright = 1;
  viewer.contrast = 1;
  applyViewerFilter();
  $('viewer-msg').style.display = 'none';
  cv.classList.add('ready');
  $('viewer-meta').textContent = `${r.cols}×${r.rows} · ${r.photometric || ''}`.trim();
}

(function bindViewerInteraction() {
  const cv = $('dcm-canvas');
  cv.addEventListener('mousedown', (e) => {
    viewer.dragging = true;
    viewer.x0 = e.clientX;
    viewer.y0 = e.clientY;
  });
  window.addEventListener('mouseup', () => (viewer.dragging = false));
  window.addEventListener('mousemove', (e) => {
    if (!viewer.dragging) return;
    viewer.bright = Math.max(0.2, Math.min(3, viewer.bright + (e.clientX - viewer.x0) * 0.005));
    viewer.contrast = Math.max(0.2, Math.min(3, viewer.contrast - (e.clientY - viewer.y0) * 0.005));
    viewer.x0 = e.clientX;
    viewer.y0 = e.clientY;
    applyViewerFilter();
  });
  cv.addEventListener('dblclick', () => {
    viewer.bright = 1;
    viewer.contrast = 1;
    applyViewerFilter();
  });
})();

$('btn-back-media').addEventListener('click', () => showStep('media'));
$('btn-start').addEventListener('click', startImport);

// Solo per l'anteprima a schermo: il piano che conta lo ricostruisce il main.
function buildEffectivePlan() {
  const p = state.plan;
  const forced = $('override').value;
  if (!forced || forced === p.type) return { ...p };
  const m = TYPE_MAP[forced];
  return { ...p, type: forced, pattern: m.pattern, strategy: m.strategy };
}

// ---------------------------------------------------------------- STEP 3 — barra unica

async function startImport() {
  state.effective = buildEffectivePlan();
  state.finished = false;

  $('log').textContent = '';
  $('summary').classList.add('hidden');
  $('btn-cleanup').classList.add('hidden');
  $('btn-restart').classList.add('hidden');
  $('cleanup-status').textContent = '';
  $('send-ok').textContent = 'Success: 0';
  $('send-err').textContent = 'Error: 0';
  $('copy-skipped').textContent = '';
  setProgress(0, 0, { status: 'Avvio…', detail: '' });
  showStep('transfer');

  let result;
  try {
    result = await window.api.runImport($('override').value);
  } catch (err) {
    $('log').textContent += '\nERRORE: ' + err.message + '\n';
    $('phase-label').textContent = 'Errore durante il trasferimento';
    $('sum-note').textContent = err.message;
    $('summary').classList.remove('hidden');
    $('btn-restart').classList.remove('hidden');
    return;
  }
  onImportDone(result);
}

window.api.onProgress((d) => {
  if (d.phase === 'copy') {
    setProgress(0, d.total ? (d.copied + d.skipped) / d.total : 0, {
      detail: `${d.copied}/${d.total} file${d.current ? ' · ' + d.current : ''}`,
    });
    $('copy-skipped').textContent = d.skipped ? `${d.skipped} saltati` : '';
  } else if (d.phase === 'send') {
    setProgress(1, d.total ? d.sent / d.total : 0, { detail: `${d.sent}/${d.total} file` });
    $('send-ok').textContent = 'Success: ' + d.success;
    $('send-err').textContent = 'Error: ' + d.failed;
  } else if (d.phase === 'cleanup') {
    if (d.state === 'start') {
      setProgress(2, 0.5, { status: 'Pulizia cartella…', detail: '' });
    } else {
      setProgress(2, 1, { status: 'Completato', detail: '' });
      $('cleanup-status').textContent =
        'Staging svuotato' + (d.result && d.result.isoDismounted ? ' · ISO smontata.' : '.');
      $('btn-cleanup').disabled = true;
    }
  }
});

window.api.onLog((line) => {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
});

function onImportDone(result) {
  state.finished = true;
  const s = result.send || {};

  setProgress(1, 1, {
    status: 'Trasferimento completato — premi «Pulisci»',
    detail: `${s.success || 0} inviati · ${s.failed || 0} falliti`,
  });

  $('sum-ok').textContent = s.success || 0;
  $('sum-err').textContent = s.failed || 0;
  $('sum-skip').textContent = result.copy ? result.copy.skipped : 0;
  $('sum-assoc').textContent = result.error
    ? 'ERRORE'
    : s.aborted
    ? 'ABORTITA'
    : s.released
    ? 'Rilasciata correttamente'
    : 'Chiusa (stato non confermato)';

  const notes = [];
  if (result.error) notes.push(result.error);
  if (result.copy && result.copy.skipped) {
    notes.push(`${result.copy.skipped} file non copiati (timeout/lettura): invio parziale.`);
  }
  if (result.iso) notes.push('ISO montata: verrà smontata alla pulizia.');
  notes.push('Se un esame non compare subito nel PACS, attendere 2–3 min e cercare per data.');
  $('sum-note').textContent = notes.join(' ');

  $('summary').classList.remove('hidden');
  $('btn-cleanup').classList.remove('hidden');
  $('btn-restart').classList.remove('hidden');
  $('btn-cleanup').dataset.iso = result.iso || '';
}

$('btn-cleanup').addEventListener('click', async () => {
  const withIso = !!$('btn-cleanup').dataset.iso;
  if (!confirm('Svuotare C:\\tmp\\dicom_import' + (withIso ? " e smontare l'ISO" : '') + '?')) return;
  $('btn-cleanup').disabled = true;
  try {
    await window.api.cleanup();
  } catch (err) {
    $('cleanup-status').textContent = 'Errore pulizia: ' + err.message;
    $('btn-cleanup').disabled = false;
  }
});

$('btn-restart').addEventListener('click', () => {
  state.drive = state.prepared = state.plan = state.effective = null;
  state.finished = false;
  $('drive-list').innerHTML = '';
  $('detect-status').textContent = '';
  $('cleanup-status').textContent = '';
  $('btn-cleanup').disabled = false;
  $('btn-to-study').disabled = true;
  viewerMessage('Nessuna immagine caricata.');
  showStep('media');
});

showStep('media');
