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
  if (opts.eta != null) $('phase-eta').textContent = opts.eta;
}

// "2 min 30 s", "1 h 05 min" — abbastanza preciso senza fingere precisione
function formatEta(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min ${String(Math.round(sec % 60)).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// ---------------------------------------------------------------- popup

function showModal(title, text) {
  const m = $('modal');
  $('modal-title').textContent = title;
  $('modal-text').textContent = text;
  m.hidden = false;
  // un frame di ritardo: serve perché la transizione di opacità parta
  requestAnimationFrame(() => m.classList.add('show'));
}

function hideModal() {
  const m = $('modal');
  m.classList.remove('show');
  setTimeout(() => {
    m.hidden = true;
  }, 340);
}

$('modal-ok').addEventListener('click', hideModal);
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) hideModal();
});

// ---------------------------------------------------------------- impostazioni

// I campi vengono costruiti dallo schema che arriva dal main: limiti ed
// etichette stanno lì, non duplicati qui.
function buildSettingsForm(desc) {
  const body = $('set-body');
  body.textContent = '';

  for (const sec of desc.schema) {
    const wrap = el('div', 'set__section');
    wrap.append(el('h3', null, sec.section));
    if (sec.note) wrap.append(el('p', 'set__note', sec.note));

    for (const f of sec.fields) {
      const row = el('div', 'set__row');
      const lab = el('label', null, f.label);
      lab.htmlFor = 'set-' + f.key;
      row.append(lab);

      const box = el('div', 'set__input');
      const inp = document.createElement('input');
      inp.id = 'set-' + f.key;
      inp.dataset.key = f.key;
      if (f.type === 'int') {
        inp.type = 'number';
        inp.min = String(f.min);
        inp.max = String(f.max);
        inp.step = '1';
      } else {
        inp.type = 'text';
        inp.maxLength = f.type === 'aet' ? 16 : 253;
      }
      inp.value = String(desc.values[f.key]);
      box.append(inp);
      if (f.unit) box.append(el('span', 'set__unit', f.unit));
      row.append(box);

      const bits = [];
      if (f.hint) bits.push(f.hint);
      if (f.type === 'int') bits.push(`${f.min}–${f.max}`);
      bits.push(`predefinito ${desc.defaults[f.key]}`);
      row.append(el('span', 'set__hint', bits.join(' · ')));

      wrap.append(row);
    }
    body.append(wrap);
  }

  $('set-file').textContent = 'Salvate in: ' + desc.file;
  $('set-errors').hidden = true;
}

function collectSettings() {
  const out = {};
  for (const inp of $('set-body').querySelectorAll('input[data-key]')) {
    out[inp.dataset.key] = inp.value.trim();
  }
  return out;
}

function showSettingsErrors(errors) {
  const box = $('set-errors');
  if (!errors || !errors.length) {
    box.hidden = true;
    return;
  }
  box.textContent = errors.join('\n');
  box.hidden = false;
}

function openSettings(desc) {
  buildSettingsForm(desc);
  const m = $('settings');
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add('show'));
}

function closeSettings() {
  const m = $('settings');
  m.classList.remove('show');
  setTimeout(() => {
    m.hidden = true;
  }, 340);
}

$('btn-settings').addEventListener('click', async () => {
  try {
    openSettings(await window.api.getSettings());
  } catch (err) {
    showModal('Impostazioni non disponibili', err.message);
  }
});

$('set-cancel').addEventListener('click', closeSettings);
$('settings').addEventListener('click', (e) => {
  if (e.target === $('settings')) closeSettings();
});

$('set-save').addEventListener('click', async () => {
  $('set-save').disabled = true;
  try {
    const r = await window.api.saveSettings(collectSettings());
    if (!r.ok) {
      showSettingsErrors(r.errors);
      return;
    }
    closeSettings();
    showModal('Impostazioni salvate', 'I nuovi valori valgono dalla prossima importazione.');
  } catch (err) {
    showSettingsErrors([err.message]);
  } finally {
    $('set-save').disabled = false;
  }
});

$('set-reset').addEventListener('click', async () => {
  if (!confirm('Ripristinare tutti i valori predefiniti?')) return;
  try {
    const r = await window.api.resetSettings();
    if (!r.ok) return showSettingsErrors(r.errors);
    buildSettingsForm(await window.api.getSettings());
  } catch (err) {
    showSettingsErrors([err.message]);
  }
});

window.api.onPacsChanged((p) => {
  $('pacs-badge').textContent = `${p.aet} @ ${p.host}:${p.port}`;
});

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

  loadSeries();
}

// ---------------------------------------------------------------- reader interno

const viewer = { bright: 1, contrast: 1, dragging: false, x0: 0, y0: 0 };

function viewerMessage(text) {
  $('dcm-canvas').classList.remove('ready');
  $('viewer-msg').textContent = text;
  $('viewer-msg').style.display = '';
  $('viewer-meta').textContent = '';
}

// Torna alla griglia delle serie dal visore a immagine singola.
function showSeriesGrid() {
  $('series-grid').hidden = false;
  $('viewer-stage').hidden = true;
  $('viewer-hint').textContent = 'Una miniatura per serie: la prima immagine di ciascuna.';
}

function showSingleViewer() {
  $('series-grid').hidden = true;
  $('viewer-stage').hidden = false;
  $('viewer-hint').textContent =
    "Trascina per luminosità / contrasto · doppio clic per reimpostare · clic qui per tornare alle serie";
}

function applyViewerFilter() {
  $('dcm-canvas').style.filter = `brightness(${viewer.bright}) contrast(${viewer.contrast})`;
}

async function loadPreview(seriesId, label) {
  showSingleViewer();
  viewerMessage('Caricamento anteprima…');
  let r;
  try {
    r = await window.api.previewSeries(seriesId);
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
  $('viewer-meta').textContent = `${label} · ${r.cols}×${r.rows} ${r.photometric || ''}`.trim();
}

// ---------------------------------------------------------------- serie

const SERIES_MSG = {
  compressed: 'Immagine compressa',
  'no-pixel-data': 'Nessun dato immagine',
  'parse-error': 'Non interpretabile',
  'read-error': 'Non leggibile',
  truncated: 'Dati incompleti',
  'too-large': 'Troppo grande',
  'unsupported-samples': 'Formato non gestito',
};

// Disegna una miniatura già ridotta dal main su un canvas.
function paintThumb(cv, s) {
  cv.width = s.cols;
  cv.height = s.rows;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(s.cols, s.rows);
  if (s.gray) {
    const g = new Uint8Array(s.gray);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      img.data[j] = img.data[j + 1] = img.data[j + 2] = g[i];
      img.data[j + 3] = 255;
    }
  } else {
    const t = new Uint8Array(s.rgb);
    for (let i = 0, j = 0; j < img.data.length; i += 3, j += 4) {
      img.data[j] = t[i];
      img.data[j + 1] = t[i + 1];
      img.data[j + 2] = t[i + 2];
      img.data[j + 3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);
}

async function loadSeries() {
  const grid = $('series-grid');
  grid.textContent = '';
  grid.hidden = false;
  $('viewer-stage').hidden = true;
  $('viewer-hint').textContent = 'Una miniatura per serie: la prima immagine di ciascuna.';
  $('viewer-meta').textContent = 'lettura serie…';

  let r;
  try {
    r = await window.api.seriesPreview();
  } catch (err) {
    $('viewer-meta').textContent = '';
    grid.append(el('p', 'muted', 'Anteprima non disponibile: ' + err.message));
    return;
  }

  if (!r.series.length) {
    $('viewer-meta').textContent = '';
    grid.append(el('p', 'muted', 'Nessuna serie DICOM leggibile su questo supporto.'));
    return;
  }

  for (const s of r.series) {
    const cell = el('div', 'series__cell');
    const label = [s.number != null ? `Serie ${s.number}` : 'Serie', s.modality]
      .filter(Boolean)
      .join(' · ');

    if (s.gray || s.rgb) {
      const cv = document.createElement('canvas');
      cv.className = 'series__thumb';
      cv.title = 'Apri a schermo intero';
      paintThumb(cv, s);
      cv.addEventListener('click', () => loadPreview(s.id, label));
      cell.appendChild(cv);
    } else {
      cell.appendChild(el('div', 'series__none', SERIES_MSG[s.unsupported] || 'Anteprima non disponibile'));
    }

    const cap = el('div', 'series__cap');
    cap.append(el('b', null, label));
    cap.append(el('span', null, `${s.description || '—'} · ${s.count} img`));
    cell.appendChild(cap);

    grid.appendChild(cell);
  }

  $('viewer-meta').textContent =
    `${r.series.length} serie` + (r.truncated ? ` · primi ${r.scanned} file` : '');
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
  // clic sull'area attorno all'immagine: torna alla griglia delle serie
  $('viewer-stage').addEventListener('click', (e) => {
    if (e.target !== cv) showSeriesGrid();
  });
  $('viewer-hint').addEventListener('click', () => {
    if (!$('viewer-stage').hidden) showSeriesGrid();
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
  setProgress(0, 0, { status: 'Avvio…', detail: '', eta: '' });
  $('btn-stop').classList.remove('hidden');
  $('btn-stop').disabled = false;
  showStep('transfer');

  let result;
  try {
    result = await window.api.runImport($('override').value, $('turbo').checked);
  } catch (err) {
    $('btn-stop').classList.add('hidden');
    $('log').textContent += '\nERRORE: ' + err.message + '\n';
    $('phase-label').textContent = 'Errore durante il trasferimento';
    $('phase-eta').textContent = '';
    $('sum-note').textContent = err.message;
    $('summary').classList.remove('hidden');
    // lo staging può essere rimasto sporco: la pulizia deve restare disponibile
    $('btn-cleanup').classList.remove('hidden');
    $('btn-cleanup').disabled = false;
    $('btn-restart').classList.remove('hidden');
    return;
  }
  onImportDone(result);
}

$('btn-stop').addEventListener('click', async () => {
  if (!confirm("Interrompere il trasferimento in corso?\nLo staging verrà azzerato automaticamente.")) return;
  $('btn-stop').disabled = true;
  $('phase-label').textContent = 'Interruzione in corso…';
  try {
    await window.api.stopImport();
  } catch (err) {
    $('log').textContent += '\nERRORE interruzione: ' + err.message + '\n';
  }
});

window.api.onProgress((d) => {
  if (d.phase === 'copy') {
    setProgress(0, d.total ? (d.copied + d.skipped) / d.total : 0, {
      detail: `${d.copied}/${d.total} file${d.current ? ' · ' + d.current : ''}`,
    });
    $('copy-skipped').textContent = d.skipped ? `${d.skipped} saltati` : '';
  } else if (d.phase === 'send') {
    const eta = formatEta(d.etaSec);
    setProgress(1, d.total ? d.sent / d.total : 0, {
      detail: `${d.sent}/${d.total} file${d.rate ? ` · ${d.rate}/s` : ''}`,
      eta: eta ? `Tempo stimato rimanente: ${eta}` : '',
    });
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
  $('btn-stop').classList.add('hidden');

  if (result.interrupted) {
    setProgress(1, 0, {
      status: 'Trasferimento interrotto',
      detail: `${s.success || 0} file inviati prima dell'interruzione`,
      eta: '',
    });
  } else {
    setProgress(1, 1, {
      status: 'Trasferimento completato — premi «Pulisci»',
      detail: `${s.success || 0} inviati · ${s.failed || 0} falliti`,
      eta: s.elapsedSec ? `Durata: ${formatEta(s.elapsedSec)}` : '',
    });
  }

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
  if (result.interrupted) {
    notes.push('Trasferimento interrotto: lo staging è già stato azzerato, si può ripartire da capo.');
  }
  if (s.retried) notes.push(`${s.retried} file ritentati automaticamente.`);
  if (s.failedFiles && s.failedFiles.length) {
    notes.push(`${s.failedFiles.length} file non recuperabili (formato o SOP class non accettata dal PACS).`);
  }
  if (result.copy && result.copy.skipped) {
    notes.push(`${result.copy.skipped} file non copiati (timeout/lettura): invio parziale.`);
  }
  if (result.turbo) notes.push(`Modalità turbo: ${result.workers} associazioni in parallelo.`);
  if (result.iso) notes.push('ISO montata: verrà smontata alla pulizia.');
  notes.push('Se un esame non compare subito nel PACS, attendere 2–3 min e cercare per data.');
  $('sum-note').textContent = notes.join(' ');

  $('summary').classList.remove('hidden');
  // sempre disponibile, anche quando il trasferimento è fallito o interrotto
  $('btn-cleanup').classList.remove('hidden');
  $('btn-cleanup').disabled = !!result.interrupted;
  $('btn-restart').classList.remove('hidden');
  $('btn-cleanup').dataset.iso = result.iso || '';

  if (result.interrupted) {
    $('cleanup-status').textContent = 'Staging azzerato automaticamente dopo l’interruzione.';
  }
}

$('btn-cleanup').addEventListener('click', async () => {
  const withIso = !!$('btn-cleanup').dataset.iso;
  if (!confirm('Svuotare C:\\tmp\\dicom_import' + (withIso ? " e smontare l'ISO" : '') + '?')) return;
  $('btn-cleanup').disabled = true;
  try {
    const r = await window.api.cleanup();
    showModal(
      'Pulizia completata',
      'Cartella di staging svuotata' +
        (r && r.isoDismounted ? " e immagine ISO smontata." : '.') +
        ' Il supporto può essere rimosso.'
    );
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
  $('phase-eta').textContent = '';
  $('btn-cleanup').disabled = false;
  $('btn-cleanup').classList.add('hidden');
  $('btn-stop').classList.add('hidden');
  $('btn-to-study').disabled = true;
  $('series-grid').textContent = '';
  showSingleViewer();
  viewerMessage('Nessuna immagine caricata.');
  showStep('media');
});

// il badge in alto deve riflettere le impostazioni salvate, non il valore fisso nell'HTML
window.api
  .getSettings()
  .then((d) => {
    $('pacs-badge').textContent = `${d.values.DEST_AET} @ ${d.values.PACS_IP}:${d.values.PACS_PORT}`;
  })
  .catch(() => {});

showStep('media');
