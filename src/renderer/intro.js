'use strict';

/* ══════════════════════════════════════════════════════════════════
   Intro di DICOM Grei — la regia (vedi intro.css per gli atti)

   Script esterno, non inline: la CSP della finestra è script-src 'self'.
   Gira dopo renderer.js, così l'interfaccia è già costruita quando
   l'animazione parte: costruirla durante il primo atto farebbe perdere
   fotogrammi proprio mentre la spirale si forma (regola dell'Archivist).

   Un clic o un tasto durante gli atti I–II saltano al finale.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var scena = $('intro-scena');
  var stage = $('intro-stage');
  var velo = $('intro-velo');
  var header = $('app-header');
  var pagina = $('pagina');
  var bersaglio = $('header-globe');
  var grei = $('brand-grei');
  if (!scena || !stage || !header || !pagina) return;

  var TEMPI = {
    primo: 120,        // partenza del primo spicchio
    passo: 50,         // fra uno spicchio e il successivo
    spirale: 1000,     // volo di ciascuno spicchio
    // globo completo = primo + 8 passi + spirale; da lì in intro.css partono
    // pulse, onde, lettere (+150 ms) e sottotitolo (+950 ms, entrato a +1450)
    dopoGlobo: 1650,   // parte il volo del globo, contato dal globo completo
    volo: 800,         // volo, banda e pagina: una sola durata
    veloVia: 340,      // arrivata sulla barra, la banda si dissolve
    passoBarra: 55,    // cascata dell'intestazione
    passoSezioni: 90,  // cascata della procedura e dell'anteprima
    grei: 520,         // dopo l'atterraggio: Grei si disegna per ultimo
    greiTratto: 900,   // il contorno di ogni lettera
    greiPasso: 150,    // fra una lettera e la successiva
    reteSicurezza: 2500
  };

  var cascataBarra = Array.prototype.slice.call(header.querySelectorAll('.da-cascata'));
  // i blocchi che arrivano trascinati dalla banda, nell'ordine di lettura
  var sezioni = [$('stepnav')]
    .concat(Array.prototype.slice.call(document.querySelectorAll('#step-media > *')))
    .concat([$('viewer')])
    .filter(Boolean);

  var pocoMoto = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (pocoMoto || !Element.prototype.animate) {
    togliScena();
    if (bersaglio) bersaglio.classList.add('atterrato');
    return;
  }

  // ── stato iniziale: tutto quello che entrerà dopo resta nascosto ──
  // La pagina che sale parte spostata di un'intera finestra verso il basso:
  // senza questo, per la durata della salita comparirebbe la barra di
  // scorrimento. Si scrive una proprietà sola sulla radice, due volte in
  // tutto, niente classi.
  var radice = document.documentElement;
  radice.style.overflow = 'hidden';
  header.classList.add('intro-in-corso');
  pagina.classList.add('intro-in-corso');
  sezioni.forEach(function (e) { e.classList.add('pop-sezione'); });
  if (grei) grei.classList.add('da-disegnare');

  var finito = false;
  var timer = null;

  // ── il via: due fotogrammi dopo il primo disegno ──────────────────
  // In Electron la finestra nasce nascosta e le animazioni non avanzano
  // finché non viene dipinta; la rete di sicurezza parte comunque.
  var partito = false;
  var fineSpirale = 0;
  function via() {
    if (partito) return;
    partito = true;
    var segs = scena.querySelectorAll('.seg').length;
    fineSpirale = TEMPI.primo + (segs - 1) * TEMPI.passo + TEMPI.spirale;
    scena.style.setProperty('--t-globo', fineSpirale + 'ms');
    scena.classList.add('parte');
    spirale();
    timer = setTimeout(esci, fineSpirale + TEMPI.dopoGlobo);
  }
  requestAnimationFrame(function () { requestAnimationFrame(via); });
  setTimeout(via, TEMPI.reteSicurezza);

  scena.addEventListener('click', esci);
  document.addEventListener('keydown', esci);

  // ── ATTO I: spirale logaritmica di spicchi ────────────────────────
  // Ogni spicchio scala da START a 1 in modo esponenziale mentre l'angolo
  // scende linearmente nel tempo (angolo proporzionale al logaritmo della
  // scala). Grande e lontano = vicino all'utente, più grande = più sfocato.
  function spirale() {
    var START = 9, GIRO = 330, SFOCA = 7, PUNTI = 60;
    var frames = [];
    for (var i = 0; i <= PUNTI; i++) {
      var p = i / PUNTI;
      var s = Math.pow(START, 1 - p);
      frames.push({
        offset: p,
        opacity: p < 1 ? Math.min(1, p / 0.12) * 0.9 : 1,
        transform: 'rotate(' + (-GIRO * (1 - p)).toFixed(2) + 'deg) scale(' + s.toFixed(4) + ')',
        filter: 'blur(' + Math.max(0, ((s - 1.4) / (START - 1.4)) * SFOCA).toFixed(2) + 'px)'
      });
    }
    var segs = scena.querySelectorAll('.seg');
    for (var k = 0; k < segs.length; k++) {
      segs[k].animate(frames, {
        duration: TEMPI.spirale,
        delay: TEMPI.primo + k * TEMPI.passo,
        easing: 'cubic-bezier(0.35, 0.1, 0.25, 1)',
        fill: 'both'
      });
    }
  }

  // ── ATTO III: il globo vola e si porta su la pagina ───────────────
  function esci() {
    if (finito) return;
    finito = true;
    clearTimeout(timer);
    scena.removeEventListener('click', esci);
    document.removeEventListener('keydown', esci);
    if (!partito) via();

    // Saltando a metà, gli atti I–II si chiudono sul loro stato finale:
    // il globo deve essere intero prima di partire in volo.
    scena.getAnimations({ subtree: true }).forEach(function (a) {
      try { a.finish(); } catch (_) { /* animazioni infinite: nessuna qui */ }
    });

    // Prima si legge, poi si scrive: tutte le misure qui, prima di
    // toccare una sola classe (altrimenti ogni lettura rifà il layout
    // della pagina nel fotogramma in cui parte il volo).
    var globo = scena.querySelector('.globe');
    var arrivo = bersaglio && bersaglio.querySelector('g');
    var volo = null;
    if (globo && arrivo) {
      var s = stage.getBoundingClientRect();
      var g = globo.getBoundingClientRect();
      var a = arrivo.getBoundingClientRect();
      if (g.width > 0 && a.width > 0) {
        var k = a.width / g.width;
        volo = {
          dx: a.left - s.left - (g.left - s.left) * k,
          dy: a.top - s.top - (g.top - s.top) * k,
          k: k
        };
      }
    }
    var corsa = Math.round(window.innerHeight - header.getBoundingClientRect().height);

    if (!volo) {
      radice.style.removeProperty('overflow');
      chiudiScena(); popBarra(); cascataSezioni();
      setTimeout(disegnaGrei, TEMPI.grei);
      return;
    }

    // ── scrittura: volo, banda e pagina nello stesso fotogramma ──
    scena.classList.add('in-uscita');
    stage.style.setProperty('--t-volo', TEMPI.volo + 'ms');
    stage.classList.add('in-volo');
    stage.style.transform = 'translate(' + volo.dx.toFixed(2) + 'px, ' + volo.dy.toFixed(2) + 'px) scale(' + volo.k.toFixed(5) + ')';

    velo.style.setProperty('--velo-corsa', corsa + 'px');
    velo.style.setProperty('--t-volo', TEMPI.volo + 'ms');
    velo.style.setProperty('--t-velo-via', TEMPI.veloVia + 'ms');
    velo.classList.add('armato', 'in-corsa');

    pagina.style.setProperty('--salita', corsa + 'px');
    pagina.style.setProperty('--t-volo', TEMPI.volo + 'ms');
    pagina.classList.add('sale');
    cascataSezioni();

    setTimeout(atterra, TEMPI.volo);
  }

  // Il globo è sull'intestazione; quello volante resta sopra la banda
  // finché la banda non si è dissolta, poi i due si scambiano in un
  // fotogramma: coincidono al pixel, quindi non si vede nulla.
  function atterra() {
    if (bersaglio) bersaglio.classList.add('atterrato');
    setTimeout(popBarra, 30);
    setTimeout(chiudiScena, TEMPI.veloVia);
    setTimeout(disegnaGrei, TEMPI.grei);
    // a banda dissolta non resta niente acceso (will-change, livelli)
    setTimeout(function () {
      velo.classList.remove('armato', 'in-corsa');
      pagina.classList.remove('sale', 'intro-in-corso');
      pagina.style.removeProperty('--salita');
      pagina.style.removeProperty('--t-volo');
      radice.style.removeProperty('overflow');
    }, TEMPI.veloVia + 60);
  }

  function chiudiScena() {
    stage.classList.add('atterrato');
    scena.classList.add('chiusa');
    setTimeout(togliScena, 520);
  }

  // La scena si toglie proprio dal documento: i suoi tracciati, lasciati
  // lì, si farebbero riesaminare a ogni ricalcolo dell'applicazione.
  function togliScena() {
    [scena, velo].forEach(function (e) { if (e && e.parentNode) e.parentNode.removeChild(e); });
  }

  // ── cascate ───────────────────────────────────────────────────────
  function popBarra() {
    cascataBarra.forEach(function (e, i) {
      e.style.setProperty('--pop-delay', (i * TEMPI.passoBarra) + 'ms');
      e.classList.add('pop-barra');
    });
    header.classList.remove('intro-in-corso');
    // a fine animazione la classe va via: il fill terrebbe transform:none
    // per sempre, e i pulsanti perderebbero gli effetti al passaggio
    setTimeout(function () {
      cascataBarra.forEach(function (e) {
        e.classList.remove('pop-barra');
        e.style.removeProperty('--pop-delay');
      });
    }, cascataBarra.length * TEMPI.passoBarra + 560);
  }

  function cascataSezioni() {
    sezioni.forEach(function (e, i) {
      e.style.setProperty('--pop-delay', (i * TEMPI.passoSezioni) + 'ms');
      e.classList.add('entra');
    });
    pagina.classList.remove('intro-in-corso');
    setTimeout(function () {
      sezioni.forEach(function (e) {
        e.classList.remove('entra', 'pop-sezione');
        e.style.removeProperty('--pop-delay');
      });
    }, sezioni.length * TEMPI.passoSezioni + 520);
  }

  // ── ATTO IV: Grei si disegna, lettera per lettera ─────────────────
  function disegnaGrei() {
    if (!grei) return;
    var lettere = grei.querySelectorAll('path');
    for (var i = 0; i < lettere.length; i++) {
      lettere[i].style.setProperty('--d', (i * TEMPI.greiPasso) + 'ms');
    }
    grei.style.setProperty('--t-grei-tratto', TEMPI.greiTratto + 'ms');
    grei.classList.add('disegna');
    // a disegno finito resta la scritta piena, senza animazioni appese
    var totale = (lettere.length - 1) * TEMPI.greiPasso + TEMPI.greiTratto * 0.7 + 420 + 50;
    setTimeout(function () {
      grei.classList.remove('da-disegnare', 'disegna');
      for (var j = 0; j < lettere.length; j++) lettere[j].style.removeProperty('--d');
    }, totale);
  }
})();
