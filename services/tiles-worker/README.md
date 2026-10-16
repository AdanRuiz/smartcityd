# tiles-worker

Espejo HTTP del mapa base de cada ciudad: un archivo PMTiles (extracto de OpenStreetMap del build diario de Protomaps) servido con peticiones de rango y CORS abierto, para que MapLibre lo lea desde cualquier origen, incluido `file://`. Especificación: [`docs/spec/06`](../../docs/spec/06-distribucion-y-persistencia.md), "Teselas del mapa"; ADR-9.

Es **un espejo**, no una dependencia: el archivo se anuncia en `city.tiles` con su sha256, la app abre también un `.pmtiles` local, y en la fase 4 se publica además por IPFS y torrent (DIST-1).

| Ciudad | Archivo | Tamaño | sha256 |
|---|---|---|---|
| `mx-gdl` | [`mx-gdl/20261015.pmtiles`](https://smartcity-tiles.adan0001.workers.dev/mx-gdl/20261015.pmtiles) | 10 674 114 bytes, zoom 0–15 | `07e25b6c699f49adf668a51b93ebb9d9c4bf1ed5d0ba70c7d0984667e5254939` |

## Generar y desplegar

```sh
# CLI pmtiles: https://github.com/protomaps/go-pmtiles/releases (en el PATH o PMTILES=<ruta>)
pnpm --filter tiles-worker extract mx-gdl 20.55,-103.47,20.78,-103.24 --build 20261015
pnpm --filter tiles-worker deploy
```

`extract` baja solo las teselas del recuadro (unos 11 MB para Guadalajara a zoom 15), las guarda en `public/<ciudad>/<build>.pmtiles` (fuera de git) y regenera `src/files.ts` con tamaño y sha256 de cada archivo. Con el mismo `--build` el resultado es idéntico byte a byte, así que cualquiera puede comprobar el hash publicado. Imprime el objeto `tiles` para la definición `city`.

## Por qué hay un Worker

La capa de archivos estáticos de Workers responde a `Range` con el archivo entero (200) y sin `Content-Length`, y los lectores de PMTiles necesitan `206 Partial Content`. El Worker (`src/index.ts`) pide el archivo a esa capa y deja pasar solo los bytes pedidos, sin cargarlo entero en memoria; los tamaños salen de `src/files.ts`. R2 respondería a los rangos por sí mismo, pero requiere activarse en el panel de la cuenta. Cada archivo es como mucho de 25 MiB, el límite de un archivo estático en Workers: una ciudad mayor necesita bajar `--maxzoom` o R2.

Sin capas de etiquetas: necesitan archivos de glifos de un servidor y APP-3 prohíbe recursos de terceros en tiempo de ejecución.

Atribución: © colaboradores de OpenStreetMap (ODbL); la app la muestra en el mapa.
