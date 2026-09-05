# build resources

Metti qui l'icona dell'applicazione:

- **`icon.ico`** — formato BMP (non PNG-compressed), dimensione minima **256×256**.

Poi in `../electron-builder.yml` scommenta:

```yaml
win:
  icon: build/icon.ico
```

Sorgente disponibile: `DICOM.svg` sul Desktop dell'utente — va convertito in `.ico`
multi-risoluzione (16/32/48/256) con formato BMP.
