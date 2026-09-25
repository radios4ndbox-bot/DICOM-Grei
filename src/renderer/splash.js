'use strict';

// Script esterno (non inline) così splash.html può usare la stessa CSP
// restrittiva di index.html: script-src 'self', niente 'unsafe-inline'.
(function () {
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- spirale di spicchi -------------------------------------------------
  //
  // Ogni spicchio percorre una spirale logaritmica attorno al centro del globo
  // (l'origine delle trasformazioni, in splash.html): scala da START a 1 in
  // modo esponenziale e angolo che scende in proporzione al logaritmo della
  // scala, cioè lineare nel tempo. Grande e lontano = vicino all'utente,
  // piccolo = al suo posto nel globo; più grande = più sfocato.
  //
  // Tanti punti e UN solo easing sull'intero volo: niente scatti fra le tappe.
  var START = 9;          // ingrandimento di partenza
  var TURN = 330;         // gradi percorsi dalla partenza al posto finale
  var BLUR = 7;           // sfocatura alla partenza, px
  var STEPS = 60;
  var FIRST = 150;        // ms, partenza del primo spicchio
  var GAP = 80;           // ms fra uno spicchio e il successivo
  var FLIGHT = 1700;      // ms di volo di ciascuno

  function spiralFrames() {
    var frames = [];
    for (var i = 0; i <= STEPS; i++) {
      var p = i / STEPS;
      var s = Math.pow(START, 1 - p);
      var blur = Math.max(0, ((s - 1.4) / (START - 1.4)) * BLUR);
      frames.push({
        offset: p,
        opacity: Math.min(1, p / 0.12) * (p < 1 ? 0.9 : 1),
        transform: 'rotate(' + (-TURN * (1 - p)).toFixed(2) + 'deg) scale(' + s.toFixed(4) + ')',
        filter: 'blur(' + blur.toFixed(2) + 'px)',
      });
    }
    frames[STEPS].opacity = 1;
    return frames;
  }

  if (!still && Element.prototype.animate) {
    var frames = spiralFrames();
    var segs = document.querySelectorAll('.globe .seg');
    for (var k = 0; k < segs.length; k++) {
      segs[k].animate(frames, {
        duration: FLIGHT,
        delay: FIRST + k * GAP,
        easing: 'cubic-bezier(0.35, 0.1, 0.25, 1)', // parte deciso, si posa dolce
        fill: 'both',
      });
    }
  }

  // ---- passaggio al programma ---------------------------------------------
  //
  // spirale → globo → pulse → lettere → sottotitolo termina a ~4s: poco dopo
  // si passa da soli al programma. Senza animazioni (prefers-reduced-motion) il
  // logo è già completo e basta un attimo per leggerlo.
  var done = false;
  function proceed() {
    if (done) return;
    done = true;
    if (window.splash && window.splash.confirm) window.splash.confirm();
  }
  setTimeout(proceed, still ? 1200 : 4400);
  // chi ha fretta salta l'intro con un clic o un tasto
  document.addEventListener('click', proceed);
  document.addEventListener('keydown', proceed);
})();
