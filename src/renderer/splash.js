'use strict';

// Script esterno (non inline) così splash.html può usare la stessa CSP
// restrittiva di index.html: script-src 'self', niente 'unsafe-inline'.
(function () {
  // spirale di spicchi → globo → pulse → lettere → sottotitolo termina a ~4s: poco dopo
  // si passa da soli al programma. Senza animazioni (prefers-reduced-motion) il
  // logo è già completo e basta un attimo per leggerlo.
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
