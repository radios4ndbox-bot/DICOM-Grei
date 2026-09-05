# build resources

## Icona

- `icon.svg` — sorgente (globo).
- `icon.ico` — generato da `icon.svg` (16→256 px), usato da electron-builder
  (`win.icon`) per exe/installer e da `main.js` per la finestra.

Per rigenerarlo dopo aver modificato l'SVG:

```bash
npm i -D sharp png-to-ico
node -e "const s=require('sharp'),p=require('png-to-ico').default,f=require('fs');(async()=>{const b=[];for(const n of [16,24,32,48,64,128,256])b.push(await s(f.readFileSync('build/icon.svg'),{density:384}).resize(n,n).png().toBuffer());f.writeFileSync('build/icon.ico',await p(b))})()"
npm un sharp png-to-ico
```

## dcmtk (opzionale — app autosufficiente)

Per non dipendere da `%USERPROFILE%\Desktop\dcmtk`, crea:

```
resources/dcmtk/bin/storescu.exe   (+ le DLL richieste da dcmtk)
```

`config.js` cerca prima `resources/dcmtk/bin/storescu.exe` (in
`process.resourcesPath`), poi il Desktop. Scommenta il blocco
`extraResources` in `electron-builder.yml` quando la cartella esiste.
