# 06 · Distribución y persistencia

Cómo logran la app y los datos seguir vivos sin su hosting original. La misma técnica sirve para ambos: **contenido direccionado por hash, anunciado con un evento firmado y sembrado por voluntarios**.

## Advertencia honesta

Ni torrent ni IPFS guardan nada "para siempre" por sí solos:

- un torrent vive mientras **al menos un seeder** esté en línea;
- un CID de IPFS vive mientras **al menos un nodo lo tenga fijado** (*pinned*); los gateways públicos no conservan contenido.

Lo que sí garantizan es que **cualquiera con una copia puede volver a ponerla en línea** y todos verificarán que es idéntica. La meta de diseño es entonces: muchas copias independientes, fáciles de hacer.

| ID | Regla |
|---|---|
| DIST-1 | Todo artefacto (build de la app, snapshot, teselas) se publica en al menos dos redes: IPFS y BitTorrent. |
| DIST-2 | Todo artefacto se anuncia con un evento firmado que incluye su sha256. El hash del evento, no la URL, es la referencia. |
| DIST-3 | Los enlaces magnet incluyen los espejos HTTP como *web seeds* (`ws=`), de modo que el torrent tiene fuente mientras viva algún espejo, y varios trackers más DHT. |
| DIST-4 | Meta operativa por ciudad: ≥3 seeders independientes del archivo y de la app. |

## Distribución de la app

### Requisitos del build

| ID | Regla |
|---|---|
| APP-1 | Build 100 % estático. Sin funciones serverless, sin variables de entorno en tiempo de ejecución. |
| APP-2 | Rutas relativas (`base: './'` en Vite) y `HashRouter`: debe funcionar bajo cualquier subruta (`/ipfs/<cid>/`) y desde `file://`. |
| APP-3 | Sin recursos de terceros en tiempo de ejecución (CDNs, fuentes, analítica). Todo va en el paquete. |
| APP-4 | Se generan dos variantes: `dist/` (multiarchivo, con Service Worker) y `smartcity.html` (un solo archivo autocontenido, sin Service Worker). |
| APP-5 | La configuración inicial (relays semilla, ciudades y raíces, llaves del desarrollador) va embebida en el build y el usuario puede cambiarla en ajustes. |
| APP-6 | El build DEBERÍA ser reproducible (lockfile fijado, `SOURCE_DATE_EPOCH`) para que un tercero compile el mismo commit y obtenga el mismo hash. |
| APP-7 | Sin Service Worker (IPFS por subruta, `file://`) la app funciona igual, perdiendo solo la carga offline del shell. |

### Canales

| Canal | Cómo llega el usuario | Depende de |
|---|---|---|
| Espejos HTTP | URL normal (Cloudflare Pages, Vercel, Netlify, GitHub Pages) | Cada proveedor por separado |
| IPFS | `https://<gateway>/ipfs/<cid>/` o nodo local / Brave | Que alguien fije el CID |
| Torrent | Cliente de torrent → abrir `smartcity.html` | Seeders o web seeds |
| Copia directa | USB, correo, repositorio | Nada |

El archivo único (`smartcity.html`) es lo que hace útil al torrent: un navegador no abre magnets, pero cualquiera puede descargar un archivo y abrirlo con doble clic.

Notas de capa gratuita: los espejos despliegan el mismo commit desde el repositorio. Revisar los términos de cada plan (por ejemplo, restricciones de uso comercial) antes de depender de uno.

### Evento `release` (kind 31486)

Tags: `["d", "<app slug>:<canal>"]` (canal: `stable`, `beta`), `["x", "<sha256 de smartcity.html>"]`.

```json
{
  "v": 1,
  "version": "1.4.0",
  "commit": "<hash git>",
  "single": { "x": "<sha256>", "size": 1832044, "urls": ["https://…/smartcity.html"] },
  "dist": { "cid": "bafy…", "magnet": "magnet:?xt=urn:btih:…&ws=https://…" },
  "mirrors": ["https://smartcity.pages.dev", "https://smartcity.vercel.app"],
  "notes": "Cambios de esta versión"
}
```

Como es direccionable, solo existe la versión vigente por canal; el historial de versiones queda en los snapshots.

### Actualización

| ID | Regla |
|---|---|
| APP-8 | La app consulta el `release` firmado por las llaves de desarrollador embebidas. Si hay versión mayor, avisa y ofrece los canales. |
| APP-9 | La app nunca descarga y ejecuta código por sí sola. En espejos HTTP la actualización llega por el despliegue normal; en copia local el usuario descarga el archivo nuevo y la app le muestra el hash esperado. |
| APP-10 | La pantalla "Acerca de" muestra versión, commit, hash del build y un botón "Guardar copia de esta app" que descarga `smartcity.html`. |
| APP-11 | Los datos locales (IndexedDB) pertenecen al origen: cambian entre espejos y entre `file://` y `https://`. La app ofrece exportar e importar llave y ajustes. |

Un fork solo necesita cambiar las llaves de desarrollador embebidas: los datos son los mismos porque viven en los relays, no en la app.

## Persistencia de los datos: snapshots

### Formato

- **Archivo diario** por ciudad: `sc_<city>_<YYYY-MM-DD>.ndjson.gz`.
- Contiene todo evento válido de la ciudad (tag `c` igual a la ciudad o a `*`, o `d` en el caso de `city`) con `created_at` dentro de ese día UTC, de kinds regulares y direccionables. Los efímeros no se archivan, ni los eventos con tag `expiration` (SNAP-16).
- Un evento por línea, JSON sin espacios, claves en el orden `id, pubkey, created_at, kind, tags, content, sig`.
- Orden de líneas: `created_at` ascendente, luego `id` ascendente.
- **Hash canónico `x`**: sha256 del NDJSON **sin comprimir**. Es independiente del compresor.

| ID | Regla |
|---|---|
| SNAP-1 | El snapshot de un día se genera tras un periodo de gracia de 48 h, para captar eventos tardíos de clientes offline. |
| SNAP-2 | Los eventos que aparezcan después van en un archivo de adenda `sc_<city>_<fecha>_a<N>.ndjson.gz`. Los archivos publicados nunca se reescriben. |
| SNAP-3 | El archivista omite eventos con solicitud de borrado (kind 5) válida conocida al momento de generar, y PUEDE aplicar una política de exclusión (por ejemplo, llaves `blocked`) que DEBE declarar en `policy`. |
| SNAP-4 | Cada mes se publica un consolidado (`monthly`) que agrupa diarios y adendas en un solo torrent; los diarios pueden dejar de sembrarse entonces. |
| SNAP-5 | El archivista une eventos de todos los relays que conozca de la ciudad, no de uno solo. |
| SNAP-8 | Para hallar eventos tardíos el archivista no vuelve a recorrer días ya archivados: guarda por relay el cursor de `GET /v1/export?received_after=` (`07`) y en cada ejecución trae solo lo recibido desde entonces. Lo que caiga en un día ya publicado va a una adenda. En relays sin esa ruta, consulta por `since` una ventana igual al máximo de antigüedad que el relay declare. |
| SNAP-9 | Con el límite de antigüedad por defecto (30 días, RELAY-5), un día deja de recibir adendas a los 30 días; el consolidado mensual se genera después de ese plazo. |
| SNAP-16 | El archivista NO DEBE archivar un evento con tag `expiration` (NIP-40) válido, sea cual sea su fecha: el autor lo marcó como temporal y un snapshot es permanente. La exclusión no depende del momento de generar, así que dos archivistas obtienen el mismo `x`. Solo cuenta el **primer** tag `expiration`, y solo si su valor está escrito como entero decimal positivo (`^[1-9][0-9]*# 06 · Distribución y persistencia

Cómo logran la app y los datos seguir vivos sin su hosting original. La misma técnica sirve para ambos: **contenido direccionado por hash, anunciado con un evento firmado y sembrado por voluntarios**.

## Advertencia honesta

Ni torrent ni IPFS guardan nada "para siempre" por sí solos:

- un torrent vive mientras **al menos un seeder** esté en línea;
- un CID de IPFS vive mientras **al menos un nodo lo tenga fijado** (*pinned*); los gateways públicos no conservan contenido.

Lo que sí garantizan es que **cualquiera con una copia puede volver a ponerla en línea** y todos verificarán que es idéntica. La meta de diseño es entonces: muchas copias independientes, fáciles de hacer.

| ID | Regla |
|---|---|
| DIST-1 | Todo artefacto (build de la app, snapshot, teselas) se publica en al menos dos redes: IPFS y BitTorrent. |
| DIST-2 | Todo artefacto se anuncia con un evento firmado que incluye su sha256. El hash del evento, no la URL, es la referencia. |
| DIST-3 | Los enlaces magnet incluyen los espejos HTTP como *web seeds* (`ws=`), de modo que el torrent tiene fuente mientras viva algún espejo, y varios trackers más DHT. |
| DIST-4 | Meta operativa por ciudad: ≥3 seeders independientes del archivo y de la app. |

## Distribución de la app

### Requisitos del build

| ID | Regla |
|---|---|
| APP-1 | Build 100 % estático. Sin funciones serverless, sin variables de entorno en tiempo de ejecución. |
| APP-2 | Rutas relativas (`base: './'` en Vite) y `HashRouter`: debe funcionar bajo cualquier subruta (`/ipfs/<cid>/`) y desde `file://`. |
| APP-3 | Sin recursos de terceros en tiempo de ejecución (CDNs, fuentes, analítica). Todo va en el paquete. |
| APP-4 | Se generan dos variantes: `dist/` (multiarchivo, con Service Worker) y `smartcity.html` (un solo archivo autocontenido, sin Service Worker). |
| APP-5 | La configuración inicial (relays semilla, ciudades y raíces, llaves del desarrollador) va embebida en el build y el usuario puede cambiarla en ajustes. |
| APP-6 | El build DEBERÍA ser reproducible (lockfile fijado, `SOURCE_DATE_EPOCH`) para que un tercero compile el mismo commit y obtenga el mismo hash. |
| APP-7 | Sin Service Worker (IPFS por subruta, `file://`) la app funciona igual, perdiendo solo la carga offline del shell. |

### Canales

| Canal | Cómo llega el usuario | Depende de |
|---|---|---|
| Espejos HTTP | URL normal (Cloudflare Pages, Vercel, Netlify, GitHub Pages) | Cada proveedor por separado |
| IPFS | `https://<gateway>/ipfs/<cid>/` o nodo local / Brave | Que alguien fije el CID |
| Torrent | Cliente de torrent → abrir `smartcity.html` | Seeders o web seeds |
| Copia directa | USB, correo, repositorio | Nada |

El archivo único (`smartcity.html`) es lo que hace útil al torrent: un navegador no abre magnets, pero cualquiera puede descargar un archivo y abrirlo con doble clic.

Notas de capa gratuita: los espejos despliegan el mismo commit desde el repositorio. Revisar los términos de cada plan (por ejemplo, restricciones de uso comercial) antes de depender de uno.

### Evento `release` (kind 31486)

Tags: `["d", "<app slug>:<canal>"]` (canal: `stable`, `beta`), `["x", "<sha256 de smartcity.html>"]`.

```json
{
  "v": 1,
  "version": "1.4.0",
  "commit": "<hash git>",
  "single": { "x": "<sha256>", "size": 1832044, "urls": ["https://…/smartcity.html"] },
  "dist": { "cid": "bafy…", "magnet": "magnet:?xt=urn:btih:…&ws=https://…" },
  "mirrors": ["https://smartcity.pages.dev", "https://smartcity.vercel.app"],
  "notes": "Cambios de esta versión"
}
```

Como es direccionable, solo existe la versión vigente por canal; el historial de versiones queda en los snapshots.

### Actualización

| ID | Regla |
|---|---|
| APP-8 | La app consulta el `release` firmado por las llaves de desarrollador embebidas. Si hay versión mayor, avisa y ofrece los canales. |
| APP-9 | La app nunca descarga y ejecuta código por sí sola. En espejos HTTP la actualización llega por el despliegue normal; en copia local el usuario descarga el archivo nuevo y la app le muestra el hash esperado. |
| APP-10 | La pantalla "Acerca de" muestra versión, commit, hash del build y un botón "Guardar copia de esta app" que descarga `smartcity.html`. |
| APP-11 | Los datos locales (IndexedDB) pertenecen al origen: cambian entre espejos y entre `file://` y `https://`. La app ofrece exportar e importar llave y ajustes. |

Un fork solo necesita cambiar las llaves de desarrollador embebidas: los datos son los mismos porque viven en los relays, no en la app.

## Persistencia de los datos: snapshots

### Formato

- **Archivo diario** por ciudad: `sc_<city>_<YYYY-MM-DD>.ndjson.gz`.
- Contiene todo evento válido de la ciudad (tag `c` igual a la ciudad o a `*`, o `d` en el caso de `city`) con `created_at` dentro de ese día UTC, de kinds regulares y direccionables. Los efímeros no se archivan, ni los eventos con tag `expiration` (SNAP-16).
- Un evento por línea, JSON sin espacios, claves en el orden `id, pubkey, created_at, kind, tags, content, sig`.
- Orden de líneas: `created_at` ascendente, luego `id` ascendente.
- **Hash canónico `x`**: sha256 del NDJSON **sin comprimir**. Es independiente del compresor.

| ID | Regla |
|---|---|
| SNAP-1 | El snapshot de un día se genera tras un periodo de gracia de 48 h, para captar eventos tardíos de clientes offline. |
| SNAP-2 | Los eventos que aparezcan después van en un archivo de adenda `sc_<city>_<fecha>_a<N>.ndjson.gz`. Los archivos publicados nunca se reescriben. |
| SNAP-3 | El archivista omite eventos con solicitud de borrado (kind 5) válida conocida al momento de generar, y PUEDE aplicar una política de exclusión (por ejemplo, llaves `blocked`) que DEBE declarar en `policy`. |
| SNAP-4 | Cada mes se publica un consolidado (`monthly`) que agrupa diarios y adendas en un solo torrent; los diarios pueden dejar de sembrarse entonces. |
| SNAP-5 | El archivista une eventos de todos los relays que conozca de la ciudad, no de uno solo. |
| SNAP-8 | Para hallar eventos tardíos el archivista no vuelve a recorrer días ya archivados: guarda por relay el cursor de `GET /v1/export?received_after=` (`07`) y en cada ejecución trae solo lo recibido desde entonces. Lo que caiga en un día ya publicado va a una adenda. En relays sin esa ruta, consulta por `since` una ventana igual al máximo de antigüedad que el relay declare. |
| SNAP-9 | Con el límite de antigüedad por defecto (30 días, RELAY-5), un día deja de recibir adendas a los 30 días; el consolidado mensual se genera después de ese plazo. |
| SNAP-16 | El archivista NO DEBE archivar un evento con tag `expiration` (NIP-40) válido, sea cual sea su fecha: el autor lo marcó como temporal y un snapshot es permanente. , sin signo, exponente, espacios ni ceros a la izquierda) y no pasa de 2^53−1; cualquier otro valor no es caducidad y el evento se archiva. Un borrado (kind 5) nunca caduca: se archiva aunque lleve `expiration`, para que siga aplicándose tras restaurar un relay desde snapshots (DATA-8). |

### Evento `snapshot` (kind 1482)

Tags: `["c", city]`, `["t", "daily" | "addendum" | "monthly" | "attachments"]`, `["x", "<hash canónico>"]`.

```json
{
  "v": 1,
  "from": 1759968000, "to": 1760054400,
  "count": 48211,
  "format": "ndjson+gzip",
  "x": "<sha256 sin comprimir>",
  "file": { "name": "sc_mx-gdl_2026-10-09.ndjson.gz", "x": "<sha256 del .gz>", "size": 9320114 },
  "cid": "bafy…",
  "magnet": "magnet:?xt=urn:btih:…&ws=https://…",
  "urls": ["https://…"],
  "relays": ["wss://…"],
  "policy": "none"
}
```

### Sello de tiempo

1. El archivista sella el `id` del evento `snapshot` con OpenTimestamps (gratis; los servidores de calendario agregan miles de hashes en una transacción de Bitcoin).
2. Publica la prueba como evento kind 1040 (NIP-03): tag `e` con el id del snapshot, `content` = archivo `.ots` en base64.
3. Cuando la transacción se confirma (horas), republica la prueba completa.

Como el `id` del snapshot compromete a `x`, y `x` al contenido, la prueba demuestra que **todos los eventos del archivo existían antes de ese bloque**. Es la respuesta a "¿y la chain?": una transacción ajena por día, sin costo, en vez de una por dato.

### Varios archivistas

Dos archivistas pueden producir hashes distintos para el mismo día porque vieron relays distintos. No es un error: los conjuntos se unen. La app y los relays que importan:

- prefieren snapshots de llaves con rol `archiver`;
- si hay varios `x` para un día, descargan todos los que puedan y unen por `id`;
- muestran cuántos archivistas independientes coinciden en el mismo `x` como indicador de salud.

### Verificación al consumir

| ID | Regla |
|---|---|
| SNAP-6 | Tras descargar: comprobar sha256 del archivo, descomprimir, comprobar `x`, y verificar `id` y `sig` de **cada** evento. Un evento inválido se descarta y se reporta; no invalida el resto. |
| SNAP-7 | La verificación del sello OTS es opcional en la app y obligatoria en la CLI del archivista con `--verify`. |

### Dónde corre el archivista y quién siembra

- CLI: `archiver snapshot --city mx-gdl --day 2026-10-09 --publish`.
- Puede correr gratis en un cron de GitHub Actions que además sube el archivo a un almacenamiento HTTP (GitHub Releases, R2) usado como web seed.
- Siembra de larga duración: cualquier cliente BitTorrent o nodo IPFS en casa, universidades, bibliotecas, los propios operadores de relay.
- DIST-5: La app PUEDE ofrecer "ayudar a conservar los datos": con consentimiento explícito, siembra por WebTorrent los snapshots que ya descargó mientras la pestaña esté abierta.

### Archivo de adjuntos (opcional)

Las fotos de los reportes viven fuera de los eventos y pueden desaparecer si su operador las borra o cierra. Un archivista PUEDE conservarlas, pero **no está obligado**, y nunca van dentro del snapshot de eventos. La razón: los adjuntos son la única parte del sistema que se puede retirar (rostros, matrículas, contenido ilegal), y meterlos en un torrent permanente quitaría esa posibilidad y haría responsable de su distribución a cada seeder.

| ID | Regla |
|---|---|
| SNAP-10 | El archivo de adjuntos es un torrent **separado** del de eventos, mensual: `sc_<city>_<YYYY-MM>_blobs.tar`, con cada archivo nombrado por su sha256. Quien siembra eventos no queda obligado a sembrar adjuntos. |
| SNAP-11 | Se genera como mínimo 30 días después de terminar el mes, para dar tiempo a la moderación. |
| SNAP-12 | Excluye los adjuntos de eventos con solicitud de borrado (kind 5), de eventos o autores `flagged` (`04`), y los que ya no se puedan descargar o cuyo hash no coincida. |
| SNAP-13 | Se anuncia con un evento `snapshot` con tag `["t", "attachments"]`, `format: "tar"` y un campo `blobs` con el número de archivos. El `x` es el sha256 del `.tar`. |
| SNAP-14 | El archivista que publica adjuntos DEBE dar un contacto para solicitudes de retiro y, ante una válida, deja de sembrar ese archivo y publica uno nuevo sin el adjunto. No puede retirar las copias de terceros: por eso existen SNAP-11 y SNAP-12. |
| SNAP-15 | El SDK, cuando las `urls` de un adjunto fallan, PUEDE buscarlo por su hash en los archivos de adjuntos del mes correspondiente. |

Un reporte cuyo adjunto ya no existe en ningún lado sigue siendo válido: la app muestra el reporte e indica que la imagen no está disponible.

### Consulta de historial en la app

Para rangos fuera de la retención de los relays, el SDK (`sc.archive.read`) localiza los `snapshot` del rango, descarga por URL/gateway/WebTorrent, verifica y filtra en un Web Worker. Los archivos verificados se guardan en caché local (Cache Storage u OPFS).

Optimización futura (`10`, Q-4): publicar además agregados columnares (Parquet) por dataset para no descargar todo un día cuando solo interesa una serie.

## Teselas del mapa

El mapa base de cada ciudad es un archivo PMTiles (extracto de OpenStreetMap), referido desde `city.tiles` con hash, CID, magnet y URLs. MapLibre lo lee con peticiones de rango HTTP desde cualquier espejo o gateway, o completo desde una copia local. Así el mapa tampoco depende de un servidor de teselas.
