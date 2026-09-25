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

const DRIVE_LABEL = { 2: 'USB', 5: 'CD/DVD/ISO' };

// step della barra: 0 = Copia, 1 = Invio a PACS, 2 = Pulizia
const SP_STATUS = ['Copia in locale…', 'Invio a Synapse…', 'Pulizia cartella…'];

const state = {
  drives: [],
  drive: null,
  prepared: null,
  plan: null,
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

// i nodi della barra non cambiano: si cercano una volta sola
let progressNodesCache = null;
function progressNodes() {
  if (!progressNodesCache) {
    progressNodesCache = {
      fills: document.querySelectorAll('.progress .sp__bar-fill'),
      hubs: document.querySelectorAll('.progress .sp__hub'),
      hubFills: document.querySelectorAll('.progress .sp__hub-fill'),
      dots: document.querySelectorAll('.progress .sp__dot'),
    };
  }
  return progressNodesCache;
}

// step: indice 0..2 ; frac: avanzamento 0..1 dentro lo step
function setProgress(step, frac, opts) {
  opts = opts || {};
  frac = Math.max(0, Math.min(1, frac));
  const { fills, hubs, hubFills, dots } = progressNodes();

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

function formatMB(bytes) {
  if (bytes == null || !isFinite(bytes)) return '—';
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

// Durata · MB · MB/s: le stesse grandezze del report sul campo, per poter
// mettere a confronto l'app con un'importazione fatta a mano.
function phaseLine(sec, bytes) {
  if (sec == null) return '—';
  const bits = [formatEta(sec) || '0 s'];
  if (bytes) bits.push(formatMB(bytes));
  if (bytes && sec > 0) bits.push(`${(bytes / 1048576 / sec).toFixed(2)} MB/s`);
  return bits.join(' · ');
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
      let inp;
      if (f.type === 'enum') {
        inp = document.createElement('select');
        for (const o of f.options) {
          const opt = el('option', null, o.label);
          opt.value = o.value;
          inp.append(opt);
        }
        inp.value = String(desc.values[f.key]);
      } else if (f.type === 'bool') {
        inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = desc.values[f.key] === true || desc.values[f.key] === 'true';
      } else {
        inp = document.createElement('input');
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
      }
      inp.id = 'set-' + f.key;
      inp.dataset.key = f.key;
      inp.dataset.type = f.type;
      box.append(inp);
      if (f.unit) box.append(el('span', 'set__unit', f.unit));
      row.append(box);

      const bits = [];
      if (f.hint) bits.push(f.hint);
      if (f.type === 'int') bits.push(`${f.min}–${f.max}`);
      const def = desc.defaults[f.key];
      bits.push(`predefinito ${def === true ? 'acceso' : def === false ? 'spento' : def}`);
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
  for (const inp of $('set-body').querySelectorAll('[data-key]')) {
    if (inp.dataset.type === 'bool') out[inp.dataset.key] = inp.checked ? 'true' : 'false';
    else out[inp.dataset.key] = inp.value.trim();
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

// ---------------------------------------------------------------- anteprima

/**
 * Mosaico a destra: un riquadro per serie/orientamento.
 *
 * I riquadri arrivano dal main mentre la copia in locale sta ancora andando,
 * uno alla volta e gia' ridotti a miniatura. Qui non si legge nessun file e non
 * si decodifica nulla di pesante: si dipinge su canvas quello che arriva.
 */
const preview = {
  tiles: new Map(), // id -> { tile, el, canvas }
  zoomId: null,
  bright: 1,
  contrast: 1,
  dragging: false,
  x0: 0,
  y0: 0,
};

function previewReset() {
  preview.tiles.clear();
  $('viewer-grid').textContent = '';
  $('viewer-meta').textContent = '';
  $('viewer-empty').classList.remove('hidden');
  closeZoom();
}

function previewCount() {
  const n = preview.tiles.size;
  $('viewer-meta').textContent = n ? `${n} serie` : '';
  $('viewer-empty').classList.toggle('hidden', n > 0);
}

/** Dipinge i pixel del riquadro su un canvas alla loro risoluzione naturale. */
function paintTile(canvas, tile) {
  const cx = canvas.getContext('2d');

  if (tile.jpeg) {
    // JPEG baseline: lo decodifica il motore del browser, senza dipendenze
    const blob = new Blob([tile.jpeg], { type: 'image/jpeg' });
    createImageBitmap(blob)
      .then((bmp) => {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        canvas.classList.add('ready');
      })
      .catch(() => {
        canvas.classList.remove('ready');
      });
    return;
  }

  if (!tile.cols || !tile.rows || (!tile.gray && !tile.rgb)) return;

  canvas.width = tile.cols;
  canvas.height = tile.rows;
  const img = cx.createImageData(tile.cols, tile.rows);
  const d = img.data;

  if (tile.gray) {
    const g = tile.gray;
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      d[j] = d[j + 1] = d[j + 2] = g[i];
      d[j + 3] = 255;
    }
  } else {
    const src = tile.rgb;
    for (let i = 0, j = 0; j < d.length; i += 3, j += 4) {
      d[j] = src[i];
      d[j + 1] = src[i + 1];
      d[j + 2] = src[i + 2];
      d[j + 3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);
  canvas.classList.add('ready');
}

function tileCaption(t) {
  const head = [t.series != null ? `Serie ${t.series}` : null, t.view || null]
    .filter(Boolean)
    .join(' · ');
  return head || t.modality || t.sampleFile || '—';
}

function renderTile(t) {
  const known = preview.tiles.get(t.id);
  const box = known ? known.box : el('figure', 'tile');
  const canvas = known ? known.canvas : document.createElement('canvas');

  if (!known) {
    const stage = el('div', 'tile__stage');
    stage.append(canvas);
    box.append(stage, el('figcaption', 'tile__cap'), el('p', 'tile__note'));
    box.addEventListener('click', () => openZoom(t.id));
    $('viewer-grid').append(box);
  }

  // le serie arrivano nell'ordine in cui compaiono i file, non per numero:
  // l'ordine visivo lo mette il CSS, senza ridisegnare i riquadri gia' presenti
  box.style.order = String(t.series != null ? t.series : 900 + t.id);

  box.querySelector('.tile__cap').textContent = tileCaption(t);
  const note = box.querySelector('.tile__note');
  const bits = [];
  if (t.count) bits.push(`${t.count} img`);
  if (t.fullSize) bits.push(t.fullSize);
  if (t.description) bits.push(t.description);
  note.textContent = t.note ? t.note : bits.join(' · ');
  note.classList.toggle('tile__note--warn', !!t.note);

  preview.tiles.set(t.id, { tile: t, box, canvas });
  paintTile(canvas, t);
  previewCount();

  // se il riquadro ingrandito e' proprio questo, va rinfrescato anche li'
  if (preview.zoomId === t.id) openZoom(t.id);
}

function applyZoomFilter() {
  $('zoom-canvas').style.filter = `brightness(${preview.bright}) contrast(${preview.contrast})`;
}

function openZoom(id) {
  const entry = preview.tiles.get(id);
  if (!entry) return;
  const t = entry.tile;
  preview.zoomId = id;

  const bits = [tileCaption(t)];
  if (t.fullSize) bits.push(t.fullSize);
  if (t.modality) bits.push(t.modality);
  if (t.frames > 1) bits.push(`${t.frames} fotogrammi`);
  $('zoom-caption').textContent = bits.join(' · ');

  paintTile($('zoom-canvas'), t);
  preview.bright = 1;
  preview.contrast = 1;
  applyZoomFilter();
  $('viewer-zoom').hidden = false;
}

function closeZoom() {
  preview.zoomId = null;
  const z = $('viewer-zoom');
  if (z) z.hidden = true;
}

(function bindZoom() {
  const cv = $('zoom-canvas');
  $('zoom-close').addEventListener('click', closeZoom);
  cv.addEventListener('mousedown', (e) => {
    preview.dragging = true;
    preview.x0 = e.clientX;
    preview.y0 = e.clientY;
    e.preventDefault();
  });
  window.addEventListener('mouseup', () => {
    preview.dragging = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!preview.dragging) return;
    preview.bright = Math.max(0.2, Math.min(3, preview.bright + (e.clientX - preview.x0) * 0.005));
    preview.contrast = Math.max(0.2, Math.min(3, preview.contrast - (e.clientY - preview.y0) * 0.005));
    preview.x0 = e.clientX;
    preview.y0 = e.clientY;
    applyZoomFilter();
  });
  cv.addEventListener('dblclick', () => {
    preview.bright = 1;
    preview.contrast = 1;
    applyZoomFilter();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeZoom();
  });
})();

window.api.onPreview((ev) => {
  if (!ev) return;
  if (ev.t === 'reset') previewReset();
  else if (ev.t === 'tile' || ev.t === 'update') renderTile(ev.tile);
  else if (ev.t === 'count') {
    const entry = preview.tiles.get(ev.id);
    if (entry) {
      entry.tile.count = ev.count;
      renderTile(entry.tile);
    }
  } else if (ev.t === 'error') {
    $('viewer-meta').textContent = 'anteprima non disponibile';
  }
});

// ---------------------------------------------------------------- STEP 1

$('btn-detect').addEventListener('click', detect);

async function detect() {
  $('detect-status').textContent = 'Scansione in corso…';
  $('drive-list').textContent = '';
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
  $('clf-size').textContent =
    p.totalBytes == null ? '—' : (p.bytesEstimated ? 'circa ' : '') + formatMB(p.totalBytes);
  // solo l'invio: è la fase stabile. La copia dipende dal supporto (nel report
  // sul campo da 1,5 a 9 MB/s) e una stima a priori sarebbe solo un numero.
  $('clf-eta').textContent = p.sendEtaSec ? `circa ${formatEta(p.sendEtaSec)} (una associazione)` : '—';
  // i file non-immagine (visualizzatore, DICOMDIR, autorun) non vengono copiati:
  // dirlo evita la domanda "perche' il conteggio non torna col contenuto del CD"
  $('clf-junk-row').classList.toggle('hidden', !p.skippedJunk);
  $('clf-junk').textContent = p.skippedJunk || 0;
  $('clf-reasoning').textContent = p.reasoning;
  const tree = $('clf-tree');
  tree.textContent = '';
  for (const t of p.tree) {
    const li = document.createElement('li');
    li.append(el('b', null, t.name), ` — ${Number(t.count) || 0} file`);
    tree.appendChild(li);
  }
  $('override').value = '';
}

// Nota sotto la tendina: la modalità sequenziale è quella che riproduce un
// lancio a mano da cmd, ed è la prima cosa da provare se il PACS rifiuta le
// associazioni in più.
const SEND_MODE_NOTE = {
  normal:
    'Poche associazioni DICOM insieme: più veloce se il PACS le accetta tutte. ' +
    'Se compare «Association Request Failed» tornare a Sequenziale.',
  turbo:
    'Molte associazioni in parallelo: molto più veloce sui supporti grandi, carica di più PC e PACS. ' +
    'Se compare «Association Request Failed» il PACS ne accetta meno: scendere di modalità.',
  single:
    'Una sola associazione, staging non spezzato: lo stesso comando che da cmd non perde ' +
    'un\'associazione. Verso questo PACS tiene circa 3 MB/s.',
};

function updateSendModeNote() {
  $('send-mode-note').textContent = SEND_MODE_NOTE[$('send-mode').value] || '';
}
$('send-mode').addEventListener('change', updateSendModeNote);
updateSendModeNote();

$('btn-back-media').addEventListener('click', () => showStep('media'));
$('btn-start').addEventListener('click', startImport);

// ---------------------------------------------------------------- STEP 3 — barra unica

async function startImport() {
  state.finished = false;

  resetLog();
  $('summary').classList.add('hidden');
  $('btn-cleanup').classList.add('hidden');
  $('btn-restart').classList.add('hidden');
  $('cleanup-status').textContent = '';
  $('btn-copy-cmd').classList.add('hidden');
  $('send-ok').textContent = 'Success: 0';
  $('send-err').textContent = 'Error: 0';
  $('copy-skipped').textContent = '';
  setProgress(0, 0, { status: 'Avvio…', detail: '', eta: '' });
  $('btn-stop').classList.remove('hidden');
  $('btn-stop').disabled = false;
  showStep('transfer');

  let result;
  try {
    result = await window.api.runImport($('override').value, $('send-mode').value);
  } catch (err) {
    $('btn-stop').classList.add('hidden');
    appendLog(['', 'ERRORE: ' + err.message]);
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
    appendLog(['', 'ERRORE interruzione: ' + err.message]);
  }
});

window.api.onProgress((d) => {
  if (d.phase === 'extract') {
    // estrazione dello ZIP: avviene prima della barra, si mostra nello step 1
    $('detect-status').textContent = d.total
      ? `Estrazione archivio: ${d.done}/${d.total} file…`
      : 'Estrazione archivio…';
  } else if (d.phase === 'copy') {
    const frac = d.totalBytes ? d.bytes / d.totalBytes : d.total ? (d.copied + d.skipped) / d.total : 0;
    const eta = formatEta(d.etaSec);
    setProgress(0, frac, {
      detail:
        `${d.copied}/${d.total} file` +
        (d.bytes ? ` · ${formatMB(d.bytes)}` : '') +
        (d.mbps ? ` · ${d.mbps.toFixed(1)} MB/s` : '') +
        (d.current ? ' · ' + d.current : ''),
      eta: eta ? `Copia: circa ${eta} rimanenti` : '',
    });
    $('copy-skipped').textContent = d.skipped ? `${d.skipped} saltati` : '';
  } else if (d.phase === 'send') {
    const eta = formatEta(d.etaSec);
    const frac = d.totalBytes ? d.bytes / d.totalBytes : d.total ? d.sent / d.total : 0;
    setProgress(1, frac, {
      detail:
        `${d.sent}/${d.total} file` +
        (d.totalBytes ? ` · ${formatMB(d.bytes)} di ${formatMB(d.totalBytes)}` : '') +
        (d.mbps ? ` · ${d.mbps.toFixed(1)} MB/s` : ''),
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

// ---------------------------------------------------------------- log

// Il main manda le righe a blocchi; qui si tengono solo le ultime LOG_MAX e si
// ridisegna al massimo una volta per frame. Prima ogni riga faceva
// "textContent +=" (costo che cresce con la lunghezza del log) più un reflow
// forzato da scrollTop: con migliaia di file il renderer andava in saturazione.
const LOG_MAX = 400;
const logLines = [];
let logFrame = 0;

function renderLog() {
  logFrame = 0;
  const box = $('log');
  box.textContent = logLines.join('\n');
  box.scrollTop = box.scrollHeight;
}

function appendLog(lines) {
  for (const l of lines) logLines.push(String(l));
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  if (!logFrame) logFrame = requestAnimationFrame(renderLog);
}

function resetLog() {
  logLines.length = 0;
  if (logFrame) cancelAnimationFrame(logFrame);
  logFrame = 0;
  $('log').textContent = '';
}

window.api.onLog((lines) => appendLog(Array.isArray(lines) ? lines : [lines]));

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

  const t = result.timing || {};
  $('sum-copy').textContent = phaseLine(t.copySec, t.copyBytes);
  $('sum-send').textContent = phaseLine(t.sendSec, t.sendBytes);
  $('sum-total').textContent = t.totalSec != null ? formatEta(t.totalSec) : '—';
  $('sum-log').textContent = result.logPath ? 'Log: ' + result.logPath : '';

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
  if (s.gaveUp) {
    notes.push(
      'Ritentativi interrotti: il PACS non rispondeva più. Verificare rete e stato ' +
        'dell\'esame, poi rilanciare l\'importazione.'
    );
  }
  if (s.stallKills) {
    notes.push(`${s.stallKills} associazione/i abbattuta/e perché mute.`);
  }
  if (s.failedFiles && s.failedFiles.length) {
    notes.push(`${s.failedFiles.length} file non recuperabili (formato o SOP class non accettata dal PACS).`);
  }
  if (result.copy && result.copy.recovered) {
    notes.push(`${result.copy.recovered} file recuperati al secondo tentativo di lettura.`);
  }
  if (result.copy && result.copy.driveStuck) {
    notes.push('Il lettore ha smesso di rispondere: inviati solo i file già copiati.');
  }
  if (result.copy && result.copy.skipped) {
    notes.push(`${result.copy.skipped} file non copiati (timeout/lettura): invio parziale.`);
  }
  if (result.mode === 'single') {
    notes.push('Invio sequenziale: una sola associazione, come da riga di comando.');
  } else if (result.workers) {
    notes.push(`${result.workers} associazioni in parallelo.`);
  }
  if (result.iso) notes.push('ISO montata: verrà smontata alla pulizia.');
  if (preview.tiles.size) {
    notes.push(`Anteprima: ${preview.tiles.size} serie riconosciute durante la copia.`);
  }
  notes.push('Se un esame non compare subito nel PACS, attendere 2–3 min e cercare per data.');
  $('sum-note').textContent = notes.join(' ');

  $('summary').classList.remove('hidden');
  // sempre disponibile, anche quando il trasferimento è fallito o interrotto
  $('btn-cleanup').classList.remove('hidden');
  $('btn-cleanup').disabled = !!result.interrupted;
  $('btn-restart').classList.remove('hidden');
  $('btn-cleanup').dataset.iso = result.iso || '';
  // lo staging resta sul disco per la giornata: la riga copiata si può
  // rilanciare da cmd sugli stessi file, per confrontare come si deve
  if (result.send) $('btn-copy-cmd').classList.remove('hidden');

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

$('btn-copy-cmd').addEventListener('click', async () => {
  try {
    const r = await window.api.copyCommand();
    $('cleanup-status').textContent = r && r.ok
      ? 'Comando storescu copiato: incollalo in cmd per rilanciare lo stesso invio sugli stessi file.'
      : 'Nessun comando da copiare: il trasferimento non è ancora partito.';
  } catch (err) {
    $('cleanup-status').textContent = 'Errore copia: ' + err.message;
  }
});

$('btn-restart').addEventListener('click', () => {
  previewReset();
  state.drive = state.prepared = state.plan = null;
  state.finished = false;
  $('drive-list').textContent = '';
  $('detect-status').textContent = '';
  $('cleanup-status').textContent = '';
  $('phase-eta').textContent = '';
  $('btn-cleanup').disabled = false;
  $('btn-cleanup').classList.add('hidden');
  $('btn-copy-cmd').classList.add('hidden');
  $('btn-stop').classList.add('hidden');
  $('btn-to-study').disabled = true;
  showStep('media');
  // il supporto nuovo è di solito già nel lettore: si rileva subito
  detect();
});

// il badge in alto deve riflettere le impostazioni salvate, non il valore fisso nell'HTML
window.api
  .getSettings()
  .then((d) => {
    $('pacs-badge').textContent = `${d.values.DEST_AET} @ ${d.values.PACS_IP}:${d.values.PACS_PORT}`;
  })
  .catch(() => {});

showStep('media');

// Rilevamento automatico al lancio: gira mentre l'intro copre la pagina, quindi
// quando la pagina sale i supporti sono già elencati.
detect();
