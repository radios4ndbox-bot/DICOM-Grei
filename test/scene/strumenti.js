'use strict';

// Strumenti: ripremere la scorciatoia (o ricliccare il pulsante) dello strumento
// attivo riporta allo scorrimento, che ha il cursore a manina.
module.exports = async ({ w, wait, js, check, key }) => {
  const s = w.webContents;
  const tool = () => js('document.querySelector(".tools button.on[data-tool]").dataset.tool');
  const cursor = () => js('getComputedStyle(document.querySelector(".panel.active canvas")).cursor');
  const tap = async (k) => { key(k); await wait(120); };

  check('all\'apertura: scorrimento, cursore a manina', (await tool()) === 'scroll' && (await cursor()) === 'grab', `${await tool()} · ${await cursor()}`);
  for (const [k, t] of [['R', 'dist'], ['G', 'angle'], ['E', 'roi'], ['W', 'wl'], ['D', 'probe']]) {
    await tap(k);
    const on = await tool();
    await tap(k);
    const off = await tool();
    check(`${k} accende ${t}, ${k} di nuovo torna allo scorrimento`, on === t && off === 'scroll', `${on} -> ${off} · cursore ${await cursor()}`);
  }
  await tap('R');
  await tap('G');
  check('da uno strumento all\'altro senza passare dallo scorrimento', (await tool()) === 'angle');
  await tap('G');
  for (const t of ['dist', 'zoom', 'pan']) {
    await js(`document.querySelector('[data-tool=${t}]').click()`);
    const on = await tool();
    await js(`document.querySelector('[data-tool=${t}]').click()`);
    const off = await tool();
    check(`pulsante ${t} cliccato due volte: torna allo scorrimento`, on === t && off === 'scroll', `${on} -> ${off}`);
  }
  await js('document.querySelector("[data-tool=pan]").click()');
  check('Sposta ha il cursore a frecce, diverso dalla manina', (await cursor()) === 'move', await cursor());
  await js('document.querySelector("[data-tool=pan]").click()');

  const r = await js('(()=>{const r=document.querySelector(".panel.active canvas").getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})()');
  s.sendInputEvent({ type: 'mouseMove', x: r[0], y: r[1] });
  s.sendInputEvent({ type: 'mouseDown', x: r[0], y: r[1], button: 'left', clickCount: 1 });
  await wait(100);
  const during = await cursor();
  s.sendInputEvent({ type: 'mouseUp', x: r[0], y: r[1], button: 'left', clickCount: 1 });
  await wait(100);
  check('trascinando la manina si chiude, al rilascio si riapre', during === 'grabbing' && (await cursor()) === 'grab', `${during} -> ${await cursor()}`);
};
