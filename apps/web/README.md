# web

App web SmartCity: mapa de una capa de datos en vivo, panel de relays e identidad. SPA React estática sin backend propio; habla solo con relays mediante [`@smartcity/sdk`](../../packages/sdk). Especificación: [`docs/spec/06`](../../docs/spec/06-distribucion-y-persistencia.md) (distribución) y [`08`](../../docs/spec/08-seguridad-y-privacidad.md) (seguridad).

Estado (fase 2): mapa con MapLibre y PMTiles, capa de un dataset de observaciones con suscripción en vivo por el área visible, panel de relays con estado y lista semilla editable, firmante NIP-07 o llave local cifrada con exportación. Abre desde `file://`, desde cualquier subruta y desde un servidor estático.

Pendiente según `09-roadmap.md`: almacén local, cola de salida, Service Worker, reportes y filtros por confianza (fase 3); `smartcity.html` en un solo archivo, `release` y "Acerca de" (fase 4).

## Desarrollo

```sh
pnpm --filter web dev        # servidor de desarrollo de Vite
pnpm --filter web build      # dist/: index.html + un JS clásico + un CSS
pnpm --filter web check      # abre dist/index.html por file:// en Chrome sin interfaz y reporta errores
pnpm --filter web check http://localhost:4173/ --wait 15 --shot captura.png
```

`check` usa Chrome o Edge instalados (variable `CHROME` si están en otro sitio) y sale con error si la consola registra excepciones, errores o violaciones de CSP.

Para ver datos en el mapa sin sensor real: `node packages/sdk/scripts/sensor.mjs <dirección del dataset>` publica una lectura cada 10 s.

## Cómo cumple los requisitos de la fase 2

| Requisito | Cómo |
|---|---|
| APP-1 | Build estático; sin funciones serverless ni variables de entorno en tiempo de ejecución. |
| APP-2 | `base: './'` y `HashRouter`. Chrome no carga scripts *module* desde `file://`, así que el build emite **un solo script clásico** con `defer` (formato IIFE, sin división de código) y un CSS aparte. Los workers arrancan desde código en memoria (`blob:`); bajo `file://` el de MapLibre se fuerza a worker clásico, porque Chrome rechaza workers *module* desde `blob:` en ese origen. Comprobado con `check` en `file://` y en HTTP. |
| APP-3 | Todo va en el paquete. El mapa base no usa capas de etiquetas porque requieren archivos de glifos de un servidor. |
| APP-5, REPL-5, TRUST-1 | `src/config.ts`: relays semilla y ciudades con sus llaves raíz. El usuario edita los relays en el panel; se guardan en `localStorage` del origen (APP-11). |
| APP-7 | No hay Service Worker todavía; la app no depende de él. |
| APP-9 | No descarga ni ejecuta código. |
| NFR-1 | Suscripción en vivo por el área visible. Medido: sensor simulado publicando en el relay de referencia y la app abierta por `file://` en otro proceso; la lectura aparece en el mismo segundo en que se publica. |
| SEC-1 | El texto de eventos se pinta siempre como texto de React; no hay `dangerouslySetInnerHTML` ni enlaces generados desde eventos. |
| SEC-2 | CSP en `<meta>`, añadida en el build: `default-src 'self'`, `script-src 'self'` sin `unsafe-eval` ni `unsafe-inline`, `connect-src` abierto a `wss:` y `https:`, `worker-src blob:`. En desarrollo no se aplica porque Vite inyecta un preámbulo en línea. |
| PRIV-7 | Sin analítica ni telemetría. `referrer` desactivado. |
| ID-1, ID-2, ID-6, SEC-3 | Extensión NIP-07 o llave creada en el dispositivo; la llave local solo se guarda cifrada con NIP-49 (`ncryptsec`) y solo se exporta así. |
| ID-3 | Sin llave la app es de solo lectura. |
| SDK-5 | Las firmas se verifican en un Web Worker. |

### Mapa base

El estilo usa el archivo PMTiles de la ciudad (`tiles.urls` de su definición `city`, primera URL `https:`). Si no hay, el mapa se muestra sobre fondo liso y ofrece abrir un `.pmtiles` local, que funciona sin red (por ejemplo, el descargado por torrent). La ciudad piloto aún no publica su archivo de teselas.

### Tamaño (NFR-2, Should)

Primera carga: **~560 KB de JS con gzip** (570 KB con el nivel por defecto de Vite) más 12 KB de CSS, por encima del objetivo de 500 KB. Casi todo es MapLibre: 285 KB el hilo principal y 143 KB su worker, que va como texto dentro del mismo script para poder arrancar desde `file://`. Opciones si se quiere bajar: cargar el worker de MapLibre como archivo aparte cuando la app no está en `file://`, o servir `dist/` con Brotli.
