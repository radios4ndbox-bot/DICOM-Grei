'use strict';

const $ = (id) => document.getElementById(id);

const TYPE_MAP = {
  A: { pattern: 'MP*', strategy: 'keep' },
  B: { pattern: '*.dcm', strategy: 'rename' },
  C: { pattern: '*.dcm', strategy: 'suffix' },
  D: { pattern: '*.dcm', strategy: 'rename' },
};

const DRIVE_LABEL = { 2: 'USB', 5: 'CD/DVD/ISO' };

// pesi delle fasi sulla barra unica
const W_COPY = 48;   // 0..48
const W_SEND = 44;   // 48..92
const W_TAIL = 8;    // 92..100 (pulizia)

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

function setBar(pct, label, detail) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  $('overall-fill').style.width = p + '%';
  $('overall-pct').textContent = p + '%';
  if (label != null) $('phase-label').textContent = label;
  if (detail != null) $('phase-detail').textContent = detail;
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
    li.innerHTML =
      `<span class="tag">${DRIVE_LABEL[d.driveType] || d.kind}</span>` +
      `<b>${d.caption}</b><span class="muted">${d.volumeName || 'senza nome'}</span>`;
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
    state.plan = await window.api.classify(state.prepared.sourcePath);
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
  $('clf-tree').innerHTML = p.tree.map((t) => `<li><b>${t.name}</b> — ${t.count} file</li>`).join('');
  $('override').value = '';
}

$('btn-back-media').addEventListener('click', () => showStep('media'));
$('btn-start').addEventListener('click', startImport);

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
  setBar(0, 'Avvio…', '');
  showStep('transfer');

  let result;
  try {
    result = await window.api.runImport({ plan: state.effective, iso: state.prepared.iso });
  } catch (err) {
    $('log').textContent += '\nERRORE: ' + err.message + '\n';
    setBar(100, 'Errore durante il trasferimento', '');
    $('sum-note').textContent = err.message;
    $('summary').classList.remove('hidden');
    $('btn-restart').classList.remove('hidden');
    return;
  }
  onImportDone(result);
}

window.api.onProgress((d) => {
  if (d.phase === 'copy') {
    const done = d.copied + d.skipped;
    setBar(
      d.total ? (W_COPY * done) / d.total : 0,
      'Copia in locale…',
      `${d.copied}/${d.total} file${d.current ? ' · ' + d.current : ''}`
    );
    $('copy-skipped').textContent = d.skipped ? `${d.skipped} saltati` : '';
  } else if (d.phase === 'send') {
    setBar(
      W_COPY + (d.total ? (W_SEND * d.sent) / d.total : 0),
      'Invio a Synapse…',
      `${d.sent}/${d.total} file`
    );
    $('send-ok').textContent = 'Success: ' + d.success;
    $('send-err').textContent = 'Error: ' + d.failed;
  } else if (d.phase === 'cleanup') {
    if (d.state === 'start') {
      setBar(W_COPY + W_SEND + W_TAIL / 2, 'Pulizia cartella…', '');
    } else {
      setBar(100, 'Completato', '');
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

  setBar(W_COPY + W_SEND, 'Trasferimento completato — pronto per la pulizia',
    `${s.success || 0} inviati · ${s.failed || 0} falliti`);

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
    await window.api.cleanup({ iso: $('btn-cleanup').dataset.iso || null });
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
  showStep('media');
});

showStep('media');
