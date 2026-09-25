'use strict';

// Script esterno (non inline) così splash.html può usare la stessa CSP
// restrittiva di index.html: script-src 'self', niente 'unsafe-inline'.
(function () {
  var btn = document.getElementById('import-btn');
  // spirale → globo → pulse → lettere → sottotitolo termina a ~3.6s; senza
  // animazioni (prefers-reduced-motion) il logo è già completo
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(function () { btn.classList.add('show'); }, still ? 200 : 3700);
  btn.addEventListener('click', function () {
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Avvio…';
    document.body.classList.add('fade-out'); // dissolvenza prima di aprire il programma
    setTimeout(function () {
      if (window.splash && window.splash.confirm) window.splash.confirm();
    }, 430);
  });
})();
