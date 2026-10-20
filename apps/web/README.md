# web

App web SmartCity: mapa de una capa de datos en vivo, reportes ciudadanos, confianza, panel de relays e identidad. SPA React estática sin backend propio; habla solo con relays mediante [`@smartcity/sdk`](../../packages/sdk). Especificación: [`docs/spec/06`](../../docs/spec/06-distribucion-y-persistencia.md) (distribución) y [`08`](../../docs/spec/08-seguridad-y-privacidad.md) (seguridad).

Estado (fase 3): mapa con MapLibre y PMTiles, capa de un dataset de observaciones con suscripción en vivo por el área visible y filtro por nivel de confianza, reportes ciudadanos (alta sin conexión, historial, estado oficial), página de confianza (anclas, definiciones de la ciudad, llaves con rol), panel de relays con estado y lista semilla editable, firmante NIP-07 o llave local cifrada con exportación, almacén local y cola de salida en IndexedDB, Service Worker por HTTP(S); fase 4: página «Historial» (`#/historial`) con la serie de un campo (promedio y banda mínimo–máximo por hora hasta 3 días, por día hasta 92) más allá de la retención de los relays, leída con `sc.observations.history` desde los relays y los snapshots verificados (SNAP-6), prefiriendo los de llaves con rol `archiver`, con filtro por fuente y por nivel de confianza, tabla con los mismos datos y lista de archivos o líneas descartadas. Abre desde `file://`, desde cualquier subruta y desde un servidor estático. Espejo en Cloudflare Pages: <https://smartcity-web.pages.dev/> (`npx wrangler pages deploy apps/web/dist --project-name smartcity-web --branch main`); es una copia más, no una dependencia. Netlify y Vercel construyen el mismo commit con la misma orden (`netlify.toml` y `vercel.json` en la raíz: `pnpm --filter web... build` desde el lockfile, publican `apps/web/dist`, sin funciones ni redirecciones); falta conectar el repositorio en cada proveedor.

Pendiente según `09-roadmap.md`: fotos en reportes (PRIV-4, SEC-4), agregados según nivel (TRUST-6), código QR de las huellas (TRUST-8), detección de atípicos (SPAM-3, Could); sembrar el torrent de `smartcity.html` y fijar `dist/` en IPFS (`archiver app` ya calcula `dist.cid` y `dist.magnet` para el `release`, ver [`services/archiver`](../../services/archiver/README.md)) y aviso de versión nueva (APP-8, fase 4). El evento `release` que anuncia una versión por el sha256 de `smartcity.html` se redacta con `node packages/sdk/scripts/city.mjs draft-release` y lo firma el desarrollador (ver [`packages/sdk`](../../packages/sdk/README.md)).

## Desarrollo

```sh
pnpm --filter web dev        # servidor de desarrollo de Vite
pnpm --filter web build      # dist/: index.html + un JS clásico + un CSS, y dist/smartcity.html (archivo único)
pnpm --filter web test       # pruebas del armado de smartcity.html
pnpm --filter web check      # abre dist/index.html por file:// en Chrome sin interfaz y reporta errores
pnpm --filter web check file:///<ruta>/dist/smartcity.html
pnpm --filter web check http://localhost:4173/ --wait 15 --shot captura.png
```

`check` usa Chrome o Edge instalados (variable `CHROME` si están en otro sitio) y sale con error si la consola registra excepciones, errores o violaciones de CSP.

Para ver datos en el mapa sin sensor real: `node packages/sdk/scripts/sensor.mjs <dirección del dataset>` publica una lectura cada 10 s.

## Cómo cumple los requisitos

| Requisito | Cómo |
|---|---|
| APP-1 | Build estático; sin funciones serverless ni variables de entorno en tiempo de ejecución. |
| APP-2 | `base: './'` y `HashRouter`. Chrome no carga scripts *module* desde `file://`, así que el build emite **un solo script clásico** con `defer` (formato IIFE, sin división de código) y un CSS aparte. Los workers arrancan desde código en memoria (`blob:`); bajo `file://` el de MapLibre se fuerza a worker clásico, porque Chrome rechaza workers *module* desde `blob:` en ese origen. Comprobado con `check` en `file://` y en HTTP. |
| APP-3 | Todo va en el paquete. El mapa base no usa capas de etiquetas porque requieren archivos de glifos de un servidor. |
| APP-4 | El build emite las dos variantes: `dist/` (multiarchivo, con Service Worker) y `dist/smartcity.html`, la misma app en un solo archivo (~2,2 MB) para abrir con doble clic tras bajarlo por torrent, USB o correo. `build/single-file.ts` mete el script y el CSS dentro del HTML (el script al final de `<body>`, porque uno en línea no se puede diferir) y los permite en la CSP por su sha256, sin `unsafe-inline`; sin `'self'` en `worker-src`. Una `<meta name="smartcity-variant" content="single-file">` le dice a la app que no registre el Service Worker aunque un espejo sirva el archivo. Comprobado con `check` desde `file://`: relays conectados y sin violaciones de CSP. |
| APP-5, REPL-5, TRUST-1 | `src/config.ts`: relays semilla y ciudades con sus llaves raíz. El usuario edita los relays en el panel; se guardan en `localStorage` del origen (APP-11). |
| APP-7 | El build genera `sw.js` con la lista de sus archivos: guarda la interfaz para abrir sin red cuando se sirve por HTTP(S) (comprobado recargando sin red tras la primera visita). Desde `file://` o sin él la app funciona igual. Los datos no pasan por él: viven en IndexedDB. |
| APP-9 | No descarga ni ejecuta código. |
| APP-10 | Página «Acerca de» (`#/acerca`): versión de `package.json` y commit, fijados en el build (`build/build-info.ts`, en este orden: `SMARTCITY_COMMIT`; `git rev-parse HEAD` si la copia es este repositorio, avisando si hay cambios sin commitear; `build/commit.txt`, que rellena `git archive` y por tanto las descargas de código de GitHub (`export-subst` en `.gitattributes`); la variable del espejo). El commit forma parte de los bytes: quien compila el mismo commit obtiene el mismo hash si el build lo conoce (APP-6); sin `.git` ni archivo, `SMARTCITY_COMMIT=<hash>`. Variante y hash del build: el sha256 de `smartcity.html`, el mismo que anuncia el `release` (DIST-2). Por HTTP(S) la página lo descarga solo al pulsar «Calcular» (unos 2 MB), lo hashea con Web Crypto y «Guardar copia de esta app» descarga esos mismos bytes. `index.html` y `smartcity.html` llevan el id del build (`<meta name="smartcity-build">`, de los nombres de sus assets): si el archivo descargado es de otro despliegue, la página lo dice y no ofrece guardarlo. La página avisa de que no puede garantizarse a sí misma: la comprobación que vale es `sha256sum` del archivo guardado contra el `release` (APP-9). Desde `file://` el navegador no deja leerlo: sugiere `sha256sum`, y en `dist/` recuerda que para compartir en un archivo está `smartcity.html`. Comprobado a mano con `check` y `--eval` (pulsa «Calcular» y lee la página): por HTTP el hash coincide con `sha256sum dist/smartcity.html`; con el id cambiado en el archivo servido aparece el aviso de otra versión; por `file://`, el mensaje de archivo. Dos builds seguidos del mismo commit dan el mismo `smartcity.html`. |
| GOAL-3 | Espejos HTTP sin pasos propios: `netlify.toml` y `vercel.json` fijan orden de build, carpeta publicada y cabeceras (`sw.js` siempre se revalida, `assets/` es inmutable, `Referrer-Policy: no-referrer`). La CSP sigue en `<meta>` para que sea la misma en `file://`. `test/mirrors.test.ts` comprueba que los dos coinciden y que no añaden nada dinámico (APP-1). |
| NFR-1 | Suscripción en vivo por el área visible. Medido: sensor simulado publicando en el relay de referencia y la app abierta por `file://` en otro proceso; la lectura aparece en el mismo segundo en que se publica. Con los dos relays de referencia, el SDK mide p95 de 225 ms entre publicar y recibir. |
| SEC-1 | El texto de eventos se pinta siempre como texto de React; no hay `dangerouslySetInnerHTML` ni enlaces generados desde eventos. |
| SEC-2 | CSP en `<meta>`, añadida en el build: `default-src 'self'`, `script-src 'self'` sin `unsafe-eval` ni `unsafe-inline`, `connect-src` abierto a `wss:` y `https:`, `worker-src 'self' blob:`. En desarrollo no se aplica porque Vite inyecta un preámbulo en línea. |
| PRIV-7 | Sin analítica ni telemetría. `referrer` desactivado. |
| APP-12 a APP-15 | `src/geo/`: `places.ts` consulta los servicios de `GEO` en `config.ts` (IP, búsqueda y nombre de la posición), `store.ts` guarda el lugar actual (la elección manual manda y se recuerda) y `CityPicker.tsx` es el nombre de la ciudad con el botón de editar y las sugerencias. `useMap.ts` lleva el mapa a cada lugar nuevo. Sin esos servicios la app sigue con la ciudad configurada (ADR-22). |
| APP-16 | `useMap.ts` (`basemap`): dentro de la ciudad, su PMTiles; fuera o sin teselas, el estilo mundial de `GEO.worldStyle` / `worldStyleDark` (OpenFreeMap); sin él, fondo liso (ADR-23). |
| ID-1, ID-2, ID-6, SEC-3 | Extensión NIP-07 o llave creada en el dispositivo; la llave local solo se guarda cifrada con NIP-49 (`ncryptsec`) y solo se exporta así. |
| ID-3 | Sin llave la app es de solo lectura. |
| SDK-5, SDK-8 | Las firmas se verifican y la prueba de trabajo se mina en Web Workers; mientras mina, el reporte se puede cancelar. |
| SDK-4, GOAL-7, NFR-3 | Almacén local y cola en IndexedDB del origen. Sin conexión, un reporte o comentario queda guardado («N por enviar» en la cabecera) y sale al volver la red (evento `online`, reconexión de un relay o cada 30 s). Lo ya visto se sigue mostrando sin relays. |
| SDK-11, ID-7 | Al crear una llave local la app pide almacenamiento persistente y, si el navegador lo niega, pide exportar la llave en ese momento. |
| `03`, PRIV-3, PRIV-5, PRIV-6 | Reportes: llave nueva por reporte por defecto (o la identidad propia si se elige), ubicación redondeada a ~11 m con aviso, y el aviso de que lo publicado es público se muestra una vez antes de la primera publicación. El estado que se muestra es el oficial (autoridad u operador); el resto de actualizaciones son comentarios. |
| TRUST-2, TRUST-3, TRUST-8 (parcial) | Página Confianza: anclas en uso (las raíces del build o las elegidas, guardadas por origen), alta y baja de anclas por `npub`, definiciones `city` de los relays con quién las firma y sus raíces para elegir una (la app nunca elige sola), huellas completas en `npub`. Falta el QR. |
| TRUST-4, TRUST-5, TRUST-7 | Cada capa (lecturas y reportes) filtra por nivel: `verified` (con distintivo azul) y `community` visibles, `flagged` oculto hasta marcarlo. El nivel se recalcula al cambiar anclas o listas. |

### Mapa base

El estilo usa el archivo PMTiles de la ciudad (`tiles.urls` de su definición `city`, primera URL `https:`). Si no hay, el mapa se muestra sobre fondo liso y ofrece abrir un `.pmtiles` local, que funciona sin red (por ejemplo, el descargado por torrent). La ciudad piloto aún no publica su archivo de teselas.

### Tamaño (NFR-2, Should)

Primera carga: **~583 KB de JS con gzip** (fase 3; 560 KB en la fase 2) más 12 KB de CSS, por encima del objetivo de 500 KB. Casi todo es MapLibre: 285 KB el hilo principal y 143 KB su worker, que va como texto dentro del mismo script para poder arrancar desde `file://`. Opciones si se quiere bajar: cargar el worker de MapLibre como archivo aparte cuando la app no está en `file://`, o servir `dist/` con Brotli.
