'use strict';

// Script esterno (non inline) così splash.html può usare la stessa CSP
// restrittiva di index.html: script-src 'self', niente 'unsafe-inline'.
(function () {
  var btn = document.getElementById('import-btn');
  // l'animazione del logo termina a ~2.5s: il pulsante compare subito dopo
  setTimeout(function () { btn.classList.add('show'); }, 2600);
  btn.addEventListener('click', function () {
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Avvio…';
    document.body.classList.add('fade-out'); // dissolvenza prima di aprire il programma
    setTimeout(function () {
      if (window.splash && window.splash.confirm) window.splash.confirm();
    }, 430);
  });
})();
