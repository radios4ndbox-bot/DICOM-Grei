'use strict';

/* ══════════════════════════════════════════════════════════════════
   Viewer dell'archivio di DICOM Grei

   I pixel arrivano dal main già decodificati, con i valori originali
   (8 o 16 bit): finestra, zoom, rotazioni e misure si fanno qui.
   Niente percorsi: il viewer conosce un esame per identificativo e un
   file per il nome neutro che gli ha dato l'archivio.

   Tastiera e mouse seguono il viewer del PACS (Fujifilm Synapse 5, elenco
   «Keyboard Shortcuts for the Viewer and Worklist» della guida in linea),
   per le funzioni che esistono anche qui: chi referta non deve imparare
   due serie di tasti. L'elenco è in KEY_TOOLS e nel gestore dei tasti, e
   nel README.

   Mouse, sempre attivi qualunque strumento sia scelto:
     rotella = scorri · Ctrl+rotella = un pannello / due pannelli
     tasto destro = finestra/livello · tasto centrale = sposta
     doppio clic = un pannello / due pannelli
   ══════════════════════════════════════════════════════════════════ */
(function () {
  const api = window.archive;
  const $ = (id) => document.getElementById(id);
  const dpr = () => window.devicePixelRatio || 1;

  // ---------------------------------------------------------------- stato

  const state = {
    exams: [],
    examId: null,          // esame selezionato nell'elenco
    tool: 'scroll',
    layout: 1,
    sync: false,
    active: 0,
    hideMeasures: false,   // MAIUSC+A
    hideText: false,       // MAIUSC+T
  };
  const held = new Set();  // lettere tenute premute (W + trascina, MAIUSC+Z + trascina…)
  const indexes = new Map();   // id esame -> indice completo
  const measures = new Map();  // chiave immagine -> misure (valgono in entrambi i pannelli)

  // Fotogrammi decodificati. Una TC da 500 fette a 512×512 sono ~260 MB:
  // oltre il limite escono i meno recenti.
  const CACHE_MAX = 420 * 1024 * 1024;
  const frames = new Map();    // chiave -> fotogramma (l'ordine d'inserimento fa da LRU)
  const inflight = new Map();  // chiave -> promessa
  let cacheBytes = 0;

  const keyOf = (examId, im) => `${examId}|${im.f}|${im.fr}`;

  function getFrame(examId, im) {
    const key = keyOf(examId, im);
    const hit = frames.get(key);
    if (hit) {
      frames.delete(key);
      frames.set(key, hit); // di nuovo il più recente
      return Promise.resolve(hit);
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = api
      .frame(examId, im.f, im.fr)
      .catch((err) => ({ error: 'decodifica', message: String((err && err.message) || err) }))
      .then((f) => {
        inflight.delete(key);
        if (!f) f = { error: 'decodifica' };
        f.key = key;
        const size = f.pixels ? f.pixels.byteLength : 0;
        frames.set(key, f);
        cacheBytes += size;
        for (const [k, old] of frames) {
          if (cacheBytes <= CACHE_MAX || k === key) break;
          frames.delete(k);
          cacheBytes -= old.pixels ? old.pixels.byteLength : 0;
        }
        return f;
      });
    inflight.set(key, p);
    return p;
  }

  function dropExamFromCache(id) {
    for (const [k, f] of frames) {
      if (k.startsWith(id + '|')) {
        frames.delete(k);
        cacheBytes -= f.pixels ? f.pixels.byteLength : 0;
      }
    }
    for (const k of measures.keys()) if (k.startsWith(id + '|')) measures.delete(k);
    indexes.delete(id);
  }

  // ---------------------------------------------------------------- pannelli

  const panels = Array.prototype.map.call(document.querySelectorAll('.panel'), (el, i) => ({
    i,
    el,
    canvas: el.querySelector('canvas'),
    ctx: el.querySelector('canvas').getContext('2d'),
    img: document.createElement('canvas'), // l'immagine finestrata, a risoluzione nativa
    imgKey: '',
    exam: null,
    series: null,
    idx: 0,
    frame: null,
    gen: 0,
    wc: null,  // null = finestra dell'immagine
    ww: null,
    invert: false,
    zoom: 1,
    panX: 0,
    panY: 0,
    rot: 0,
    flipH: false,
    flipV: false,
    sel: null,
    draft: null,
    cine: 0,
    ov: {
      tl: el.querySelector('.ov--tl'), tr: el.querySelector('.ov--tr'),
      bl: el.querySelector('.ov--bl'), br: el.querySelector('.ov--br'),
      t: el.querySelector('.mk--t'), b: el.querySelector('.mk--b'),
      l: el.querySelector('.mk--l'), r: el.querySelector('.mk--r'),
    },
    msg: el.querySelector('.panel__msg'),
    slider: el.querySelector('.panel__slider'),
  }));

  const active = () => panels[state.active];
  const other = (p) => panels[1 - p.i];

  function setActive(i) {
    if (state.active === i) return;
    state.active = i;
    panels.forEach((p) => p.el.classList.toggle('active', p.i === i));
    syncToolbar();
    markSeries();
    if (state.layout === 1) panels.forEach(render);
  }

  function resetView(p) {
    p.zoom = 1;
    p.panX = p.panY = 0;
    p.rot = 0;
    p.flipH = p.flipV = false;
    p.wc = p.ww = null;
    p.invert = false;
  }

  function loadSeries(p, exam, series, idx) {
    stopCine(p);
    p.exam = exam;
    p.series = series;
    p.sel = null;
    p.draft = null;
    resetView(p);
    p.slider.max = String(Math.max(0, series.count - 1));
    setIndex(p, idx || 0, true);
    markSeries();
  }

  function clearPanel(p) {
    stopCine(p);
    p.exam = p.series = p.frame = null;
    p.gen++;
    p.slider.max = '0';
    render(p);
  }

  function setIndex(p, idx, fromSync) {
    if (!p.series) return;
    idx = Math.max(0, Math.min(p.series.count - 1, idx));
    p.idx = idx;
    p.slider.value = String(idx);
    p.sel = null;
    show(p);
    if (state.sync && !fromSync) followSync(p);
  }

  /** L'altro pannello va alla fetta più vicina alla stessa quota. */
  function followSync(p) {
    const o = other(p);
    if (!o.series || !p.series.spatial || !o.series.spatial || p.series.plane !== o.series.plane) return;
    const l = p.series.images[p.idx].l;
    let best = 0;
    let bestD = Infinity;
    o.series.images.forEach((im, j) => {
      const d = Math.abs(im.l - l);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    });
    if (best !== o.idx) setIndex(o, best, true);
  }

  async function show(p) {
    const gen = ++p.gen;
    const exam = p.exam;
    const im = p.series.images[p.idx];
    const key = keyOf(exam.id, im);
    const cached = frames.get(key);
    if (cached) {
      p.frame = cached;
      render(p);
    } else {
      // nel frattempo resta l'immagine di prima: scorrendo non si vede nero
      updateOverlay(p, true);
      const f = await getFrame(exam.id, im);
      if (gen !== p.gen) return; // nel frattempo si è passati ad altro
      p.frame = f;
      render(p);
    }
    prefetch(p, gen);
  }

  /** Le fette vicine, nel verso in cui è più probabile che si scorra. */
  async function prefetch(p, gen) {
    const s = p.series;
    const order = [1, 2, -1, 3, 4, -2, 5, 6, -3, 7, 8];
    for (const d of order) {
      if (gen !== p.gen) return;
      const j = p.idx + d;
      if (j < 0 || j >= s.count) continue;
      const im = s.images[j];
      if (!frames.has(keyOf(p.exam.id, im))) await getFrame(p.exam.id, im);
    }
  }

  // ---------------------------------------------------------------- finestra

  /** Finestra da usare: quella scelta, quella dell'immagine, o tutta la dinamica. */
  function windowOf(p) {
    const f = p.frame;
    if (p.wc != null && p.ww != null) return { wc: p.wc, ww: p.ww };
    if (f.wc != null && f.ww != null) return { wc: f.wc, ww: f.ww };
    return fullRange(f);
  }

  function fullRange(f) {
    if (!f.range) {
      let mn = Infinity;
      let mx = -Infinity;
      const px = f.pixels;
      for (let i = 0; i < px.length; i++) {
        const v = px[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      mn = mn * f.slope + f.intercept;
      mx = mx * f.slope + f.intercept;
      f.range = { wc: (mn + mx) / 2, ww: Math.max(1, mx - mn) };
    }
    return f.range;
  }

  function paintImage(p) {
    const f = p.frame;
    const w = f.samples === 1 ? windowOf(p) : null;
    const key = `${f.key}|${w ? w.wc + '|' + w.ww : ''}|${p.invert}`;
    if (p.imgKey === key) return;
    p.imgKey = key;

    const c = p.img;
    if (c.width !== f.cols || c.height !== f.rows) {
      c.width = f.cols;
      c.height = f.rows;
    }
    const ctx = c.getContext('2d');
    const id = ctx.createImageData(f.cols, f.rows);
    const out = new Uint32Array(id.data.buffer);
    const px = f.pixels;
    const n = f.rows * f.cols;

    if (f.samples === 3) {
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        const r = p.invert ? 255 - px[j] : px[j];
        const g = p.invert ? 255 - px[j + 1] : px[j + 1];
        const b = p.invert ? 255 - px[j + 2] : px[j + 2];
        out[i] = 0xff000000 | (b << 16) | (g << 8) | r;
      }
    } else {
      // (valore·pendenza + intercetta − limite inferiore) / ampiezza · 255,
      // ridotto a una moltiplicazione e una somma per pixel
      const lo = w.wc - 0.5 - (w.ww - 1) / 2;
      const span = Math.max(1e-6, w.ww - 1);
      const k = (f.slope * 255) / span;
      const b = ((f.intercept - lo) * 255) / span;
      const inv = p.invert !== f.invert; // MONOCHROME1 è già un negativo
      for (let i = 0; i < n; i++) {
        let g = px[i] * k + b;
        g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
        if (inv) g = 255 - g;
        out[i] = 0xff000000 | (g << 16) | (g << 8) | g;
      }
    }
    ctx.putImageData(id, 0, 0);
  }

  // ---------------------------------------------------------------- geometria

  /** Lato del pixel in mm: [riga, colonna]. Senza spaziatura si lavora in pixel. */
  function spacingOf(p) {
    const s = (p.frame && p.frame.spacing) || (p.series && p.series.spacing);
    return s && s[0] > 0 && s[1] > 0 ? s : null;
  }

  /** Scala con cui l'immagine intera sta nel pannello (zoom = 1). */
  function fitOf(p) {
    const f = p.frame;
    const sp = spacingOf(p);
    const ih = f.rows * (sp ? sp[0] / sp[1] : 1);
    const odd = p.rot % 2 === 1;
    return Math.min(p.canvas.width / (odd ? ih : f.cols), p.canvas.height / (odd ? f.cols : ih)) * 0.98;
  }

  /** Matrice immagine -> canvas, in pixel fisici. */
  function matrixOf(p) {
    const f = p.frame;
    const cw = p.canvas.width;
    const ch = p.canvas.height;
    const sp = spacingOf(p);
    const ay = sp ? sp[0] / sp[1] : 1; // pixel non quadrati (ricostruzioni)
    const s = fitOf(p) * p.zoom;
    return new DOMMatrix()
      .translate(cw / 2 + p.panX, ch / 2 + p.panY)
      // la riflessione agisce sullo schermo, dopo la rotazione: «rifletti in
      // orizzontale» scambia sempre destra e sinistra di ciò che si vede
      .scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1)
      .rotate(p.rot * 90)
      .scale(s, s * ay)
      .translate(-f.cols / 2, -f.rows / 2);
  }

  function toImage(p, x, y) {
    const pt = matrixOf(p).inverse().transformPoint(new DOMPoint(x, y));
    return { x: pt.x, y: pt.y };
  }

  function canvasPoint(p, ev) {
    const r = p.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * dpr(), y: (ev.clientY - r.top) * dpr() };
  }

  // ---------------------------------------------------------------- disegno

  const ERRORS = {
    lettura: 'File non leggibile.',
    'non-dicom': 'Il file non è un DICOM valido.',
    'senza-immagine': 'Questo oggetto non contiene un\'immagine.',
    'troppo-grande': 'Immagine troppo grande per essere mostrata.',
    troncato: 'Immagine incompleta: i dati finiscono prima del previsto.',
    tavolozza: 'Immagini a tavolozza di colori non ancora supportate.',
    colore: 'Formato di colore non supportato.',
    bit: 'Profondità di bit non supportata.',
    campioni: 'Numero di canali non supportato.',
    incoerente: 'Dimensioni dichiarate diverse da quelle dell\'immagine compressa.',
    fotogramma: 'Fotogramma inesistente.',
  };

  function errorText(f) {
    if (f.error === 'compressione') return `Compressione non supportata: ${f.name || f.transferSyntax}.`;
    if (f.error === 'decodifica') return `Immagine non decodificabile${f.name ? ' (' + f.name + ')' : ''}.`;
    return ERRORS[f.error] || 'Immagine non visualizzabile.';
  }

  function render(p) {
    const c = p.canvas;
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr()));
    const h = Math.max(1, Math.round(rect.height * dpr()));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = p.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    p.el.dataset.tool = state.tool;

    const f = p.frame;
    if (!p.series || !f) {
      p.msg.className = 'panel__msg';
      p.msg.textContent = p.series ? '' : state.exams.length ? 'Scegli una serie dall\'elenco a sinistra.' : '';
      updateOverlay(p);
      return;
    }
    if (f.error) {
      p.msg.className = 'panel__msg err';
      p.msg.textContent = errorText(f);
      updateOverlay(p);
      return;
    }
    p.msg.textContent = '';

    paintImage(p);
    const m = matrixOf(p);
    ctx.setTransform(m);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(p.img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (!state.hideMeasures) drawMeasures(p, m);
    drawProbe(p);
    updateOverlay(p);
  }

  /** Valore sotto il cursore (D + clic e tieni premuto): HU in TC. */
  function drawProbe(p) {
    const pr = p.probe;
    if (!pr) return;
    const f = p.frame;
    const x = Math.floor(pr.img.x);
    const y = Math.floor(pr.img.y);
    if (x < 0 || y < 0 || x >= f.cols || y >= f.rows) return;
    let text;
    if (f.samples === 3) {
      const i = (y * f.cols + x) * 3;
      text = 'RGB ' + f.pixels[i] + ' ' + f.pixels[i + 1] + ' ' + f.pixels[i + 2];
    } else {
      const v = f.pixels[y * f.cols + x] * f.slope + f.intercept;
      text = fmt(v, Number.isInteger(v) ? 0 : 1) + (p.series.modality === 'CT' ? ' HU' : '');
    }
    const ctx = p.ctx;
    const k = dpr();
    ctx.font = 13 * k + 'px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const w = ctx.measureText(text).width;
    ctx.strokeStyle = '#5fe0ea';
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.arc(pr.at.x, pr.at.y, 4 * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    ctx.fillRect(pr.at.x + 9 * k, pr.at.y - 22 * k, w + 8 * k, 19 * k);
    ctx.fillStyle = '#5fe0ea';
    ctx.fillText(text, pr.at.x + 13 * k, pr.at.y - 20 * k);
  }

  let frameReq = 0;
  const dirty = new Set();
  function renderSoon(p) {
    dirty.add(p);
    if (frameReq) return;
    frameReq = requestAnimationFrame(() => {
      frameReq = 0;
      for (const q of dirty) render(q);
      dirty.clear();
    });
  }

  // ---------------------------------------------------------------- dati a schermo

  const AXES = [['L', 'R'], ['P', 'A'], ['H', 'F']]; // +x sinistra, +y posteriore, +z testa

  function letters(v) {
    const parts = v
      .map((x, i) => ({ a: Math.abs(x), ch: x > 0 ? AXES[i][0] : AXES[i][1] }))
      .filter((o) => o.a > 0.25)
      .sort((a, b) => b.a - a.a);
    return parts.map((o) => o.ch).join('');
  }

  /** Lettere di orientamento ai quattro bordi, tenendo conto di rotazioni e riflessioni. */
  function updateMarkers(p) {
    const iop = p.series && p.series.iop;
    const f = p.frame;
    if (!iop || !f || f.error) {
      p.ov.t.textContent = p.ov.b.textContent = p.ov.l.textContent = p.ov.r.textContent = '';
      return;
    }
    // quale direzione dell'immagine finisce verso destra e verso il basso dello schermo
    const inv = matrixOf(p).inverse();
    const dir = (dx, dy) => {
      const a = inv.a * dx + inv.c * dy;
      const b = inv.b * dx + inv.d * dy;
      const n = Math.hypot(a, b) || 1;
      // colonna crescente = iop[0..2], riga crescente = iop[3..5]
      return [0, 1, 2].map((k) => (a / n) * iop[k] + (b / n) * iop[3 + k]);
    };
    const right = dir(1, 0);
    const down = dir(0, 1);
    p.ov.r.textContent = letters(right);
    p.ov.l.textContent = letters(right.map((x) => -x));
    p.ov.b.textContent = letters(down);
    p.ov.t.textContent = letters(down.map((x) => -x));
  }

  function fmt(n, d) {
    return Number(n).toFixed(d == null ? 0 : d).replace('.', ',');
  }

  function updateOverlay(p, loading) {
    const o = p.ov;
    if (!p.series) {
      o.tl.textContent = o.tr.textContent = o.bl.textContent = o.br.textContent = '';
      updateMarkers(p);
      return;
    }
    const ex = p.exam;
    const s = p.series;
    const f = p.frame && !p.frame.error ? p.frame : null;
    const im = s.images[p.idx];

    o.tl.textContent = [ex.patient.name || 'Paziente senza nome', ex.patient.id, ex.patient.birth && 'nato/a ' + ex.patient.birth]
      .filter(Boolean)
      .join('\n');
    o.tr.textContent = [ex.study.date, ex.study.description, [s.modality, s.description].filter(Boolean).join(' · ')]
      .filter(Boolean)
      .join('\n');

    const bl = [`Im ${p.idx + 1}/${s.count}${loading ? ' …' : ''}`];
    if (im.l != null) bl.push(`Pos ${fmt(im.l, 1)} mm${s.thickness ? ' · sp ' + fmt(s.thickness, 1) + ' mm' : ''}`);
    if (f) bl.push(`${f.cols}×${f.rows} · zoom ${fmt(p.zoom * 100)}%`);
    o.bl.textContent = bl.join('\n');

    const br = [];
    if (f && f.samples === 1) {
      const w = windowOf(p);
      br.push(`L ${fmt(w.wc)}  W ${fmt(w.ww)}`);
    }
    if (f && f.lossy) br.push('compressione con perdita');
    if (f && f.spacingKind === 'rivelatore') br.push('misure sul piano del rivelatore');
    if (f && !spacingOf(p)) br.push('misure in pixel: spaziatura non dichiarata');
    o.br.textContent = br.join('\n');

    updateMarkers(p);
  }

  // ---------------------------------------------------------------- misure

  const HIT = 9; // pixel CSS

  function currentMeasures(p) {
    if (!p.series) return [];
    const key = keyOf(p.exam.id, p.series.images[p.idx]);
    let list = measures.get(key);
    if (!list) {
      list = [];
      measures.set(key, list);
    }
    return list;
  }

  function mm(p, a, b) {
    const sp = spacingOf(p);
    return sp ? Math.hypot((b.x - a.x) * sp[1], (b.y - a.y) * sp[0]) : null;
  }

  function lengthText(p, a, b) {
    const d = mm(p, a, b);
    if (d == null) return `${fmt(Math.hypot(b.x - a.x, b.y - a.y), 1)} px`;
    return `${fmt(d, 1)} mm${p.frame.spacingKind === 'rivelatore' ? '*' : ''}`;
  }

  function angleText(p, a, v, b) {
    const sp = spacingOf(p) || [1, 1];
    const ux = (a.x - v.x) * sp[1];
    const uy = (a.y - v.y) * sp[0];
    const wx = (b.x - v.x) * sp[1];
    const wy = (b.y - v.y) * sp[0];
    const den = Math.hypot(ux, uy) * Math.hypot(wx, wy);
    if (!den) return '';
    const deg = (Math.acos(Math.max(-1, Math.min(1, (ux * wx + uy * wy) / den))) * 180) / Math.PI;
    return `${fmt(deg, 1)}°`;
  }

  /** Media, deviazione, minimo e massimo dei valori dentro l'ellisse. */
  function roiStats(p, m) {
    const f = p.frame;
    const cx = (m.a.x + m.b.x) / 2;
    const cy = (m.a.y + m.b.y) / 2;
    const rx = Math.abs(m.b.x - m.a.x) / 2;
    const ry = Math.abs(m.b.y - m.a.y) / 2;
    const sp = spacingOf(p);
    const out = { area: sp ? Math.PI * rx * sp[1] * ry * sp[0] : null, areaPx: Math.PI * rx * ry };
    if (f.samples !== 1 || rx < 0.5 || ry < 0.5) return out;
    let n = 0;
    let sum = 0;
    let sq = 0;
    let mn = Infinity;
    let mx = -Infinity;
    const y0 = Math.max(0, Math.ceil(cy - ry));
    const y1 = Math.min(f.rows - 1, Math.floor(cy + ry));
    for (let y = y0; y <= y1; y++) {
      // il pixel conta se il suo centro cade nell'ellisse
      const t = (y + 0.5 - cy) / ry;
      const half = rx * Math.sqrt(Math.max(0, 1 - t * t));
      const x0 = Math.max(0, Math.ceil(cx - half - 0.5));
      const x1 = Math.min(f.cols - 1, Math.floor(cx + half - 0.5));
      for (let x = x0; x <= x1; x++) {
        const v = f.pixels[y * f.cols + x] * f.slope + f.intercept;
        n++;
        sum += v;
        sq += v * v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    if (n) {
      out.n = n;
      out.mean = sum / n;
      out.sd = Math.sqrt(Math.max(0, sq / n - out.mean * out.mean));
      out.min = mn;
      out.max = mx;
    }
    return out;
  }

  function roiText(p, m) {
    const st = roiStats(p, m);
    const unit = p.series.modality === 'CT' ? ' HU' : '';
    const lines = [];
    if (st.n) {
      lines.push(`Media ${fmt(st.mean, 1)}${unit}  DS ${fmt(st.sd, 1)}`);
      lines.push(`Min ${fmt(st.min)}  Max ${fmt(st.max)}`);
    }
    if (st.area != null) {
      lines.push(st.area >= 100 ? `Area ${fmt(st.area / 100, 2)} cm²` : `Area ${fmt(st.area, 1)} mm²`);
    } else {
      lines.push(`Area ${fmt(st.areaPx)} px²`);
    }
    return lines;
  }

  function pointsOf(m) {
    return m.type === 'angle' ? m.pts : [m.a, m.b];
  }

  function drawMeasures(p, M) {
    const ctx = p.ctx;
    const k = dpr();
    const list = currentMeasures(p).slice();
    if (p.draft) list.push(p.draft);
    if (!list.length) return;
    const S = (pt) => M.transformPoint(new DOMPoint(pt.x, pt.y));

    ctx.lineWidth = 1.5 * k;
    ctx.font = `${12 * k}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';

    const label = (lines, x, y) => {
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      const wide = Math.max(...lines.map((t) => ctx.measureText(t).width));
      ctx.fillRect(x - 3 * k, y - 2 * k, wide + 6 * k, lines.length * 15 * k + 3 * k);
      lines.forEach((t, i) => {
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(t, x, y + i * 15 * k);
      });
    };

    for (const m of list) {
      const color = m === p.sel ? '#5fe0ea' : '#ffd84a';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      const pts = pointsOf(m).map(S);

      ctx.beginPath();
      if (m.type === 'roi') {
        // l'ellisse si disegna nello spazio dell'immagine, così segue rotazioni e pixel non quadrati
        const cx = (m.a.x + m.b.x) / 2;
        const cy = (m.a.y + m.b.y) / 2;
        ctx.save();
        ctx.setTransform(M);
        ctx.ellipse(cx, cy, Math.abs(m.b.x - m.a.x) / 2, Math.abs(m.b.y - m.a.y) / 2, 0, 0, Math.PI * 2);
        ctx.restore();
      } else {
        pts.forEach((s, i) => (i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y)));
      }
      ctx.stroke();

      for (const s of pts) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 3 * k, 0, Math.PI * 2);
        ctx.fill();
      }

      const last = pts[pts.length - 1];
      let lines = [];
      if (m.type === 'dist') lines = [lengthText(p, m.a, m.b)];
      else if (m.type === 'angle' && m.pts.length === 3) lines = [angleText(p, m.pts[0], m.pts[1], m.pts[2])];
      else if (m.type === 'roi') lines = roiText(p, m);
      const anchor = m.type === 'angle' && pts.length === 3 ? pts[1] : last;
      if (lines.length && lines[0]) label(lines, anchor.x + 8 * k, anchor.y + 8 * k);
    }
  }

  /** Il punto di una misura sotto il cursore, se c'è. */
  function hitHandle(p, c) {
    const M = matrixOf(p);
    const list = currentMeasures(p);
    for (let i = list.length - 1; i >= 0; i--) {
      const pts = pointsOf(list[i]);
      for (let j = 0; j < pts.length; j++) {
        const s = M.transformPoint(new DOMPoint(pts[j].x, pts[j].y));
        if (Math.hypot(s.x - c.x, s.y - c.y) <= HIT * dpr()) return { m: list[i], pt: pts[j] };
      }
    }
    return null;
  }

  function removeMeasure(p, m) {
    const list = currentMeasures(p);
    const i = list.indexOf(m);
    if (i >= 0) list.splice(i, 1);
    if (p.sel === m) p.sel = null;
  }

  // ---------------------------------------------------------------- mouse

  const MEASURE_TOOLS = new Set(['dist', 'angle', 'roi']);
  let lastLayoutWheel = 0;
  let momentaryUsed = false;

  /** Trascinamenti con modificatore sul tasto sinistro, come in Synapse. */
  function modifierMode(e) {
    if (e.button !== 0) return null;
    if (e.altKey && e.ctrlKey) return 'zoom';        // ALT+CTRL + trascina
    if (e.altKey && e.shiftKey) return 'pan';        // ALT+MAIUSC + trascina
    if (e.altKey) return 'wl';                       // ALT + trascina
    if (e.shiftKey && held.has('z')) return 'zoom';  // MAIUSC+Z + trascina
    if (e.shiftKey && held.has('x')) return 'pan';   // MAIUSC+X + trascina
    return null;
  }

  function attach(p) {
    const c = p.canvas;
    let drag = null;

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      setActive(p.i);
      momentaryUsed = true; // la lettera tenuta premuta è stata usata: al rilascio si torna allo strumento di prima
      // X + clic: svuota il pannello
      if (e.button === 0 && held.has('x') && !e.shiftKey) return void clearPanel(p);
      if (!p.frame || p.frame.error) return;
      const pos = canvasPoint(p, e);
      const mode = e.button === 2 ? 'wl' : e.button === 1 ? 'pan' : modifierMode(e) || state.tool;
      if (e.button === 1) e.preventDefault();
      c.setPointerCapture(e.pointerId);

      if (e.button === 0 && MEASURE_TOOLS.has(mode)) {
        const hit = hitHandle(p, pos);
        if (hit) {
          p.sel = hit.m;
          drag = { mode: 'handle', pt: hit.pt, last: pos };
          renderSoon(p);
          return;
        }
        const at = toImage(p, pos.x, pos.y);
        if (mode === 'angle') {
          // tre clic: primo lato, vertice, secondo lato
          if (!p.draft) p.draft = { type: 'angle', pts: [at, { ...at }] };
          else {
            p.draft.pts[p.draft.pts.length - 1] = at;
            if (p.draft.pts.length === 3) {
              currentMeasures(p).push(p.draft);
              p.sel = p.draft;
              p.draft = null;
            } else p.draft.pts.push({ ...at });
          }
          renderSoon(p);
          return;
        }
        p.draft = { type: mode, a: at, b: { ...at } };
        drag = { mode: 'draw', start: pos, last: pos };
        renderSoon(p);
        return;
      }

      if (mode === 'probe') p.probe = { at: pos, img: toImage(p, pos.x, pos.y) };
      drag = {
        mode,
        last: pos,
        start: pos,
        acc: 0,
        anchor: toImage(p, pos.x, pos.y),
        w: p.frame.samples === 1 ? { ...windowOf(p) } : null,
      };
      if (mode === 'pan') c.style.cursor = 'grabbing';
      if (mode === 'probe') renderSoon(p); // il valore compare al clic, senza aspettare un movimento
    });

    c.addEventListener('pointermove', (e) => {
      const pos = canvasPoint(p, e);
      if (!drag) {
        // elastico dell'angolo in costruzione
        if (p.draft && p.draft.type === 'angle') {
          p.draft.pts[p.draft.pts.length - 1] = toImage(p, pos.x, pos.y);
          renderSoon(p);
        }
        return;
      }
      const dx = pos.x - drag.last.x;
      const dy = pos.y - drag.last.y;

      if (drag.mode === 'handle') {
        const at = toImage(p, pos.x, pos.y);
        drag.pt.x = at.x;
        drag.pt.y = at.y;
      } else if (drag.mode === 'draw') {
        p.draft.b = toImage(p, pos.x, pos.y);
      } else if (drag.mode === 'scroll') {
        // tutta la pila in circa un'altezza di pannello, ma mai troppo nervoso
        const per = Math.max(3 * dpr(), Math.min(14 * dpr(), p.canvas.height / p.series.count));
        drag.acc += dy;
        const steps = Math.trunc(drag.acc / per);
        if (steps) {
          drag.acc -= steps * per;
          setIndex(p, p.idx + steps);
        }
      } else if (drag.mode === 'wl' && drag.w) {
        // sensibilità proporzionale alla dinamica: 1 px ≈ 2 HU su una TC
        const k = Math.max(0.25, fullRange(p.frame).ww / 2048) / dpr();
        drag.w.ww = Math.max(1, drag.w.ww + dx * k);
        drag.w.wc += dy * k;
        p.wc = drag.w.wc;
        p.ww = drag.w.ww;
        $('preset').value = '';
      } else if (drag.mode === 'zoom') {
        p.zoom = Math.max(0.1, Math.min(40, p.zoom * Math.exp(-dy * 0.006)));
        keepUnder(p, drag.anchor, drag.start);
      } else if (drag.mode === 'pan') {
        p.panX += dx;
        p.panY += dy;
      } else if (drag.mode === 'probe') {
        p.probe = { at: pos, img: toImage(p, pos.x, pos.y) };
      }
      drag.last = pos;
      renderSoon(p);
    });

    const end = (e) => {
      if (!drag) return;
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {}
      if (drag.mode === 'draw' && p.draft) {
        const pos = canvasPoint(p, e);
        // un clic senza trascinare non lascia una misura lunga zero
        if (Math.hypot(pos.x - drag.start.x, pos.y - drag.start.y) > 4 * dpr()) {
          currentMeasures(p).push(p.draft);
          p.sel = p.draft;
        }
        p.draft = null;
      }
      drag = null;
      p.probe = null;
      c.style.cursor = '';
      renderSoon(p);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!p.frame || p.frame.error) return;
        setActive(p.i);
        if (e.ctrlKey) {
          // un cambio solo per gesto: la rotella manda molti scatti
          const now = Date.now();
          if (now - lastLayoutWheel > 350) setLayout(state.layout === 1 ? 2 : 1);
          lastLayoutWheel = now;
        } else {
          setIndex(p, p.idx + (e.deltaY > 0 ? 1 : -1));
        }
      },
      { passive: false }
    );

    c.addEventListener('dblclick', () => {
      if (MEASURE_TOOLS.has(state.tool)) return;
      setLayout(state.layout === 1 ? 2 : 1);
    });

    p.slider.addEventListener('input', () => {
      setActive(p.i);
      setIndex(p, Number(p.slider.value));
    });
  }

  /** Dopo uno zoom, il punto dell'immagine sotto il cursore resta sotto il cursore. */
  function keepUnder(p, imgPt, screenPt) {
    const s = matrixOf(p).transformPoint(new DOMPoint(imgPt.x, imgPt.y));
    p.panX += screenPt.x - s.x;
    p.panY += screenPt.y - s.y;
  }

  // ---------------------------------------------------------------- barra

  function setTool(t) {
    state.tool = t;
    panels.forEach((p) => {
      p.draft = null;
      p.el.dataset.tool = t;
      renderSoon(p);
    });
    document.querySelectorAll('[data-tool]').forEach((b) => {
      if (b.tagName === 'BUTTON') b.classList.toggle('on', b.dataset.tool === t);
    });
  }

  function setLayout(n) {
    state.layout = n;
    $('views').dataset.layout = String(n);
    $('btn-layout').classList.toggle('on', n === 2);
    $('btn-sync').disabled = n !== 2;
    // il layout cambia le dimensioni dei canvas: si ridisegna a impaginazione fatta
    requestAnimationFrame(() => panels.forEach(render));
  }

  function syncToolbar() {
    const p = active();
    $('btn-invert').classList.toggle('on', p.invert);
    $('btn-cine').classList.toggle('on', !!p.cine);
    $('btn-cine').textContent = p.cine ? '■ Ferma' : '▶ Cine';
    if (p.wc == null) $('preset').value = '';
  }

  function stopCine(p) {
    if (p.cine) clearInterval(p.cine);
    p.cine = 0;
    if (p === active()) syncToolbar();
  }

  function toggleCine(p) {
    if (p.cine) return stopCine(p);
    if (!p.series || p.series.count < 2) return;
    const fps = Math.max(1, Math.min(60, Number($('fps').value) || 12));
    p.cine = setInterval(() => setIndex(p, (p.idx + 1) % p.series.count), 1000 / fps);
    syncToolbar();
  }

  document.querySelectorAll('.tools [data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('preset').addEventListener('change', () => {
    const p = active();
    const v = $('preset').value;
    if (!p.frame || p.frame.error || p.frame.samples !== 1) return;
    if (v === 'default' || v === '') p.wc = p.ww = null;
    else if (v === 'full') {
      const r = fullRange(p.frame);
      p.wc = r.wc;
      p.ww = r.ww;
    } else {
      const [c, w] = v.split(',').map(Number);
      p.wc = c;
      p.ww = w;
    }
    renderSoon(p);
  });
  $('btn-invert').addEventListener('click', () => {
    active().invert = !active().invert;
    syncToolbar();
    renderSoon(active());
  });
  $('btn-rot').addEventListener('click', () => {
    const p = active();
    p.rot = (p.rot + 1) % 4;
    p.panX = p.panY = 0;
    renderSoon(p);
  });
  $('btn-fliph').addEventListener('click', () => {
    active().flipH = !active().flipH;
    renderSoon(active());
  });
  $('btn-flipv').addEventListener('click', () => {
    active().flipV = !active().flipV;
    renderSoon(active());
  });
  $('btn-reset').addEventListener('click', () => {
    resetView(active());
    syncToolbar();
    renderSoon(active());
  });
  $('btn-clear').addEventListener('click', () => {
    const p = active();
    if (p.sel) removeMeasure(p, p.sel);
    else currentMeasures(p).length = 0;
    p.draft = null;
    renderSoon(p);
  });
  $('btn-cine').addEventListener('click', () => toggleCine(active()));
  $('fps').addEventListener('change', () => {
    const p = active();
    if (p.cine) {
      stopCine(p);
      toggleCine(p);
    }
  });
  $('btn-layout').addEventListener('click', () => setLayout(state.layout === 1 ? 2 : 1));
  $('btn-sync').addEventListener('click', () => setSync(!state.sync));
  $('btn-full').addEventListener('click', () => api.fullscreen());

  // «Compara»: la stessa immagine in una seconda finestra, da mettere sullo
  // schermo accanto (di fianco al viewer del PACS, o a questo).
  $('btn-compare').addEventListener('click', () => {
    const p = active();
    api.compare(p.series ? { id: p.exam.id, key: p.series.key, idx: p.idx } : {});
  });
  // nella finestra di confronto l'elenco a lato è chiuso: questo lo riapre
  $('btn-side').addEventListener('click', () => {
    $('btn-side').classList.toggle('on', document.body.classList.toggle('show-side'));
  });

  /* Tastiera, come nel viewer di Synapse 5.
     «Lettera + clic»: la lettera sceglie lo strumento del tasto sinistro. Se
     la si tiene premuta mentre si usa il mouse, al rilascio torna lo strumento
     di prima (uso al volo); se la si batte e basta, lo strumento resta. */
  const KEY_TOOLS = {
    r: 'dist',   // R + clic           righello
    g: 'angle',  // G + clic           angolo a 3 punti
    e: 'roi',    // E + clic           ROI ellittica
    d: 'probe',  // D + clic e tieni   valore di densità
    w: 'wl',     // W + trascina       finestra/livello
    z: 'scroll', // Z + trascina       scorrimento rapido della serie
  };
  // Tastierino numerico = finestre predefinite. In Synapse dipendono da
  // modalità e sito: qui seguono l'ordine del menu «Finestra…».
  const NUMPAD_PRESET = ['default', '40,400', '40,350', '-600,1600', '400,1800', '40,80', '300,600', 'full'];

  let momentary = null; // { key, previous }

  function setSync(on) {
    state.sync = on;
    $('btn-sync').classList.toggle('on', on);
    if (on) followSync(active());
  }

  function stepSeries(p, d) {
    if (!p.series) return;
    const list = p.exam.series;
    const i = list.indexOf(p.series) + d;
    if (i >= 0 && i < list.length) loadSeries(p, p.exam, list[i]);
  }

  function applyPreset(v) {
    $('preset').value = v;
    $('preset').dispatchEvent(new Event('change'));
  }

  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
    const p = active();
    const k = e.key;
    const low = k.length === 1 ? k.toLowerCase() : k;
    if (low.length === 1) held.add(low);

    if (k === 'F11') return void api.fullscreen();
    if (k === 'Escape') {
      if (p.draft) p.draft = null;
      else if (p.sel) p.sel = null;
      else setTool('scroll');
      return void renderSoon(p);
    }
    if (k === 'Delete' || k === 'Backspace') {
      // MAIUSC+CANC: via tutte le misure dell'esame; CANC: quella selezionata
      if (e.shiftKey) {
        for (const key of [...measures.keys()]) if (p.exam && key.startsWith(p.exam.id + '|')) measures.delete(key);
        panels.forEach((q) => {
          q.sel = q.draft = null;
        });
      } else if (p.sel) removeMeasure(p, p.sel);
      return void panels.forEach(renderSoon);
    }
    if (k === ' ') {
      e.preventDefault();
      return void toggleCine(p);
    }
    // MAIUSC + frecce: serie precedente / successiva
    if (e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      e.preventDefault();
      return void stepSeries(p, k === 'ArrowRight' ? 1 : -1);
    }
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, PageDown: 10, PageUp: -10 }[k];
    if (step) {
      e.preventDefault();
      return void setIndex(p, p.idx + step);
    }
    if (k === 'Home') return void setIndex(p, 0);
    if (k === 'End') return void (p.series && setIndex(p, p.series.count - 1));

    // tastierino numerico: finestre predefinite (anche + e - arrivano di lì, ma hanno un altro e.code)
    if (/^Numpad[0-9]$/.test(e.code) && !e.ctrlKey && !e.altKey) {
      const v = NUMPAD_PRESET[Number(e.code.slice(6))];
      if (v) applyPreset(v);
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (k === '+') {
      // zoom 1x: un pixel dell'immagine su un pixel dello schermo
      if (p.frame && !p.frame.error) {
        p.zoom = 1 / fitOf(p);
        p.panX = p.panY = 0;
      }
      return void renderSoon(p);
    }
    if (k === '-') {
      // adatta al pannello
      p.zoom = 1;
      p.panX = p.panY = 0;
      return void renderSoon(p);
    }

    if (e.shiftKey) {
      if (low === 'r') return void $('btn-reset').click(); // ripristina l'immagine
      if (low === 'a') {
        // mostra / nascondi le misure
        state.hideMeasures = !state.hideMeasures;
        return void panels.forEach(renderSoon);
      }
      if (low === 't') {
        // mostra / nascondi i dati a schermo
        state.hideText = !state.hideText;
        $('views').classList.toggle('no-text', state.hideText);
      }
      return; // MAIUSC+Z e MAIUSC+X valgono solo insieme al trascinamento
    }

    if (KEY_TOOLS[low]) {
      if (e.repeat) return;
      momentary = { key: low, previous: state.tool };
      momentaryUsed = false;
      return void setTool(KEY_TOOLS[low]);
    }
    if (low === 's') return void (state.layout === 2 && setSync(!state.sync)); // scorrimento collegato sì/no
    if (low === 'j') return void (state.layout === 2 && setSync(true));       // collega le serie con lo stesso orientamento
    if (low === 'c') return void setSync(false);                              // scollega
  });

  document.addEventListener('keyup', (e) => {
    const low = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    held.delete(low);
    // strumento preso al volo tenendo premuta la lettera: si torna a quello di prima
    if (momentary && momentary.key === low) {
      const back = momentaryUsed && !active().draft ? momentary.previous : null;
      momentary = null;
      if (back) setTool(back);
    }
  });
  // perdendo il fuoco i keyup non arrivano: nessun tasto deve restare "premuto"
  window.addEventListener('blur', () => {
    held.clear();
    momentary = null;
  });

  // ---------------------------------------------------------------- elenco esami

  const REASON = { 'invio-fallito': 'Invio non riuscito', 'non-indicizzato': 'Non indicizzato dal PACS' };

  function examLine(m) {
    return [m.modalities && m.modalities.join('/'), m.study.date, m.study.description].filter(Boolean).join(' · ');
  }

  function renderExams() {
    const ul = $('exams');
    ul.textContent = '';
    $('exam-count').textContent = state.exams.length ? `(${state.exams.length})` : '';
    $('exams-empty').hidden = state.exams.length > 0;

    for (const m of state.exams) {
      const li = document.createElement('li');
      li.className = 'exam' + (m.id === state.examId ? ' on' : '');

      const name = document.createElement('div');
      name.className = 'exam__name';
      name.textContent = m.patient.name || 'Paziente senza nome';
      const l1 = document.createElement('div');
      l1.className = 'exam__line';
      l1.textContent = [m.patient.birth && 'nato/a ' + m.patient.birth, m.patient.id].filter(Boolean).join(' · ');
      const l2 = document.createElement('div');
      l2.className = 'exam__line';
      l2.textContent = examLine(m);
      const l3 = document.createElement('div');
      l3.className = 'exam__line';
      l3.textContent = `${m.imageCount} immagini · ${m.seriesCount} serie`;

      const foot = document.createElement('div');
      foot.className = 'exam__foot';
      const why = document.createElement('span');
      why.className = 'exam__why';
      why.textContent = REASON[m.reason] || m.reasonText || '';
      const days = document.createElement('span');
      days.className = 'exam__days' + (m.daysLeft <= 3 ? ' soon' : '');
      days.textContent = m.daysLeft <= 0 ? 'scade oggi' : m.daysLeft === 1 ? 'scade domani' : `scade fra ${m.daysLeft} giorni`;
      days.title = 'Archiviato il ' + new Date(m.archivedAt).toLocaleString('it-IT') + (m.archivedBy ? ' da ' + m.archivedBy : '');
      foot.append(why, days);

      const del = document.createElement('button');
      del.className = 'exam__del';
      del.textContent = '✕';
      del.title = 'Elimina questo esame dall\'archivio';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (li.querySelector('.exam__confirm')) return;
        const box = document.createElement('div');
        box.className = 'exam__confirm';
        const q = document.createElement('span');
        q.textContent = 'Eliminare definitivamente?';
        const yes = document.createElement('button');
        yes.className = 'yes';
        yes.textContent = 'Elimina';
        const no = document.createElement('button');
        no.textContent = 'Annulla';
        yes.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          yes.disabled = true;
          try {
            await api.remove(m.id);
          } catch (err) {
            q.textContent = 'Non eliminato: ' + err.message;
            yes.disabled = false;
          }
        });
        no.addEventListener('click', (ev) => {
          ev.stopPropagation();
          box.remove();
        });
        box.append(q, yes, no);
        li.appendChild(box);
      });

      li.append(name, l1, l2, l3, foot, del);
      li.addEventListener('click', () => selectExam(m.id));
      ul.appendChild(li);
    }
  }

  async function refreshExams() {
    state.exams = await api.list();
    const ids = new Set(state.exams.map((m) => m.id));
    // esami eliminati o scaduti: via dai pannelli e dalla memoria
    for (const p of panels) if (p.exam && !ids.has(p.exam.id)) clearPanel(p);
    for (const id of [...indexes.keys()]) if (!ids.has(id)) dropExamFromCache(id);
    if (state.examId && !ids.has(state.examId)) {
      state.examId = null;
      $('series').textContent = '';
    }
    renderExams();
    if (!state.examId && state.exams.length) {
      // all'apertura: l'esame chiesto dal main, se c'è ancora, altrimenti il più recente
      const t = wanted && ids.has(wanted.id) ? wanted : null;
      selectExam(t ? t.id : state.exams[0].id, t);
    } else panels.forEach(render);
  }

  // ---------------------------------------------------------------- serie

  let thumbGen = 0;
  let wanted = null; // { id, key?, idx? } chiesto dal main all'apertura

  /** @param {{key?:string, idx?:number}} [target] serie e immagine da mostrare subito */
  async function selectExam(id, target) {
    if (!state.exams.some((m) => m.id === id)) return;
    state.examId = id;
    renderExams();
    let idx = indexes.get(id);
    if (!idx) {
      try {
        idx = await api.index(id);
      } catch (err) {
        $('series').textContent = 'Indice dell\'esame non leggibile: ' + err.message;
        return;
      }
      indexes.set(id, idx);
    }
    if (state.examId !== id) return;
    renderSeries(idx);
    // il pannello attivo, se vuoto o su un altro esame, mostra la serie più lunga
    const p = active();
    const asked = target && target.key ? idx.series.find((s) => s.key === target.key) : null;
    if (asked) {
      loadSeries(p, idx, asked, target.idx || 0);
    } else if (!p.series || p.exam.id !== id) {
      const best = idx.series.slice().sort((a, b) => b.count - a.count)[0];
      if (best) loadSeries(p, idx, best);
    }
  }

  function markSeries() {
    const p = active();
    document.querySelectorAll('.serie').forEach((el) => {
      el.classList.toggle('on', !!p.series && p.exam.id === el.dataset.exam && p.series.key === el.dataset.key);
    });
  }

  function renderSeries(idx) {
    const box = $('series');
    box.textContent = '';
    const gen = ++thumbGen;
    const todo = [];
    for (const s of idx.series) {
      const el = document.createElement('div');
      el.className = 'serie';
      el.dataset.exam = idx.id;
      el.dataset.key = s.key;
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const cap = document.createElement('div');
      cap.className = 'serie__cap';
      const b = document.createElement('b');
      b.textContent = s.description || s.modality || 'Serie';
      const sp = document.createElement('span');
      sp.textContent = [s.modality, s.plane, `${s.count} imm.`].filter(Boolean).join(' · ');
      cap.append(b, sp);
      el.append(cv, cap);
      el.title = [s.number != null && 'Serie ' + s.number, s.description, `${s.cols}×${s.rows}`].filter(Boolean).join(' · ');
      el.addEventListener('click', () => loadSeries(active(), idx, s));
      box.appendChild(el);
      todo.push({ s, cv });
    }
    markSeries();
    // una miniatura alla volta: non devono rubare il worker all'immagine che si sta guardando
    (async () => {
      for (const { s, cv } of todo) {
        if (gen !== thumbGen) return;
        const f = await getFrame(idx.id, s.images[Math.floor((s.count - 1) / 2)]);
        if (gen !== thumbGen) return;
        thumbnail(cv, f);
      }
    })();
  }

  function thumbnail(cv, f) {
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!f || f.error) {
      ctx.fillStyle = '#8298a1';
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('non visualizzabile', cv.width / 2, cv.height / 2);
      return;
    }
    // stesso percorso del pannello, su un pannello finto: una sola implementazione della finestra
    const fake = { frame: f, img: document.createElement('canvas'), imgKey: '', wc: null, ww: null, invert: false };
    paintImage(fake);
    const ay = f.spacing ? f.spacing[0] / f.spacing[1] : 1;
    const k = Math.min(cv.width / f.cols, cv.height / (f.rows * ay));
    const w = f.cols * k;
    const h = f.rows * ay * k;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fake.img, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
  }

  // ---------------------------------------------------------------- avvio

  // Finestra di confronto (aperta con «Compara»): stessa pagina, senza elenco a
  // lato, così l'immagine prende tutto lo schermo su cui la si mette.
  if (location.hash === '#compare') {
    document.body.classList.add('compare');
    document.title = 'DICOM Grei — Confronto';
    document.querySelector('.vbar__sub').textContent = 'Confronto';
  }

  panels.forEach(attach);
  new ResizeObserver(() => panels.forEach(renderSoon)).observe($('views'));
  setTool('scroll');
  setLayout(1);

  // Il main dice su cosa aprirsi: un esame (dalla finestra principale) oppure
  // esame + serie + immagine (una finestra di confronto).
  api.onOpenExam((t) => {
    wanted = typeof t === 'string' ? { id: t } : t;
    if (wanted && state.exams.some((m) => m.id === wanted.id)) selectExam(wanted.id, wanted);
  });
  api.onChanged(() => refreshExams());
  refreshExams();
})();
