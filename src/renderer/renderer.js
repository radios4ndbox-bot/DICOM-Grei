'use strict';

const $ = (id) => document.getElementById(id);

const TYPE_MAP = {
  A: { pattern: 'MP*', strategy: 'keep' },
  B: { pattern: '*.dcm', strategy: 'rename' },
  C: { pattern: '*.dcm', strategy: 'suffix' },
  D: { pattern: '*.dcm', strategy: 'rename' },
};

const DRIVE_LABEL = { 2: 'USB', 5: 'CD/DVD/ISO' };

const state = {
  drives: [],
  drive: null,
  prepared: null, // { kind, sourcePath, iso, note }
  plan: null,     // classify()
  effective: null,
};

function showStep(name) {
  for (const s of document.querySelectorAll('.step')) s.classList.add('hidden');
  $(`step-${name}`).classList.remove('hidden');
  const order = ['media', 'structure', 'copy', 'send', 'summary'];
  const idx = order.indexOf(name);
  document.querySelectorAll('#stepnav span').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done', i < idx);
  });
}

// ---------------------------------------------------------------- STEP 1

$('btn-detect').addEventListener('click', detect);

async function detect() {
  $('detect-status').textContent = 'Scansione in corso…';
  $('drive-list').innerHTML = '';
  $('btn-to-structure').disabled = true;
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
      $('btn-to-structure').disabled = false;
    });
    $('drive-list').appendChild(li);
  }
}

$('btn-to-structure').addEventListener('click', async () => {
  if (!state.drive) return;
  $('btn-to-structure').disabled = true;
  $('detect-status').textContent = 'Preparazione supporto…';
  try {
    state.prepared = await window.api.prepareSource(state.drive);
    state.plan = await window.api.classify(state.prepared.sourcePath);
  } catch (err) {
    $('detect-status').textContent = 'Errore: ' + err.message;
    $('btn-to-structure').disabled = false;
    return;
  }
  renderStructure();
  showStep('structure');
});

// ---------------------------------------------------------------- STEP 2

function renderStructure() {
  const p = state.plan;
  const note = $('prepare-note');
  if (state.prepared.note) {
    note.textContent = state.prepared.note;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
  $('clf-type').textContent = p.type;
  $('clf-pattern').textContent = p.pattern;
  $('clf-total').textContent = p.totalFiles;
  $('clf-reasoning').textContent = p.reasoning;
  $('clf-tree').innerHTML = p.tree
    .map((t) => `<li><b>${t.name}</b> — ${t.count} file</li>`)
    .join('');
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

// ---------------------------------------------------------------- STEP 3 + 4

async function startImport() {
  state.effective = buildEffectivePlan();

  resetProgress();
  showStep('copy');

  let result;
  try {
    result = await window.api.runImport({ plan: state.effective, iso: state.prepared.iso });
  } catch (err) {
    $('log').textContent += '\nERRORE: ' + err.message + '\n';
    showStep('send');
    return;
  }
  renderSummary(result);
  showStep('summary');
}

function resetProgress() {
  $('copy-fill').style.width = '0%';
  $('copy-count').textContent = '0 / 0';
  $('copy-skipped').textContent = '';
  $('copy-current').textContent = '';
  $('send-fill').style.width = '0%';
  $('send-count').textContent = '0 / 0';
  $('send-ok').textContent = 'Success: 0';
  $('send-err').textContent = 'Error: 0';
  $('log').textContent = '';
}

window.api.onProgress((d) => {
  if (d.phase === 'copy') {
    const pct = d.total ? Math.round((d.copied / d.total) * 100) : 0;
    $('copy-fill').style.width = pct + '%';
    $('copy-count').textContent = `${d.copied} / ${d.total}`;
    $('copy-skipped').textContent = d.skipped ? `${d.skipped} saltati` : '';
    $('copy-current').textContent = d.current || '';
    if (d.copied + d.skipped >= d.total && d.total > 0) showStep('send');
  } else if (d.phase === 'send') {
    const pct = d.total ? Math.round((d.sent / d.total) * 100) : 0;
    $('send-fill').style.width = pct + '%';
    $('send-count').textContent = `${d.sent} / ${d.total}`;
    $('send-ok').textContent = 'Success: ' + d.success;
    $('send-err').textContent = 'Error: ' + d.failed;
  }
});

window.api.onLog((line) => {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
});

// ---------------------------------------------------------------- STEP 5

function renderSummary(result) {
  const s = result.send || {};
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

  $('btn-cleanup').dataset.iso = result.iso || '';
}

$('btn-cleanup').addEventListener('click', async () => {
  if (!confirm('Svuotare C:\\tmp\\dicom_import' + ($('btn-cleanup').dataset.iso ? ' e smontare l\'ISO' : '') + '?')) {
    return;
  }
  $('cleanup-status').textContent = 'Pulizia in corso…';
  try {
    const r = await window.api.cleanup({ iso: $('btn-cleanup').dataset.iso || null });
    $('cleanup-status').textContent =
      'Staging svuotato' + (r.isoDismounted ? ' · ISO smontata.' : '.');
  } catch (err) {
    $('cleanup-status').textContent = 'Errore pulizia: ' + err.message;
  }
});

$('btn-restart').addEventListener('click', () => {
  state.drive = state.prepared = state.plan = state.effective = null;
  $('drive-list').innerHTML = '';
  $('detect-status').textContent = '';
  $('cleanup-status').textContent = '';
  $('btn-to-structure').disabled = true;
  showStep('media');
});

showStep('media');
