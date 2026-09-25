# Font inclusi

## GreatVibes-Regular.ttf

Sorgente di "Grei" nel nome dell'app. L'app non carica il font: in
`index.html` (`#brand-grei`) ci sono i contorni delle quattro lettere già
trasformati in tracciati SVG, perché l'intro li disegna a penna e un testo
non si può disegnare così. Il file resta qui per rigenerarli.

- Copyright (c) 2012 TypeSETit, LLC (typesetit@att.net), with Reserved Font Name "Great Vibes".
- Licenza: SIL Open Font License, Version 1.1 — https://openfontlicense.org
  (testo completo anche su https://scripts.sil.org/OFL).

La OFL consente di includere e ridistribuire il font con l'app, anche in un
pacchetto commerciale; il font non può essere venduto da solo e le versioni
modificate non possono usare il nome riservato "Great Vibes".

### Rigenerare i tracciati

Con Python e `fontTools` (`pip install fonttools`), dalla radice del progetto:

```python
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

f = TTFont('src/renderer/assets/fonts/GreatVibes-Regular.ttf')
gs, cmap, hmtx = f.getGlyphSet(), f.getBestCmap(), f['hmtx']
x = 0
for ch in 'Grei':
    g = cmap[ord(ch)]
    pen = SVGPathPen(gs)
    gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))  # y verso il basso, lettera dopo lettera
    print(ch, pen.getCommands())
    x += hmtx[g][0]
```

Un `<path pathLength="1" d="…">` per lettera, nell'ordine: l'intro le
disegna da sinistra a destra. viewBox attuale: `-68 -838 1539 1232`.
