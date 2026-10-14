'use strict';

// Scorciatoie di tastiera e mouse come nel viewer di Synapse, con eventi veri.
module.exports = async ({ w, wait, js, mouse, drag, check }) => {
  const s = w.webContents;
  const rect = await js('(()=>{const r=document.querySelector(".panel.active canvas").getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height}})()');
  const fit = Math.min(rect.w / 256, rect.h / 256) * 0.98;
  const S = (ix, iy) => [Math.round(rect.l + rect.w / 2 + (ix - 128) * fit), Math.round(rect.t + rect.h / 2 + (iy - 128) * fit)];
  const [cx, cy] = S(128, 128);
  const NL = 'String.fromCharCode(10)';
  const tool = () => js('document.querySelector(".tools button.on[data-tool]").dataset.tool');
  const bl = (i) => js(`document.querySelector(".panel.active .ov--bl").textContent.split(${NL})[${i}]`);
  const br = () => js(`document.querySelector(".panel.active .ov--br").textContent.split(${NL})[0]`);
  const down = (k, mods) => s.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] });
  const up = (k, mods) => s.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] });
  const tap = async (k, mods) => { down(k, mods); up(k, mods); await wait(120); };
  const dragMod = (x0, y0, x1, y1, mods) => drag(x0, y0, x1, y1, 'left', mods);
  const slider = (v) => js(`(()=>{const sl=document.querySelector(".panel.active .panel__slider");sl.value=${v};sl.dispatchEvent(new Event("input"));})()`);

  mouse('mouseMove', cx, cy); mouse('mouseDown', cx, cy); mouse('mouseUp', cx, cy);
  await wait(150);
  await slider(24);
  await wait(400);

  // lettera battuta: lo strumento resta
  for (const [k, t] of [['R', 'dist'], ['G', 'angle'], ['E', 'roi'], ['W', 'wl'], ['D', 'probe'], ['Z', 'scroll']]) {
    await tap(k);
    check(`${k} = ${t}`, (await tool()) === t, await tool());
  }

  // lettera tenuta premuta + mouse: al rilascio torna lo strumento di prima
  down('R');
  await wait(60);
  const vy = 128 + 62 / 1.4, r = 17 / 1.4;
  await drag(...S(128 - r, vy), ...S(128 + r, vy));
  const during = await tool();
  up('R');
  await wait(150);
  check('R tenuto + trascina: righello al volo, poi torna Scorri', during === 'dist' && (await tool()) === 'scroll', `${during} -> ${await tool()}`);

  // finestra
  const w0 = await br();
  await dragMod(cx, cy, cx + 60, cy + 30, ['alt']);
  const w1 = await br();
  check('ALT + trascina = finestra/livello', w0 !== w1, `${w0} -> ${w1}`);
  check('lo strumento non cambia', (await tool()) === 'scroll');

  // zoom
  const z0 = await bl(2);
  await dragMod(cx, cy, cx, cy - 80, ['alt', 'control']);
  check('ALT+CTRL + trascina = zoom', z0 !== (await bl(2)), `${z0} -> ${await bl(2)}`);
  await tap('-');
  check('− = adatta al pannello', /zoom 100%/.test(await bl(2)), await bl(2));
  down('Z', ['shift']);
  await wait(60);
  await dragMod(cx, cy, cx, cy - 80, ['shift']);
  up('Z', ['shift']);
  await wait(120);
  check('MAIUSC+Z + trascina = zoom', !/zoom 100%/.test(await bl(2)), await bl(2));
  await tap('+');
  const dpr = await js('window.devicePixelRatio');
  const one = await bl(2);
  check('+ = zoom 1x', Math.abs(parseFloat(one.split('zoom ')[1]) - 100 / fit / dpr) < 1.5, `${one} · atteso ${Math.round(100 / fit / dpr)}%`);
  await tap('-');

  await dragMod(cx, cy, cx + 90, cy + 40, ['alt', 'shift']);
  check('ALT+MAIUSC + trascina non scorre e non cambia finestra', (await bl(0)) === 'Im 25/40' && (await br()) === w1, `${await bl(0)} · ${await br()}`);

  await tap('R', ['shift']);
  check('MAIUSC+R = ripristina', (await br()) === w0 && /zoom 100%/.test(await bl(2)) && (await tool()) === 'scroll', `${await br()} · ${await bl(2)}`);

  await tap('num3');
  check('tastierino 3 = TC polmone', (await br()) === 'L -600  W 1600', await br());
  await tap('num4');
  check('tastierino 4 = TC osso', (await br()) === 'L 400  W 1800', await br());
  await tap('num0');
  check('tastierino 0 = finestra dell\'immagine', (await br()) === w0, await br());

  await tap('Down');
  check('freccia giù = immagine successiva', (await bl(0)) === 'Im 26/40', await bl(0));
  await tap('PageUp');
  check('PagSu = dieci indietro', (await bl(0)) === 'Im 16/40', await bl(0));
  const tr = () => js(`document.querySelector(".panel.active .ov--tr").textContent.split(${NL})[2]`);
  const s0 = await tr();
  await tap('Right', ['shift']);
  await wait(500);
  const s1 = await tr();
  await tap('Left', ['shift']);
  await wait(500);
  check('MAIUSC + frecce = serie successiva / precedente', s0 !== s1 && (await tr()) === s0, `${s0} -> ${s1} -> ${await tr()}`);

  await slider(24);
  await wait(300);
  const lit = () => js('(()=>{const c=document.querySelector(".panel.active canvas");const d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]>240&&d[i+1]>200&&d[i+2]<110)n++;return n})()');
  const y1 = await lit();
  await tap('A', ['shift']);
  await wait(150);
  const y2 = await lit();
  await tap('A', ['shift']);
  await wait(150);
  const y3 = await lit();
  check('MAIUSC+A = nascondi / mostra le misure', y1 > 50 && y2 === 0 && y3 === y1, `pixel gialli ${y1} -> ${y2} -> ${y3}`);
  await tap('Delete', ['shift']);
  await wait(200);
  check('MAIUSC+CANC = via tutte le misure', (await lit()) === 0);

  await tap('T', ['shift']);
  check('MAIUSC+T = nascondi i dati a schermo', (await js('getComputedStyle(document.querySelector(".panel.active .ov--tl")).display')) === 'none');
  await tap('T', ['shift']);

  s.sendInputEvent({ type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -100, modifiers: ['control'] });
  await wait(500);
  check('CTRL + rotella = due pannelli', (await js('document.getElementById("views").dataset.layout')) === '2');
  check('…e non scorre né ingrandisce', (await bl(0)) === 'Im 25/40' && /zoom 100%/.test(await bl(2)), `${await bl(0)} · ${await bl(2)}`);
  const sync = () => js('document.getElementById("btn-sync").classList.contains("on")');
  await tap('S');
  check('S = scorrimento collegato sì', await sync());
  await tap('C');
  check('C = scollega', !(await sync()));
  await tap('J');
  check('J = collega', await sync());
  await tap('C');

  down('X');
  await wait(60);
  const xx = Math.round(cx / 2 + rect.l / 2);
  mouse('mouseMove', xx, cy); mouse('mouseDown', xx, cy); mouse('mouseUp', xx, cy);
  up('X');
  await wait(300);
  check('X + clic = svuota il pannello', (await js('document.querySelector(".panel.active .ov--tl").textContent')) === '');

  await js('document.querySelectorAll(".serie")[1].click()');
  await wait(500);
  await tap('Space');
  await wait(500);
  const on = await js('document.getElementById("btn-cine").classList.contains("on")');
  await tap('Space');
  check('Spazio = cine', on && !(await js('document.getElementById("btn-cine").classList.contains("on")')));
};
